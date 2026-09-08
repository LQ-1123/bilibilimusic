"""导入流水线（纯在线版）：解析 → 取信息 → 入库（不下载音频/封面）。

每个导入任务是一个 asyncio 任务，进度实时写 import_tasks 表。
播放走 /api/stream/{bvid} 实时流代理；封面直接用 B 站 CDN 地址。
"""

import asyncio
import logging
import re
import random
import uuid

from sqlmodel import select

from app import events
from app.bili.client import BiliApiError, BiliClient
from app.core.link_parser import resolve_share_text
from app.db.models import Album, ImportTask, Song
from app.db.session import context_mid, new_session
from app.services import library, playlists

# 懒物化阈值：超过该分 P 数的专辑先只建起始分 P，其余由前端 materialize 按需补齐
_ALBUM_LAZY_PAGES = 300
_PART_NOISE_RE = re.compile(
    r"^\s*(?:第?\s*\d{1,4}\s*[集话回期部]\s*[·.:：、_-]*\s*|\d{1,3}\s*[.·、_-]\s*)"
)


def part_display_title(main: str, part: str) -> str:
    """分 P 展示标题：去掉「01.」「第3集」等序号噪声；分 P 名已含主标题信息时不再拼接。"""
    part = (part or "").strip()
    cleaned = _PART_NOISE_RE.sub("", part).strip() or part
    main_compact = re.sub(r"\s+", "", main or "")
    part_compact = re.sub(r"\s+", "", cleaned)
    if not part_compact or main_compact in part_compact:
        return cleaned or main
    if part_compact in main_compact:
        return main
    return f"{main} · {cleaned}"
from app.storage.files import FileStore

_ACTIVE_STATUSES = ("pending", "resolving", "downloading")

log = logging.getLogger(__name__)


class ImportService:
    def __init__(
        self, bili: BiliClient, files: FileStore, concurrency: int = 4,
        lyrics=None,
    ) -> None:
        self.bili = bili
        self.files = files  # 仅存量清理用（迁移删本地文件）
        self.lyrics = lyrics  # LyricsService，可空（导入完成后尽力抓歌词）
        self._sem = asyncio.Semaphore(concurrency)
        self._tasks: dict[str, asyncio.Task] = {}
        self._prefav: dict[str, int] = {}  # bvid → 已在的曲库夹（同步拉取用，免重复收藏）
        self._task_playlist: dict[str, int] = {}  # 任务 → 目标歌单

    # ---- 对外接口 ----

    def submit(self, raw_text: str, playlist_id: int = 0) -> ImportTask:
        task = ImportTask(
            id=uuid.uuid4().hex[:12],
            source_url=raw_text.strip()[:500],
            status="pending",
        )
        with new_session() as session:
            session.add(task)
            session.commit()
            session.refresh(task)
        if playlist_id:
            self._task_playlist[task.id] = playlist_id
        self._tasks[task.id] = asyncio.create_task(self._run(task.id))
        return task

    def submit_bvid(self, bvid: str, fav_folder_id: int = 0, playlist_id: int = 0) -> ImportTask:
        """已知 BV 号的提交（收藏夹批量导入/同步拉取用）：解析走裸 BV 快速路径，零额外请求。

        fav_folder_id>0 表示该视频已在收藏夹里（同步拉取场景），入库后不再重复收藏。
        """
        if fav_folder_id:
            self._prefav[bvid] = fav_folder_id
        return self.submit(bvid, playlist_id=playlist_id)

    async def shutdown(self) -> None:
        for t in self._tasks.values():
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    def has_active(self) -> bool:
        return bool(self._tasks)

    def recover_stale(self) -> None:
        """启动时把上次异常退出遗留的进行中任务标记为失败。"""
        with new_session() as session:
            rows = session.exec(
                select(ImportTask).where(ImportTask.status.in_(_ACTIVE_STATUSES))  # type: ignore[attr-defined]
            ).all()
            for row in rows:
                row.status = "failed"
                row.error = "服务重启导致任务中断，请重新导入"
                session.add(row)
            session.commit()

    # ---- 内部流程 ----

    def _update(self, task_id: str, **fields) -> None:
        with new_session() as session:
            row = session.get(ImportTask, task_id)
            if row is None:
                return
            for k, v in fields.items():
                setattr(row, k, v)
            session.add(row)
            session.commit()

    async def _run(self, task_id: str) -> None:
        async with self._sem:
            try:
                await self._process(task_id)
            except asyncio.CancelledError:
                self._update(task_id, status="failed", error="任务已取消")
            except BiliApiError as exc:
                self._update(task_id, status="failed", error=exc.message)
            except Exception as exc:  # noqa: BLE001  统一兜底，错误文案进任务表
                self._update(task_id, status="failed", error=str(exc) or repr(exc))
            finally:
                self._tasks.pop(task_id, None)

    async def _process(self, task_id: str) -> None:
        with new_session() as session:
            task = session.get(ImportTask, task_id)
            if task is None:
                return
            raw_text = task.source_url

        self._update(task_id, status="resolving", progress=5)
        ref = await resolve_share_text(self.bili.http, raw_text)

        info = await self.bili.get_video_info(ref)

        # 已入库直接复用
        with new_session() as session:
            existing = session.exec(select(Song).where(Song.bvid == info.bvid, Song.cid == info.cid)).first()
            existing_id = existing.id if existing else None
        if existing_id:
            self._update(task_id, status="ready", progress=100, song_id=existing_id,
                         error=None)
            return

        self._update(task_id, status="resolving", progress=40)

        title = info.title
        if info.page > 1 or (info.part_title and info.part_title not in ("", info.title)):
            suffix = info.part_title or f"P{info.page}"
            title = f"{info.title} · {suffix}"

        playlist_id = self._task_playlist.pop(task_id, 0)
        if not playlist_id:
            playlist_id = playlists.ensure_default().id or 0

        is_album = ref.page == 1 and len(info.pages) > 1
        lazy_pages = is_album and len(info.pages) > _ALBUM_LAZY_PAGES
        album = Album(kind="paged", source_bvid=info.bvid, title=info.title,
                      artist=info.artist, cover_url=info.cover_url,
                      total_pages=len(info.pages),
                      materialized_pages=1 if lazy_pages else len(info.pages)) if is_album else None
        song = Song(
            bvid=info.bvid,
            aid=info.avid,
            cid=info.cid,
            title=title,
            artist=info.artist,
            duration=info.duration,
            quality_id=0,  # 在线流：播放时现选最高音质，标签统一显示"在线"
            audio_path="",  # 纯在线：无本地文件
            cover_path=info.cover_url or "",  # 直接存 B 站 CDN 封面地址
            cover_color="",
            source_url=raw_text,
            playlist_id=playlist_id,
            album_id=0,
            track_no=info.page,
        )
        with new_session() as session:
            try:
                if album is not None:
                    session.add(album)
                    session.flush()
                    song.album_id = album.id or 0
                session.add(song)
                session.commit()
                session.refresh(song)
                song_id = song.id
                if album is not None and not lazy_pages:
                    for index, page in enumerate(info.pages, start=1):
                        if page.cid == info.cid:
                            continue
                        child = Song(bvid=info.bvid, aid=info.avid, cid=page.cid,
                                     title=part_display_title(info.title, page.part),
                                     artist=info.artist,
                                     duration=page.duration, audio_path="", cover_path=info.cover_url,
                                     source_url=raw_text, playlist_id=playlist_id,
                                     album_id=album.id or 0, track_no=index)
                        session.add(child)
                    session.commit()
            except Exception:  # noqa: BLE001  并发导入同一 bvid：复用已入库的那条
                session.rollback()
                existing = library.get_by_bvid(info.bvid)
                song_id = existing.id if existing else None
                if song_id is None:
                    raise
        if song_id is None:
            self._update(task_id, status="failed", error="入库冲突，请重试")
            return
        song = library.get_song(song_id) or song  # 会话已关闭：换库里加载的干净实例
        self._update(task_id, status="ready", progress=100, song_id=song_id)
        events.publish(context_mid(), "libraryChanged")  # SSE：前端免刷新即见

        # 入库即收藏进歌单对应的收藏夹（bilimusic- <歌单名>）：尽力而为，失败不影响曲库状态。
        # 同步拉取的歌已在夹内（_prefav），只记录夹 id 不重复收藏。
        prefav = self._prefav.pop(info.bvid, 0)
        try:
            if prefav:
                library.update_fav_folder(song.id, prefav)
            else:
                await asyncio.sleep(random.uniform(0.3, 0.8))
                await self._favorite(song)
        except Exception as exc:  # noqa: BLE001
            log.warning("自动收藏失败 %s: %s", info.bvid, exc)

        # 歌词抓取（B站字幕 + LRCLIB），尽力而为不阻塞任务完成
        if self.lyrics is not None:
            try:
                await self.lyrics.ensure_for_song(song.id)
            except Exception as exc:  # noqa: BLE001
                log.warning("歌词抓取失败 %s: %s", info.bvid, exc)

    async def _favorite(self, song: Song) -> None:
        """把歌收藏进其歌单对应的收藏夹（满则溢出建夹），并记录夹 id。"""
        p = playlists.get_playlist(song.playlist_id) or playlists.ensure_default()
        if song.playlist_id != (p.id or 0):
            library.update_playlist(song.id, p.id or 0)
        ids = playlists.folder_ids(p)
        if ids:
            folder_id = await self.bili.favorite_into(
                song.aid, ids, playlists.next_title_maker(p.name)
            )
        else:
            folder_id = await self.bili.favorite_song(song.aid)  # 默认夹池（含收养）
        library.update_fav_folder(song.id, folder_id)

    # ---- 查询（API 用） ----

    @staticmethod
    def get_task(task_id: str) -> ImportTask | None:
        with new_session() as session:
            return session.get(ImportTask, task_id)

    @staticmethod
    def recent_tasks(limit: int = 20) -> list[ImportTask]:
        with new_session() as session:
            rows = session.exec(
                select(ImportTask).order_by(ImportTask.created_at.desc()).limit(limit)
            ).all()
            return list(rows)

    @staticmethod
    def delete_task(task_id: str) -> None:
        with new_session() as session:
            row = session.get(ImportTask, task_id)
            if row:
                session.delete(row)
                session.commit()
