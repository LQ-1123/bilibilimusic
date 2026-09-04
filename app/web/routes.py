"""Web 页面路由：服务端渲染 + htmx 局部刷新。强制登录，未登录一律跳登录页。"""

from pathlib import Path

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlmodel import func, select

from app.bili.client import BiliApiError
from app.db.models import ImportTask
from app.db.session import new_session
from app.services import library
from app.services.importer import ImportService

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
router = APIRouter(include_in_schema=False)

_ACTIVE = ("pending", "resolving", "downloading")
_last_ready_count: int | None = None  # 用于检测新入库，触发前端曲库刷新


def _login_redirect(request: Request) -> RedirectResponse | None:
    if not request.app.state.cookies.logged_in:
        return RedirectResponse("/login", status_code=307)
    return None


def _fmt_duration(seconds: int) -> str:
    seconds = max(0, int(seconds or 0))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _song_ctx(s) -> dict:
    from app.api.routes import song_out

    d = song_out(s)
    return {
        "id": d["id"],
        "title": d["title"],
        "artist": d["artist"],
        "quality_label": d["qualityLabel"],
        "duration_text": _fmt_duration(d["duration"]),
        "cover_url": d["coverUrl"],
        "audio_url": d["audioUrl"],
    }


def _task_ctx(t) -> dict:
    from app.api.routes import task_out

    d = task_out(t)
    return {
        "id": d["id"],
        "status": d["status"],
        "status_label": d["statusLabel"],
        "progress": d["progress"],
        "error": d["error"],
        "song": d["song"],
        "source": d["sourceUrl"],
    }


@router.get("/", response_class=HTMLResponse)
def home(request: Request):
    gate = _login_redirect(request)
    if gate:
        return gate
    songs = [_song_ctx(s) for s in library.list_songs()]
    return templates.TemplateResponse(
        request, "library.html", {"songs": songs, "logged_in": True}
    )


@router.get("/partials/songs", response_class=HTMLResponse)
def songs_partial(request: Request, q: str = ""):
    gate = _login_redirect(request)
    if gate:
        return gate
    songs = [_song_ctx(s) for s in library.list_songs(q)]
    return templates.TemplateResponse(request, "partials/songs.html", {"songs": songs})


@router.get("/partials/tasks", response_class=HTMLResponse)
def tasks_partial(request: Request):
    gate = _login_redirect(request)
    if gate:
        return gate
    global _last_ready_count

    rows = ImportService.recent_tasks(50)
    active = [t for t in rows if t.status in _ACTIVE]
    active.reverse()  # 最早提交的排最前（与处理顺序一致）
    finished = [t for t in rows if t.status not in _ACTIVE]

    with new_session() as session:
        counts = {
            status: count
            for status, count in session.exec(
                select(ImportTask.status, func.count()).group_by(ImportTask.status)
            ).all()
        }

    # 检测到新入库时通知前端刷新曲库网格
    ready_now = counts.get("ready", 0)
    trigger = ""
    if _last_ready_count is not None and ready_now > _last_ready_count:
        trigger = "refreshSongs"
    _last_ready_count = ready_now

    tasks = [_task_ctx(t) for t in active[:10] + finished[:5]]
    resp = templates.TemplateResponse(
        request,
        "partials/tasks.html",
        {
            "tasks": tasks,
            "summary": counts,
            "active_total": len(active),
            "form_error": None,
        },
    )
    if trigger:
        resp.headers["HX-Trigger"] = trigger
    return resp


@router.post("/web/import", response_class=HTMLResponse)
async def web_import(request: Request, url: str = Form(default="")):
    gate = _login_redirect(request)
    if gate:
        return gate
    from app.services.batch import submit_any

    form_error = None
    if url.strip():
        try:
            result = await submit_any(
                request.app.state.importer, request.app.state.bili, url
            )
        except (ValueError, BiliApiError) as exc:
            form_error = str(exc)

    rows = ImportService.recent_tasks(50)
    active = [t for t in rows if t.status in _ACTIVE]
    active.reverse()
    finished = [t for t in rows if t.status not in _ACTIVE]
    resp = templates.TemplateResponse(
        request,
        "partials/tasks.html",
        {
            "tasks": [_task_ctx(t) for t in active[:10] + finished[:5]],
            "summary": None,
            "active_total": len(active),
            "form_error": form_error,
        },
    )
    resp.headers["HX-Trigger"] = "refreshSongs"
    return resp


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse(
        request, "login.html", {"logged_in": request.app.state.cookies.logged_in}
    )
