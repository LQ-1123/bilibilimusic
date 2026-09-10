"""FastAPI 应用入口。

启动：.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
（或 python -m app.main）
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlmodel import select

from app.api.routes import auth_router, router as api_router
from app.bili.client import BiliClient
from app.config import settings
from app.core.cookies import CookieStore
from app.db.session import init_db, new_session
from app.services.accounts import AccountService
from app.storage.files import FileStore
from app.web.routes import router as web_router

_STATIC_DIR = Path(os.environ.get("BM_WEB_DIR", Path(__file__).parent / "web")) / "static"
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.db import session as dbs

    init_db()
    mid = dbs.load_active_account()
    cookie_path = dbs.account_cookie_path(mid) if mid else settings.cookie_path
    saved = CookieStore(cookie_path)
    guest = CookieStore()
    guest.set_many({key: value for key, value in saved.all().items() if key in ("buvid3", "buvid4")})
    bili = BiliClient(guest)
    await bili.ensure_fingerprint()
    if not saved.has_fingerprint:
        saved.set_many(guest.all())
    files = FileStore(settings.music_dir, settings.cover_dir)
    accounts = AccountService(app, bili, files)
    app.state.accounts = accounts
    claimed = settings.db_path.with_name(settings.db_path.name + ".claimed")
    # 已迁移后的 legacy cookie 只是历史备份，不能在退出后用它恢复另一个账号。
    if saved.logged_in and (mid is not None or not claimed.exists()):
        # #46：启动时到 B 站的一次网络抖动不该让用户「被登出」——网络类错误重试两次再放弃
        # （凭据本身失效属于 BiliApiError，不重试，直接按需重新登录）。
        for attempt in range(3):
            candidate_store = CookieStore()
            candidate_store.set_many(saved.all())
            candidate = BiliClient(candidate_store)
            try:
                await accounts.activate(
                    candidate, inherit_legacy=mid is None,
                    expected_mid=mid or saved.get("mid"),
                )
                break
            except Exception as exc:
                await candidate.aclose()
                network_ish = isinstance(exc, (httpx.HTTPError, OSError, ConnectionError))
                if network_ish and attempt < 2:
                    delay = 1.5 * (attempt + 1)
                    log.warning(
                        "恢复登录时连不上 B 站（%s），%.1fs 后重试（第 %d 次）",
                        type(exc).__name__, delay, attempt + 1,
                    )
                    await asyncio.sleep(delay)
                    continue
                log.warning("恢复登录失败，需重新登录（%s）", type(exc).__name__)
                dbs.reset_to_pending(clear_marker=False)
                break
    else:
        dbs.reset_to_pending()
    runtime = accounts.current
    if runtime.mid is not None:
        runtime.spawn(_migrate_to_streaming(runtime.bili, files))
    try:
        yield
    finally:
        await accounts.aclose()


async def _migrate_to_streaming(bili: BiliClient, files: FileStore) -> None:
    """一次性迁移：存量「本地文件」歌曲转纯在线——拉 B 站封面地址、清 audio_path、删本地文件。

    失败的歌保留原状下次启动再试（有 audio_path 即视为未迁移）。
    """
    from app.bili.client import VideoRef
    from app.db.models import Song

    with new_session() as session:
        pending = list(
            session.exec(
                select(Song).where(Song.audio_path != "").limit(50)  # type: ignore[attr-defined]
            ).all()
        )
    for song in pending:
        try:
            info = await bili.get_video_info(VideoRef(bvid=song.bvid))
            cover_url = info.cover_url or ""
        except Exception:  # noqa: BLE001  视频可能下架：保留本地文件兜底
            continue
        with new_session() as session:
            row = session.get(Song, song.id)
            if row is None:
                continue
            old_audio, old_cover = row.audio_path, row.cover_path
            row.audio_path = ""
            row.cover_path = cover_url or row.cover_path
            row.cover_color = ""
            session.add(row)
            session.commit()
        if old_audio:
            files.delete_song_files(old_audio, old_cover if (old_cover or "").startswith(("/", ".")) else "")


app = FastAPI(title="BiliMusic Backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def static_no_cache(request, call_next):
    """固定本次请求的客户端与数据库，随后处理静态资源缓存。"""
    from app.db.session import account_scope

    accounts = request.app.state.accounts
    runtime = accounts.current
    request.state.account = runtime
    request.state.account_generation = accounts.generation
    for name in ("mid", "bili", "cookies", "files", "lyrics", "importer", "exporter", "syncer"):
        setattr(request.state, name, getattr(runtime, name))
    with account_scope(runtime.mid):
        response = await call_next(request)
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    elif request.url.path.startswith("/api/stream"):
        pass  # 音频流走 Range 语义，禁缓存头会阻碍 WebView 渐进缓冲
    elif request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"  # 曲库/收藏状态必须实时，杜绝中间缓存
    return response


app.include_router(api_router)
app.include_router(auth_router)
app.include_router(web_router)
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)
