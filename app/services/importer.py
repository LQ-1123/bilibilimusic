"""导入流水线：解析 → 取信息 → 下载封面/音频 → 入库。

每个导入任务是一个 asyncio 任务，进度实时写 import_tasks 表，
API/Web 通过轮询任务表展示。并发下载用信号量限流。
"""

import asyncio
import logging
import random
import uuid

from sqlmodel import select

from app.bili.client import BiliApiError, BiliClient
from app.bili.quality import pick_best_audio
from app.core.link_parser import resolve_share_text
from app.db.models import ImportTask, Song
from app.db.session import new_session
from app.storage.files import FileStore

_ACTIVE_STATUSES = ("pending", "resolving", "downloading")

log = logging.getLogger(__name__)


class ImportService:
    def __init__(self, bili: BiliClient, files: FileStore, concurrency: int = 4, analysis=None) -> None:
        self.bili = bili
        self.files = files
        self.analysis = analysis  # AnalysisService，可空（导入完成后触发后台分析）
        self._sem = asyncio.Semaphore(concurrency)
        self._tasks: dict[str, asyncio.Task] = {}

    # ---- 对外接口 ----

    def submit(self, raw_text: str) -> ImportTask:
        task = ImportTask(
            id=uuid.uuid4().hex[:12],
            source_url=raw_text.strip()[:500],
            status="pending",
        )
        with new_session() as session:
            session.add(task)
            session.commit()
            session.refresh(task)
        self._tasks[task.id] = asyncio.create_task(self._run(task.id))
        return task

    def submit_bvid(self, bvid: str) -> ImportTask:
        """已知 BV 号的提交（收藏夹批量导入用）：解析走裸 BV 快速路径，零额外请求。"""
        return self.submit(bvid)

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
            existing = session.exec(
                select(Song).where(Song.bvid == info.bvid)  # type: ignore[attr-defined]
            ).first()
            existing_id = existing.id if existing else None
        if existing_id:
            self._update(task_id, status="ready", progress=100, song_id=existing_id,
                         error=None)
            return

        self._update(task_id, status="downloading", progress=15)

        # 封面
        if info.cover_url:
            await self.files.download(
                self.bili.http,
                [info.cover_url],
                self.files.cover_path(info.bvid),
            )

        # 音频（选最高音质，CDN 备选地址容错）
        streams = await self.bili.get_audio_streams(info.bvid, info.cid)
        best = pick_best_audio(streams)

        last_pct = -1

        def on_progress(done: int, total: int) -> None:
            nonlocal last_pct
            if total <= 0:
                return
            pct = 20 + int(75 * min(done / total, 1.0))
            if pct >= last_pct + 5:  # 降低 DB 写频率
                last_pct = pct
                self._update(task_id, progress=min(pct, 95))

        await self.files.download(
            self.bili.http,
            self.bili.candidate_urls(best),
            self.files.audio_path(info.bvid),
            on_progress=on_progress,
        )

        title = info.title
        if info.page > 1 or (info.part_title and info.part_title not in ("", info.title)):
            suffix = info.part_title or f"P{info.page}"
            title = f"{info.title} · {suffix}"

        song = Song(
            bvid=info.bvid,
            aid=info.avid,
            cid=info.cid,
            title=title,
            artist=info.artist,
            duration=info.duration,
            quality_id=best.quality_id,
            audio_path=str(self.files.audio_path(info.bvid)),
            cover_path=str(self.files.cover_path(info.bvid)),
            source_url=raw_text,
        )
        with new_session() as session:
            session.add(song)
            session.commit()
            session.refresh(song)
            self._update(task_id, status="ready", progress=100, song_id=song.id)

        # 入库即收藏进账号专用夹「bilimusic」：尽力而为，失败不影响曲库状态
        try:
            await asyncio.sleep(random.uniform(0.3, 0.8))
            await self.bili.favorite_song(info.avid)
        except Exception as exc:  # noqa: BLE001
            log.warning("自动收藏失败 %s: %s", info.bvid, exc)

        # 后台预分析（Smart Transition），不阻塞任务完成
        if self.analysis is not None:
            try:
                self.analysis.schedule_for_song(song)
            except Exception as exc:  # noqa: BLE001
                log.warning("后台分析调度失败 %s: %s", info.bvid, exc)

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
