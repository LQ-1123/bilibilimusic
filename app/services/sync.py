"""歌单 ⇆ B 站收藏夹双向对账（账号持久化的核心）。

事实源在 B 站侧：每个歌单对应「bilimusic- <歌单名>」公开收藏夹
（默认歌单「我的曲库」对应主夹 bilimusic 及其编号溢出夹）。
- 收养：账号下未被认领的 bilimusic 系夹 → 自动建成歌单（换设备恢复歌单结构）
- 拉取：夹里有、本地没有 → 提交导入流水线（已知所在夹与歌单，不重复收藏）
- 推送：本地有、夹里没有 → 补收藏进该歌单的夹（满则溢出建夹）
- 回填：顺手补齐本地歌曲缺失的 fav_folder_id（删歌取消收藏依赖它）

触发时机：扫码登录成功、应用启动（已登录）、顶栏「同步」按钮 / POST /api/sync。
同步状态在内存（服务重启即失效），个人规模场景可接受。
"""

import asyncio
import random
import uuid
from dataclasses import dataclass, field

from app.bili.client import BiliApiError, BiliClient, FAV_FOLDER_NAME
from app.services import library, playlists
from app.services.importer import ImportService

_PUSH_INTERVAL = (1.0, 1.5)  # 补收藏频控间隔（秒）


@dataclass
class SyncState:
    id: str
    status: str = "running"  # running / done / failed
    folders: int = 0  # 收养的收藏夹总数
    adopted: int = 0  # 本次新收养的歌单夹数
    pulled: int = 0  # 从 B 站拉回导入的数量
    pushed: int = 0  # 补收藏上 B 站的数量
    backfilled: int = 0  # 回填 fav_folder_id 的数量
    error: str | None = None
    failures: list[dict] = field(default_factory=list)

    def out(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "folders": self.folders,
            "adopted": self.adopted,
            "pulled": self.pulled,
            "pushed": self.pushed,
            "backfilled": self.backfilled,
            "error": self.error,
            "failures": self.failures,
        }


class SyncService:
    def __init__(self, bili: BiliClient, importer: ImportService) -> None:
        self.bili = bili
        self.importer = importer
        self._tasks: dict[str, SyncState] = {}
        self._current: SyncState | None = None

    def get(self, sync_id: str) -> SyncState | None:
        return self._tasks.get(sync_id)

    def submit(self) -> SyncState:
        """提交同步；已有进行中的同步则直接复用（幂等）。"""
        if self._current is not None and self._current.status == "running":
            return self._current
        state = SyncState(id=uuid.uuid4().hex[:12])
        self._tasks[state.id] = state
        self._current = state
        asyncio.create_task(self._run(state))
        return state

    async def _run(self, state: SyncState) -> None:
        try:
            await self._reconcile(state)
            state.status = "done"
        except BiliApiError as exc:
            state.status, state.error = "failed", exc.message
        except Exception as exc:  # noqa: BLE001
            state.status, state.error = "failed", str(exc) or repr(exc)

    async def reconcile_quietly(self) -> None:
        """后台尽力而为的对账（登录/启动时用），异常只记日志。"""
        try:
            await self._run(self.submit())
        except Exception:  # noqa: BLE001
            pass

    async def _reconcile(self, state: SyncState) -> None:
        playlists.ensure_default()
        state.adopted = await playlists.adopt_folders(self.bili)
        folders_all = await self.bili.list_library_folders(refresh=True)
        by_id = {f["id"]: f for f in folders_all}
        state.folders = len(folders_all)

        for p in playlists.list_playlists():
            ids = playlists.folder_ids(p)
            if not ids:
                # 夹池还没建立：默认歌单懒建主夹「bilimusic」；普通歌单等待首次收藏
                if p.name != playlists.DEFAULT_NAME:
                    continue
                base = next(
                    (
                        f["id"]
                        for f in folders_all
                        if f["title"].strip().lower() == FAV_FOLDER_NAME
                    ),
                    0,
                )
                if not base:
                    base = await self.bili.create_fav_folder(FAV_FOLDER_NAME)
                    folders_all = await self.bili.list_library_folders(refresh=True)
                playlists.set_folder_ids(p.id or 0, [base])
                ids = [base]

            live = [by_id[i] for i in ids if i in by_id]
            if not live:
                continue  # 夹在 B 站侧被删：歌单保留，收藏时会被懒建

            # 夹内清单：bvid → (aid, 所在夹)
            contents: dict[str, tuple[int, int]] = {}
            for f in live:
                for v in await self.bili.get_fav_videos(f["id"], cap=2000):
                    contents.setdefault(v["bvid"], (int(v.get("aid") or 0), f["id"]))

            local = library.list_songs(limit=5000, playlist_id=p.id or 0)

            # 回填 fav_folder_id
            for s in local:
                hit = contents.get(s.bvid)
                if hit and s.fav_folder_id != hit[1]:
                    library.update_fav_folder(s.id, hit[1])
                    state.backfilled += 1

            # 拉取：夹里有、本地没有 → 导入流水线
            local_bvids = {s.bvid for s in local}
            for bvid, (aid, folder_id) in contents.items():
                if bvid not in local_bvids:
                    self.importer.submit_bvid(
                        bvid, fav_folder_id=folder_id, playlist_id=p.id or 0
                    )
                    state.pulled += 1

            # 推送：本地有、夹里没有 → 补收藏（频控，避免触发风控）
            for s in local:
                if s.bvid in contents:
                    continue
                aid = s.aid
                if not aid:
                    aid = await self.bili.bvid_to_aid(s.bvid) or 0
                    if aid:
                        library.update_aid(s.id, aid)
                if not aid:
                    state.failures.append({"bvid": s.bvid, "error": "视频可能已下架，无法收藏"})
                    continue
                try:
                    folder_id = await self.bili.favorite_into(
                        aid, ids, playlists.next_title_maker(p.name)
                    )
                    library.update_fav_folder(s.id, folder_id)
                    state.pushed += 1
                except BiliApiError as exc:
                    state.failures.append({"bvid": s.bvid, "error": exc.message})
                await asyncio.sleep(random.uniform(*_PUSH_INTERVAL))
