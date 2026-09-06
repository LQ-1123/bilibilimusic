"""歌单 ⇆ B 站收藏夹近实时双向对账（B 站云端为准，一切跟随 B 站）。

事实源在 B 站侧：每个歌单对应「bilimusic- <歌单名>」公开收藏夹
（默认歌单「我的曲库」对应主夹 bilimusic 及其编号溢出夹）。
- 收养：账号下未被认领的 bilimusic 系夹 → 自动建成歌单（换设备恢复歌单结构）
- 夹级删除：歌单的夹在 B 站侧全部消失 → 删除整个歌单（默认歌单兜底保留）
- 拉取：夹里有、本地没有 → 提交导入流水线（已知所在夹与歌单，不重复收藏）
- 删除：夹里消失、且本地记录过收藏位置 → B 站侧已取消收藏 → 本地整首删除
- 转移：收藏被移进另一歌单的夹 → 本地歌随收藏转移到对应歌单
- 推送：夹里没有、且从未成功收藏（fav_folder_id=0，本地刚加或转移中）→ 补收藏进该歌单的夹

「fav_folder_id 是否记录」区分两种缺失：本地加歌/转移会先清零再补收藏，
因此非零而缺席 = B 站侧变动（删），零 = 待推送（补）。单曲删除前逐首回查
收藏夹内是否真的没有，避免对账窗口期误删。

心跳：登录后常驻轮询，每 15 秒单请求比对各收藏夹条目数（夹增删与条目
增减都会变化），有变化立即全量对账；每 5 分钟兜底一次全量（捕获数量
不变的内容互换）。B 站没有变更推送接口，这是近实时的最低成本方案。
手动入口：顶栏「同步」按钮 / POST /api/sync、登录成功、应用启动。
同步状态在内存（服务重启即失效），个人规模场景可接受。
"""

import asyncio
import random
import time
import uuid
from dataclasses import dataclass, field

from app.bili.client import BiliApiError, BiliClient, FAV_FOLDER_NAME
from app.db.models import Playlist
from app.db.session import context_mid
from app import events
from app.services import library, playlists
from app.services.importer import ImportService
from app.storage.files import FileStore

_PUSH_INTERVAL = (1.0, 1.5)  # 补收藏频控间隔（秒）
_VERIFY_INTERVAL = (0.3, 0.8)  # 删除前回查收藏状态的频控间隔（秒）
_POLL_INTERVAL = 15  # 心跳间隔（秒）：单次请求比对夹数量
_DEEP_INTERVAL = 300  # 兜底全量对账间隔（秒）：捕获数量不变的内容互换
_PULL_TTL = 900  # 拉取去重窗口（秒）：导入未完成前不重复提交


@dataclass
class SyncState:
    id: str
    status: str = "running"  # running / done / failed
    folders: int = 0  # 收养的收藏夹总数
    adopted: int = 0  # 本次新收养的歌单夹数
    pulled: int = 0  # 从 B 站拉回导入的数量
    pushed: int = 0  # 补收藏上 B 站的数量
    removed: int = 0  # 因 B 站侧取消收藏而删除本地的数量
    dropped: int = 0  # 因 B 站侧删夹而删除的歌单数
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
            "removed": self.removed,
            "dropped": self.dropped,
            "backfilled": self.backfilled,
            "error": self.error,
            "failures": self.failures,
        }


class SyncService:
    def __init__(
        self, bili: BiliClient, importer: ImportService,
        files: FileStore | None = None,
    ) -> None:
        self.bili = bili
        self.importer = importer
        self.files = files
        self._tasks: dict[str, SyncState] = {}
        self._current: SyncState | None = None
        self._jobs: dict[str, asyncio.Task] = {}
        self._folder_counts: dict[int, int] = {}  # 上次全量对账时的夹 → 条目数
        self._recent_pulls: dict[str, float] = {}  # bvid → 上次提交导入的时刻

    def get(self, sync_id: str) -> SyncState | None:
        return self._tasks.get(sync_id)

    def submit(self) -> SyncState:
        """提交同步；已有进行中的同步则直接复用（幂等）。"""
        if self._current is not None and self._current.status == "running":
            return self._current
        state = SyncState(id=uuid.uuid4().hex[:12])
        self._tasks[state.id] = state
        self._current = state
        self._jobs[state.id] = asyncio.create_task(self._run(state))
        return state

    async def shutdown(self) -> None:
        jobs = list(self._jobs.values())
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
        self._jobs.clear()

    async def _run(self, state: SyncState) -> None:
        try:
            await self._reconcile(state)
            state.status = "done"
        except asyncio.CancelledError:
            state.status, state.error = "failed", "账号切换或服务关闭，同步已停止"
            raise
        except BiliApiError as exc:
            state.status, state.error = "failed", exc.message
        except Exception as exc:  # noqa: BLE001
            state.status, state.error = "failed", str(exc) or repr(exc)

    async def reconcile_quietly(self) -> None:
        """后台尽力而为的对账（登录/启动/轮询用），异常只记日志。"""
        try:
            state = self.submit()
            await self._jobs[state.id]
        except Exception:  # noqa: BLE001
            pass

    async def poll_forever(self) -> None:
        """登录后常驻心跳：单请求比对夹数量，变化或到期即全量对账。

        B 站没有变更推送，数量比对是近实时的最低成本方案（取消收藏/新增/
        删夹建夹都会改变 media_count 或夹列表）；内容互换数量不变，由兜底
        全量对账捕获。
        """
        last_deep = time.monotonic()
        while True:
            await asyncio.sleep(_POLL_INTERVAL + random.uniform(0.0, 3.0))
            try:
                if time.monotonic() - last_deep >= _DEEP_INTERVAL or await self._counts_changed():
                    await self.reconcile_quietly()
                    last_deep = time.monotonic()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001  接口抖动下轮再试
                pass

    async def _counts_changed(self) -> bool:
        folders = await self.bili.list_library_folders(refresh=True)
        return {f["id"]: f["count"] for f in folders} != self._folder_counts

    async def _reconcile(self, state: SyncState) -> None:
        playlists.ensure_default()
        state.adopted = await playlists.adopt_folders(self.bili)
        folders_all = await self.bili.list_library_folders(refresh=True)
        by_id = {f["id"]: f for f in folders_all}
        state.folders = len(folders_all)
        # 空夹列表视为接口异常（抖动/风控）：跳过删除类对齐，防止误删整库
        healthy = bool(folders_all)
        now = time.monotonic()
        self._recent_pulls = {
            b: t for b, t in self._recent_pulls.items() if now - t < _PULL_TTL
        }

        # 第一遍：各歌单夹内清单 + 跨歌单聚合（bvid → 所在夹 → 夹属歌单）。
        # 聚合先行才能正确处理「删夹」和「收藏移入另一歌单的夹」。
        plans: list[tuple[Playlist, list[int], list[dict], dict[str, tuple[int, int]]]] = []
        for p in playlists.list_playlists():
            ids = playlists.folder_ids(p)
            if not ids:
                # 夹池还没建立：默认歌单懒建主夹「bilimusic」；普通歌单等待首次收藏
                if p.name != playlists.DEFAULT_NAME:
                    plans.append((p, [], [], {}))
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
                    by_id = {f["id"]: f for f in folders_all}
                playlists.set_folder_ids(p.id or 0, [base])
                ids = [base]
            live = [by_id[i] for i in ids if i in by_id]
            contents: dict[str, tuple[int, int]] = {}
            for f in live:
                for v in await self.bili.get_fav_videos(f["id"], cap=2000):
                    contents.setdefault(v["bvid"], (int(v.get("aid") or 0), f["id"]))
            plans.append((p, ids, live, contents))

        global_at: dict[str, int] = {}  # bvid → 所在夹（任一歌单）
        folder_owner: dict[int, Playlist] = {}
        for p, _ids, live, cts in plans:
            for f in live:
                folder_owner.setdefault(f["id"], p)
            for bvid, (_aid, fid) in cts.items():
                global_at.setdefault(bvid, fid)

        all_local = {s.bvid: s for s in library.list_songs(limit=5000)}

        for p, ids, live, contents in plans:
            pid = p.id or 0
            local = [s for s in all_local.values() if s.playlist_id == pid]

            # 夹级删除：配置过夹池的歌单，夹在 B 站侧全部消失 → 删歌单随夹走。
            # 歌还在另一歌单夹里的随收藏转移过去（B 站删夹不会转移收藏，这里
            # 只处理同一视频被收藏进多个夹的存量）；默认歌单兜底保留、清空夹池。
            if healthy and ids and not live:
                for s in local:
                    fid = global_at.get(s.bvid)
                    owner = folder_owner.get(fid) if fid is not None else None
                    if owner is not None and (owner.id or 0) != pid:
                        library.update_playlist(s.id, owner.id or 0)
                        library.update_fav_folder(s.id, fid or 0)
                    elif library.delete_song(s.id, self.files):
                        state.removed += 1
                if p.name == playlists.DEFAULT_NAME:
                    playlists.set_folder_ids(pid, [])
                else:
                    playlists.remove_row(pid)
                    state.dropped += 1
                continue

            # 回填 fav_folder_id
            for s in local:
                hit = contents.get(s.bvid)
                if hit and s.fav_folder_id != hit[1]:
                    library.update_fav_folder(s.id, hit[1])
                    state.backfilled += 1

            # 拉取：夹里有、本地全库没有 → 导入流水线（轮询期间未完成的不重复提交）
            for bvid, (_aid, folder_id) in contents.items():
                if bvid in all_local:
                    continue
                if now - self._recent_pulls.get(bvid, 0.0) < _PULL_TTL:
                    continue
                self._recent_pulls[bvid] = now
                self.importer.submit_bvid(bvid, fav_folder_id=folder_id, playlist_id=pid)
                state.pulled += 1

            # 删除 / 转移 / 推送：夹里消失的歌
            for s in local:
                if s.bvid in contents:
                    continue
                fid = global_at.get(s.bvid)
                owner = folder_owner.get(fid) if fid is not None else None
                if owner is not None and (owner.id or 0) != pid:
                    # B 站侧把收藏移进了另一歌单的夹：歌随收藏转移歌单
                    library.update_playlist(s.id, owner.id or 0)
                    library.update_fav_folder(s.id, fid or 0)
                    continue
                if s.fav_folder_id and healthy:
                    # 记录过收藏位置却消失：B 站侧已取消收藏/夹被删。
                    # 夹还在时先回查单曲确认缺席（排除「对账拉清单后才收藏」的
                    # 窗口期误删，核实失败保守跳过）；夹已消失则收藏随夹没了。
                    if s.fav_folder_id in by_id:
                        await asyncio.sleep(random.uniform(*_VERIFY_INTERVAL))
                        aid = s.aid or (await self.bili.bvid_to_aid(s.bvid) or 0)
                        if not aid:
                            state.failures.append({"bvid": s.bvid, "error": "视频已下架，无法核实收藏状态，保留本地"})
                            continue
                        try:
                            if await self.bili.find_in_folder(s.fav_folder_id, aid):
                                continue
                        except BiliApiError:
                            continue  # 核实不了：本轮不删，下轮再判
                    if library.delete_song(s.id, self.files):
                        state.removed += 1
                    continue
                if not live:
                    continue  # 没有可用的夹池（接口异常/新歌单未建夹）：不推送
                # 从未收藏过（fav_folder_id=0）：本地新增/转移中 → 补收藏（频控）
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
                    if folder_id not in ids:  # 溢出/懒建的新夹记入夹池
                        ids.append(folder_id)
                        playlists.set_folder_ids(pid, ids)
                    state.pushed += 1
                except BiliApiError as exc:
                    state.failures.append({"bvid": s.bvid, "error": exc.message})
                await asyncio.sleep(random.uniform(*_PUSH_INTERVAL))

        # 全量对账后的夹数量快照：心跳据此判断 B 站侧是否有新变动
        folders_now = await self.bili.list_library_folders(refresh=True)
        self._folder_counts = {f["id"]: f["count"] for f in folders_now}
        if state.removed or state.dropped:  # SSE：B 站侧变动已落到本地，推前端刷新
            events.publish(context_mid(), "libraryChanged")
        if state.dropped:
            events.publish(context_mid(), "playlistsChanged")
