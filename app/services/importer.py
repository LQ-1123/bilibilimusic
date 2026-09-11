"""导入流水线（纯在线版）：解析 → 取信息 → 入库（不下载音频/封面）。

每个导入任务是一个 asyncio 任务，进度实时写 import_tasks 表。
播放走 /api/stream/{bvid} 实时流代理；封面直接用 B 站 CDN 地址。

v0.5.0：新增「系列容器」导入（kind=series，source_bvid=sid:<id>）——
B 站跨视频合集（collectiondetail?sid=）拉清单后逐视频入库，多 P 视频
复用 paged 语义展开；子作品一律 collected=False，星标才收藏。
"""

import asyncio
import logging
import random
import uuid

import httpx
from sqlmodel import select

from app import events
from app.bili.client import BiliApiError, BiliClient, VideoRef
from app.core.link_parser import resolve_share_text
from app.db.models import Album, ImportTask, Song
from app.db.session import context_mid, new_session
from app.services import library, playlists
from app.services.titles import part_display_title

# 懒物化阈值：超过该分 P 数的专辑先只建起始分 P，其余由前端 materialize 按需补齐
_ALBUM_LAZY_PAGES = 300
# 系列导入频控：分页间隔 / 逐视频 view 间隔（秒），以及单系列安全上限
_SERIES_PAGE_GAP = (0.6, 1.2)
_SERIES_VIDEO_GAP = (0.35, 0.9)
_SERIES_UNFAV_GAP = (0.4, 0.8)
_SERIES_VIDEO_CAP = 1000
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

    def submit_series(self, sid: int, mid: int = 0, playlist_id: int = 0, raw_text: str = "") -> ImportTask:
        """系列（合集）容器导入：后台逐视频拉取入库，进度按视频数推进。"""
        if not mid:
            raise ValueError("系列链接缺少 UP 主信息，无法导入")
        task = ImportTask(
            id=uuid.uuid4().hex[:12],
            source_url=(raw_text.strip() or f"https://space.bilibili.com/{mid}/channel/collectiondetail?sid={sid}")[:500],
            status="pending",
        )
        with new_session() as session:
            session.add(task)
            session.commit()
            session.refresh(task)
        if playlist_id:
            self._task_playlist[task.id] = playlist_id
        self._tasks[task.id] = asyncio.create_task(
            self._run(task.id, self._process_series(task.id, sid, mid))
        )
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

    async def _run(self, task_id: str, job=None) -> None:
        async with self._sem:
            try:
                await (job if job is not None else self._process(task_id))
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
            title = part_display_title(info.title, info.part_title or f"P{info.page}")

        playlist_id = self._task_playlist.pop(task_id, 0)
        if not playlist_id:
            playlist_id = playlists.ensure_default().id or 0

        is_album = ref.page == 1 and len(info.pages) > 1
        lazy_pages = is_album and len(info.pages) > _ALBUM_LAZY_PAGES
        existing_album = library.get_album_by_source(info.bvid) if is_album else None
        album = (
            Album(kind="paged", source_bvid=info.bvid, title=info.title,
                  artist=info.artist, cover_url=info.cover_url,
                  total_pages=len(info.pages),
                  materialized_pages=1 if lazy_pages else len(info.pages))
            if is_album and existing_album is None
            else None
        )
        # #37：多 P「合集」的子作品默认不入曲库（collected=False、不归任何歌单），
        # 用户在合集容器里逐个收藏才置 1；单视频仍按原语义直接入库。
        # （v2.0.1 曾短暂改为「视频收藏即全行点亮」，验收时被用户否决：
        #   「多p不是让你全部星星，是收藏的才星星」——逐分 P 挑歌是刻意设计。）
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
            playlist_id=0 if is_album else playlist_id,
            album_id=0,
            track_no=info.page,
            collected=not is_album,
        )
        with new_session() as session:
            try:
                if album is not None:
                    session.add(album)
                    session.flush()
                    song.album_id = album.id or 0
                elif existing_album is not None:
                    song.album_id = existing_album.id or 0  # 容器已存在：复用，不重复建
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
                                     source_url=raw_text, playlist_id=0,
                                     album_id=album.id or 0, track_no=index, collected=False)
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

    # ---- 系列（v0.5.0）----

    async def _process_series(self, task_id: str, sid: int, mid: int) -> None:
        """系列导入：拉清单 → 建容器 → 逐视频入库（多 P 展开、幂等、频控、失败降级）。"""
        # 歌单在星标收藏时才选（#37 复用语义），导入阶段的歌单参数到此为止
        self._task_playlist.pop(task_id, None)
        source_key = f"sid:{sid}"
        self._update(task_id, status="resolving", progress=5)

        meta = await self.bili.season_meta(mid, sid)  # best-effort，拿不到不影响导入

        archives: list[dict] = []
        total = 0
        page_num = 1
        while True:
            batch, total = await self.bili.seasons_archives_list(mid, sid, page_num)
            archives.extend(batch)
            self._update(task_id, progress=5 + min(30, int(30 * len(archives) / max(total, 1))))
            if not batch or len(archives) >= total or len(archives) >= _SERIES_VIDEO_CAP:
                break
            page_num += 1
            await asyncio.sleep(random.uniform(*_SERIES_PAGE_GAP))
        if not archives:
            raise BiliApiError(-404, "系列为空、不存在或未公开（未公开系列需要先登录）")
        archives = archives[:_SERIES_VIDEO_CAP]

        # 容器幂等：已存在（断点续传/换设备重建）则续用；不存在才建
        album = library.get_album_by_source(source_key)
        if album is None:
            title = str(meta.get("name") or "").strip() or str(archives[0].get("title") or f"合集 {sid}")
            cover = str(meta.get("cover") or archives[0].get("pic") or "")
            artist = str(meta.get("up_name") or "").strip()
            album = Album(kind="series", source_bvid=source_key, title=title,
                          artist=artist, cover_url=cover, mid=mid,
                          total_pages=total or len(archives), materialized_pages=0)
            with new_session() as session:
                session.add(album)
                session.commit()
                session.refresh(album)
        elif mid and not album.mid:  # 老容器缺 mid：这次拿到了就补上（分享链接依赖它）
            with new_session() as session:
                row = session.get(Album, album.id)
                if row is not None and not row.mid:
                    row.mid = mid
                    session.add(row)
                    session.commit()
        album_id = album.id or 0

        failures: list[str] = []
        done = 0
        next_track = album.materialized_pages or 0
        for i, entry in enumerate(archives):
            bvid = str(entry.get("bvid") or "")
            try:
                info = await self.bili.get_video_info(VideoRef(bvid=bvid))
            except (BiliApiError, httpx.HTTPError) as exc:  # noqa: BLE001  单视频失败不阻塞整个系列
                failures.append(bvid)
                log.warning("系列 %s 导入视频失败 %s: %s", sid, bvid, exc)
            else:
                # 幂等 + 认领：视频已有行（上次导入未完成 / 散曲）→ 复用挂容器，
                # 收藏状态与歌单一律不动（换设备重建时与收藏夹合并）。
                # 已属于其他容器（多 P 专辑）的行不抢，避免破坏原容器完整性。
                existing = {
                    row.cid: row for row in library.rows_by_bvid(bvid)
                    if row.album_id in (0, album_id)
                }
                for index, page in enumerate(info.pages, start=1):
                    track_no = next_track + index
                    row = existing.get(page.cid)
                    if row is not None:
                        library.claim_song_to_album(
                            row.id, album_id, track_no,
                            title=part_display_title(info.title, page.part) if len(info.pages) > 1 else info.title,
                            duration=page.duration or info.duration,
                        )
                        continue
                    child = Song(
                        bvid=info.bvid, aid=info.avid, cid=page.cid,
                        title=part_display_title(info.title, page.part) if len(info.pages) > 1 else info.title,
                        artist=info.artist,
                        duration=page.duration or info.duration, audio_path="",
                        cover_path=info.cover_url or "",
                        source_url=f"https://www.bilibili.com/video/{bvid}", playlist_id=0,
                        album_id=album_id, track_no=track_no, collected=False)
                    try:
                        with new_session() as session:
                            session.add(child)
                            session.commit()
                    except Exception:  # noqa: BLE001  并发撞唯一约束：该行已在库里
                        continue
                next_track += len(info.pages)
                with new_session() as session:
                    row = session.get(Album, album_id)
                    if row is not None:
                        row.materialized_pages = (row.materialized_pages or 0) + len(info.pages)
                        session.add(row)
                        session.commit()
                done += 1
            self._update(task_id, progress=40 + int(55 * (i + 1) / len(archives)))
            if i < len(archives) - 1:
                await asyncio.sleep(random.uniform(*_SERIES_VIDEO_GAP))

        error = f"{len(failures)} 个视频导入失败（可能已下架）" if failures else None
        self._update(task_id, status="ready", progress=100, error=error)
        events.publish(context_mid(), "libraryChanged")

    async def favorite_series_song(self, song_id: int) -> None:
        """系列子作品星标收藏的 B 站侧：每视频收藏一次（视频级）。

        同视频已有收藏记录时只复用夹 id，不重复打接口；失败只记日志——
        下次对账发现 fav_folder_id=0 会自动补收藏（sync 的推送路径）。
        """
        song = library.get_song(song_id)
        if song is None or not song.aid:
            return
        sibling_folder = library.find_fav_folder_by_bvid(song.bvid)
        if sibling_folder:
            library.update_fav_folder(song.id, sibling_folder)
            return
        try:
            await self._favorite(song)
        except Exception as exc:  # noqa: BLE001
            log.warning("系列子作品收藏失败 %s: %s", song.bvid, exc)

    async def unfavorite_series_songs(
        self, songs: list[Song], *, on_defer=None
    ) -> int:
        """批量取消系列内视频的 B 站收藏（删容器/移出曲库用）。

        每视频一次、带频控；失败的回调 on_defer(bvid, aid, folder_id)
        交给 syncer 登记自愈。返回成功数。
        """
        targets: dict[str, tuple[int, int]] = {}
        for s in songs:
            # 只对「可能收藏过」的视频动手：记录过收藏位置，或已进曲库（收藏
            # 可能还在途）。纯目录行（collected=False 且无夹记录）从未收藏过。
            if s.aid and (s.fav_folder_id or s.collected):
                targets.setdefault(s.bvid, (s.aid, s.fav_folder_id))
        ok = 0
        for bvid, (aid, folder_id) in targets.items():
            try:
                if folder_id:
                    await self.bili.unfavorite_song(aid, folder_id=folder_id)
                else:
                    await self.bili.unfavorite_song(aid)
                ok += 1
            except Exception as exc:  # noqa: BLE001
                log.warning("取消收藏失败 %s: %s", bvid, exc)
                if on_defer is not None:
                    on_defer(bvid, aid, folder_id)
            await asyncio.sleep(random.uniform(*_SERIES_UNFAV_GAP))
        return ok

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
