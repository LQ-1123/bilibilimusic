"""FastAPI 应用入口。

启动：.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
（或 python -m app.main）
"""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.analysis.service import AnalysisService
from app.api.routes import auth_router, router as api_router
from app.bili.client import BiliClient
from app.config import settings
from app.core.cookies import CookieStore
from app.db.session import init_db
from app.services.exporter import ExportService
from app.services.importer import ImportService
from app.services.lyrics import LyricsService
from app.services import playlists
from app.services.sync import SyncService
from app.storage.files import FileStore
from app.web.routes import router as web_router

_STATIC_DIR = Path(__file__).parent / "web" / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    playlists.ensure_default()
    store = CookieStore(settings.cookie_path)
    bili = BiliClient(store)
    try:
        await bili.ensure_fingerprint()
    except Exception:  # noqa: BLE001  指纹初始化失败不阻塞启动
        pass
    files = FileStore(settings.music_dir, settings.cover_dir)
    files.backfill_cover_color()
    analysis = AnalysisService()
    lyrics = LyricsService(bili)
    importer = ImportService(bili, files, analysis=analysis, lyrics=lyrics)
    importer.recover_stale()
    exporter = ExportService(bili)
    syncer = SyncService(bili, importer)

    app.state.cookies = store
    app.state.bili = bili
    app.state.files = files
    app.state.importer = importer
    app.state.exporter = exporter
    app.state.analysis = analysis
    app.state.lyrics = lyrics
    app.state.syncer = syncer
    if store.logged_in:
        # 已登录则启动即对账：换机器/重新部署后这就是自动恢复
        asyncio.create_task(syncer.reconcile_quietly())
    yield
    await importer.shutdown()
    await lyrics.aclose()
    await bili.aclose()


app = FastAPI(title="BiliMusic Backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def static_no_cache(request, call_next):
    """静态资源禁用启发式缓存：浏览器每次协商复用（未变更时 304），改完刷新即生效。"""
    response = await call_next(request)
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.include_router(api_router)
app.include_router(auth_router)
app.include_router(web_router)
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)
