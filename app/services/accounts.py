"""单个服务实例的账号切换：先验证候选凭据，再发布完整的账号运行环境。"""

import asyncio
import logging
from dataclasses import dataclass, field

from app.bili.client import BiliApiError, BiliClient
from app.config import settings
from app.core.cookies import CookieStore
from app.db import session as dbs
from app.services import playlists
from app.services.exporter import ExportService
from app.services.importer import ImportService
from app.services.lyrics import LyricsService
from app.services.sync import SyncService
from app.storage.files import FileStore

log = logging.getLogger(__name__)


@dataclass
class AccountRuntime:
    mid: str | None
    bili: BiliClient
    files: FileStore
    lyrics: LyricsService
    importer: ImportService
    exporter: ExportService
    syncer: SyncService
    background: set[asyncio.Task] = field(default_factory=set)

    @property
    def cookies(self) -> CookieStore:
        return self.bili.store

    def spawn(self, coroutine) -> None:
        with dbs.account_scope(self.mid):
            task = asyncio.create_task(coroutine)
        self.background.add(task)
        task.add_done_callback(self.background.discard)

    async def aclose(self) -> None:
        # 已退役的请求可能稍后才发现凭据过期；它们不能再修改该账号的新登录文件。
        self.cookies.path = None
        tasks = list(self.background)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.syncer.shutdown()
        await self.exporter.shutdown()
        await self.importer.shutdown()
        await self.lyrics.aclose()
        await self.bili.aclose()


class AccountService:
    def __init__(self, app, bili: BiliClient, files: FileStore) -> None:
        self.app = app
        self.files = files
        self.generation = 0
        self._lock = asyncio.Lock()
        self.current = self._make_runtime(bili, None)
        self._publish(self.current)

    def _make_runtime(self, bili: BiliClient, mid: str | None) -> AccountRuntime:
        lyrics = LyricsService(bili)
        importer = ImportService(bili, self.files, lyrics=lyrics)
        return AccountRuntime(mid, bili, self.files, lyrics, importer,
                              ExportService(bili), SyncService(bili, importer, self.files))

    def _publish(self, runtime: AccountRuntime) -> None:
        # 无 await：新请求只能看到切换前或切换后的完整环境。
        self.current = runtime
        for name in ("mid", "bili", "cookies", "files", "lyrics", "importer", "exporter", "syncer"):
            setattr(self.app.state, name, getattr(runtime, name))

    def login_client(self) -> BiliClient:
        store = CookieStore()  # 临时登录不写当前账号的 cookies.json
        store.set_many({key: value for key, value in self.current.cookies.all().items()
                        if key in ("buvid3", "buvid4")})
        return BiliClient(store)

    @staticmethod
    def _clear_legacy_login() -> None:
        if settings.cookie_path.exists():
            CookieStore(settings.cookie_path).clear_login()

    async def activate(
        self, bili: BiliClient, *, generation: int | None = None,
        inherit_legacy: bool = False, expected_mid: str | None = None,
    ) -> AccountRuntime:
        info = await bili.verify_login()
        mid = str(info["mid"])
        if expected_mid is not None and mid != expected_mid:
            raise BiliApiError(-101, "保存的登录凭据与账号目录不一致，请重新登录")
        async with self._lock:
            if generation is not None and generation != self.generation:
                raise BiliApiError(-101, "账号状态已变更，请重新登录")
            account_dir = dbs.prepare_account(mid, inherit_legacy=inherit_legacy)
            runtime = self._make_runtime(bili, mid)
            try:
                with dbs.account_scope(mid):
                    playlists.ensure_default()
                    runtime.importer.recover_stale()
                bili.store.repath(account_dir / "cookies.json")
                dbs.activate_account(mid)
            except Exception:
                await runtime.aclose()
                raise
            previous = self.current
            self._publish(runtime)
            self.generation += 1
            try:
                self._clear_legacy_login()
            except OSError:
                log.warning("清理旧版登录备份失败")
            runtime.spawn(runtime.syncer.reconcile_quietly())
            runtime.spawn(runtime.syncer.poll_forever())  # 常驻近实时轮询
        await previous.aclose()
        return runtime

    async def logout(self) -> None:
        async with self._lock:
            previous = self.current
            previous.bili.logout()
            self._clear_legacy_login()
            dbs.reset_to_pending()
            self._publish(self._make_runtime(self.login_client(), None))
            self.generation += 1
        await previous.aclose()

    async def aclose(self) -> None:
        await self.current.aclose()
