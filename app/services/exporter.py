"""导出 = 曲库向账号收藏夹池（bilimusic 系公开夹）的同步与分享链接。

入库时已自动收藏（见 importer），导出通常只需：确保夹池存在 →
比对缺失歌曲并补收藏（自动选未满的夹）→ 生成首夹的
`space.bilibili.com/{mid}/favlist?fid=xxx`。
导出任务状态保存在内存（服务重启即失效），个人规模场景可接受。
"""

import asyncio
import random
import uuid
from dataclasses import dataclass, field

from app.bili.client import BiliApiError, BiliClient
from app.services import library

# 补收藏频控间隔（秒）
_SYNC_INTERVAL = (1.0, 1.5)


@dataclass
class ExportState:
    id: str
    status: str = "pending"  # pending / syncing / done / failed
    total: int = 0  # 本次需补收藏的数量
    done: int = 0
    folder_title: str = "bilimusic"
    link: str | None = None
    error: str | None = None
    failures: list[dict] = field(default_factory=list)

    def out(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "total": self.total,
            "done": self.done,
            "folderTitle": self.folder_title,
            "link": self.link,
            "error": self.error,
            "failures": self.failures,
        }


class ExportService:
    def __init__(self, bili: BiliClient) -> None:
        self.bili = bili
        self._tasks: dict[str, ExportState] = {}
        self._jobs: set[asyncio.Task] = set()
        self._single = asyncio.Lock()  # 同一时间只允许一个导出任务

    def get(self, export_id: str) -> ExportState | None:
        return self._tasks.get(export_id)

    def submit(self) -> ExportState:
        if not self.bili.store.logged_in:
            raise ValueError("请先在「账号」页扫码登录 B 站再导出")
        state = ExportState(id=uuid.uuid4().hex[:12])
        self._tasks[state.id] = state
        job = asyncio.create_task(self._run(state))
        self._jobs.add(job)
        job.add_done_callback(self._jobs.discard)
        return state

    async def shutdown(self) -> None:
        jobs = list(self._jobs)
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)

    async def _run(self, state: ExportState) -> None:
        try:
            async with self._single:
                await self._export(state)
        except asyncio.CancelledError:
            state.status, state.error = "failed", "账号切换或服务关闭，导出已停止"
            raise
        except BiliApiError as exc:
            state.status = "failed"
            state.error = exc.message
        except Exception as exc:  # noqa: BLE001
            state.status = "failed"
            state.error = str(exc) or repr(exc)

    async def _export(self, state: ExportState) -> None:
        state.status = "syncing"
        from app.services import playlists

        await playlists.adopt_folders(self.bili)
        main_id = await self.bili.ensure_fav_folder()
        mid = int(self.bili.store.get("mid") or await self.bili.get_my_mid())
        # 分享链接指向主夹；跨歌单完整恢复请用「同步」
        state.link = f"https://space.bilibili.com/{mid}/favlist?fid={main_id}"

        # 按歌单比对差异（收藏失败/登录前收藏的歌在这里补上）
        folders_by_id = {f["id"]: f for f in await self.bili.list_library_folders(refresh=True)}
        jobs = []
        for p in playlists.list_playlists():
            ids = [i for i in playlists.folder_ids(p) if i in folders_by_id]
            if not ids:
                continue
            in_folders: set[str] = set()
            for i in ids:
                in_folders |= {
                    v["bvid"] for v in await self.bili.get_fav_videos(i, cap=2000)
                }
            missing = [
                s
                for s in library.list_songs(limit=5000, playlist_id=p.id or 0)
                if s.bvid not in in_folders
            ]
            if missing:
                jobs.append((p, ids, missing))
        state.total = sum(len(m) for _, _, m in jobs)
        if not state.total:
            state.status = "done"
            return

        for p, ids, missing in jobs:
            for song in missing:
                aid = song.aid
                if not aid:
                    aid = await self.bili.bvid_to_aid(song.bvid) or 0
                    if aid:
                        library.update_aid(song.id, aid)
                if not aid:
                    state.failures.append({"bvid": song.bvid, "error": "视频可能已下架，无法获取 id"})
                    state.done += 1
                    continue
                try:
                    folder_id = await self.bili.favorite_into(
                        aid, ids, playlists.next_title_maker(p.name)
                    )
                    library.update_fav_folder(song.id, folder_id)
                except BiliApiError as exc:
                    state.failures.append({"bvid": song.bvid, "error": exc.message})
                state.done += 1
                await asyncio.sleep(random.uniform(*_SYNC_INTERVAL))

        if state.failures and len(state.failures) == state.total:
            state.status = "failed"
            state.error = "全部歌曲补收藏失败（查看失败明细）"
            return
        state.status = "done"
