"""Web 页面路由：服务端渲染 + htmx 局部刷新。强制登录，未登录一律跳登录页。"""

import time
from pathlib import Path

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlmodel import func, select

from app.bili.client import BiliApiError
from app.core.link_parser import BV_RE, parse_video_url
from app.db.models import ImportTask
from app.db.session import new_session
from app.services import library, playlists, recs
from app.services.importer import ImportService

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
router = APIRouter(include_in_schema=False)

_ACTIVE = ("pending", "resolving", "downloading")
_last_ready_count: int | None = None  # 用于检测新入库，触发前端曲库刷新

_SEARCH_CACHE_TTL = 300  # B 站搜索风控较严：同词 5 分钟内直接复用结果
_search_cache: dict[str, tuple[float, list]] = {}


def _login_redirect(request: Request) -> RedirectResponse | None:
    if not request.app.state.cookies.logged_in:
        return RedirectResponse("/login", status_code=307)
    return None


def _fmt_duration(seconds: int) -> str:
    seconds = max(0, int(seconds or 0))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _fmt_play(n: int) -> str:
    n = max(0, int(n or 0))
    if n >= 100_000_000:
        return f"{n / 100_000_000:.1f}".rstrip("0").rstrip(".") + "亿"
    if n >= 10_000:
        return f"{n / 10_000:.1f}".rstrip("0").rstrip(".") + "万"
    return str(n)


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


# 歌单封面色相：设计侧固定调色板（默认歌单恒为 B 站粉 340）
_HUES = [340, 14, 258, 44, 192, 130, 285, 210]


def _playlist_cards() -> tuple[list[dict], int]:
    """侧栏 + 海报架共用的歌单卡片数据（含每歌单曲目数）。返回 (cards, 总曲数)。"""
    pls = playlists.list_playlists()
    all_songs = library.list_songs(limit=10000)
    counts: dict[int, int] = {}
    for s in all_songs:
        counts[s.playlist_id or 0] = counts.get(s.playlist_id or 0, 0) + 1
    cards = [{"id": 0, "name": "全部歌曲", "count": len(all_songs), "default": False, "hue": 340}]
    for i, p in enumerate(pls):
        cards.append({
            "id": p.id,
            "name": p.name,
            "count": counts.get(p.id, 0),
            "default": p.name == playlists.DEFAULT_NAME,
            "hue": _HUES[i % len(_HUES)],
        })
    return cards, len(all_songs)


@router.get("/", response_class=HTMLResponse)
def home(request: Request):
    """曲库主界面（含歌单、收藏、发现、播放）。未登录一律跳登录页。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    _, total = _playlist_cards()
    recent = [_song_ctx(s) for s in library.list_songs()[:8]]
    try:
        rec_count = len(recs.list_items())
    except Exception:
        rec_count = 0
    return templates.TemplateResponse(
        request,
        "library.html",
        {
            "playlists": playlists.list_playlists(),
            "logged_in": True,
            "recent": recent,
            "stats": {
                "songs": total,
                "playlists": len(playlists.list_playlists()),
                "recs": rec_count,
            },
        },
    )


@router.get("/library", response_class=HTMLResponse)
def library_page(request: Request):
    return RedirectResponse("/", status_code=307)


@router.get("/partials/playlists", response_class=HTMLResponse)
def playlists_partial(request: Request, mode: str = ""):
    gate = _login_redirect(request)
    if gate:
        return gate
    cards, _ = _playlist_cards()
    if mode == "rack":  # 主页海报架：只放真实歌单（不含「全部歌曲」伪卡）
        return templates.TemplateResponse(
            request, "partials/playlist_rack.html", {"cards": cards[1:]}
        )
    return templates.TemplateResponse(
        request, "partials/playlists.html", {"cards": cards}
    )


@router.post("/web/playlists/create", response_class=PlainTextResponse)
async def web_playlist_create(request: Request, name: str = Form(default="")):
    gate = _login_redirect(request)
    if gate:
        return gate
    try:
        await playlists.create(name, request.app.state.bili)
    except (ValueError, BiliApiError) as exc:
        return PlainTextResponse(str(exc), status_code=400)
    return PlainTextResponse("ok")


@router.post("/web/playlists/rename", response_class=PlainTextResponse)
async def web_playlist_rename(
    request: Request, id: int = Form(default=0), name: str = Form(default="")
):
    gate = _login_redirect(request)
    if gate:
        return gate
    try:
        await playlists.rename(id, name, request.app.state.bili)
    except (ValueError, BiliApiError) as exc:
        return PlainTextResponse(str(exc), status_code=400)
    return PlainTextResponse("ok")


@router.post("/web/playlists/delete", response_class=PlainTextResponse)
async def web_playlist_delete(request: Request, id: int = Form(default=0)):
    """删除歌单：歌曲移入默认歌单（解放），B 站收藏夹一并删除，收藏转移后台执行。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    try:
        result = await playlists.delete(id, request.app.state.bili)
    except (ValueError, BiliApiError) as exc:
        return PlainTextResponse(str(exc), status_code=400)
    return PlainTextResponse(f"ok {result['moved']}")


@router.get("/partials/songs", response_class=HTMLResponse)
def songs_partial(request: Request, q: str = "", playlist_id: int = 0):
    gate = _login_redirect(request)
    if gate:
        return gate
    pl_names = {p.id: p.name for p in playlists.list_playlists()}
    songs = []
    for s in library.list_songs(q, playlist_id=playlist_id):
        d = _song_ctx(s)
        d["pl_name"] = pl_names.get(s.playlist_id or 0, "")
        songs.append(d)
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


@router.get("/partials/rec-playlists", response_class=HTMLResponse)
def rec_playlists_partial(request: Request):
    """主页推荐歌单架：每日精选 + 各风格电台卡（线上推荐池，非用户曲库）。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    cards = [{"key": "daily", "name": "每日精选", "count": len(recs.daily_items()), "hue": 340}]
    for i, g in enumerate(recs.GENRE_KEYWORDS.keys()):
        n = len(recs.list_items(genre=g))
        if n:
            cards.append({"key": g, "name": f"{g}精选", "count": n, "hue": _HUES[(i + 1) % len(_HUES)]})
    return templates.TemplateResponse(request, "partials/rec_playlists.html", {"cards": cards})


@router.get("/partials/rec-genre-tracks", response_class=HTMLResponse)
def rec_genre_tracks_partial(request: Request, genre: str = "daily"):
    """推荐歌单详情曲目表：推荐池线上歌曲（实时流），daily = 每日精选。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    items = recs.daily_items() if genre == "daily" else recs.list_items(genre=genre)[:30]
    ctx_items = [
        {
            "bvid": i.bvid,
            "title": i.title,
            "artist": i.artist,
            "duration_text": _fmt_duration(i.duration),
            "cover_url": i.cover_url,
            "genre": i.genre,
        }
        for i in items
    ]
    return templates.TemplateResponse(
        request, "partials/rec_genre_tracks.html", {"items": ctx_items, "genre": genre}
    )


@router.get("/partials/recent", response_class=HTMLResponse)
def recent_partial(request: Request):
    """最近收藏架（refreshSongs 触发实时刷新）。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    recent = [_song_ctx(s) for s in library.list_songs()[:8]]
    return templates.TemplateResponse(request, "partials/recent_rack.html", {"recent": recent})


@router.get("/partials/web-search", response_class=HTMLResponse)
async def web_search(request: Request, q: str = ""):
    """B 站站内搜索结果（曲库搜索框联动）；导入按钮复用 /web/import 链路。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    q = (q or "").strip()
    results, error = [], None
    # 粘贴的是链接 / BV 号时不做站内搜索，交给导入框处理
    if q and not (q.lower().startswith("http") or BV_RE.search(q) or parse_video_url(q)):
        cached = _search_cache.get(q)
        if cached and time.monotonic() - cached[0] < _SEARCH_CACHE_TTL:
            results = cached[1]
        else:
            try:
                results = [
                    {
                        "bvid": h.bvid,
                        "title": h.title,
                        "artist": h.artist,
                        "duration_text": _fmt_duration(h.duration),
                        "play_text": _fmt_play(h.play),
                        "cover_url": h.cover_url,
                        "import_url": f"https://www.bilibili.com/video/{h.bvid}",
                    }
                    for h in await request.app.state.bili.search_videos(q)
                ]
                _search_cache[q] = (time.monotonic(), results)
                if len(_search_cache) > 64:  # 只留最近 32 词
                    for k in sorted(_search_cache, key=lambda k: _search_cache[k][0])[:-32]:
                        _search_cache.pop(k, None)
            except BiliApiError as exc:
                error = str(exc)
    return templates.TemplateResponse(
        request, "partials/web_search.html", {"results": results, "error": error}
    )


@router.post("/web/sync", response_class=HTMLResponse)
async def web_sync(request: Request):
    """顶栏「同步」：与 B 站夹池双向对账。拉取的歌会以导入任务形式出现在任务列表。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    request.app.state.syncer.submit()

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
            "form_error": None,
        },
    )
    resp.headers["HX-Trigger"] = "refreshSongs"
    return resp


@router.get("/partials/recs", response_class=HTMLResponse)
def recs_partial(request: Request, genre: str = "", mode: str = ""):
    """发现板块：今日推荐 / 风格分类的推荐池（纯链接，试听走实时流）。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    if mode == "today":
        items = recs.daily_items()
    else:
        items = recs.list_items(genre=genre)
    ctx_items = [
        {
            "bvid": i.bvid,
            "title": i.title,
            "artist": i.artist,
            "duration_text": _fmt_duration(i.duration),
            "cover_url": i.cover_url,
            "genre": i.genre,
        }
        for i in items
    ]
    return templates.TemplateResponse(
        request,
        "partials/recs.html",
        {"items": ctx_items, "genres": list(recs.GENRE_KEYWORDS.keys()), "mode": mode},
    )


@router.post("/web/recs/dismiss", response_class=PlainTextResponse)
def web_recs_dismiss(bvid: str = Form(default="")):
    """不感兴趣：立即出池。"""
    recs.dismiss(bvid.strip())
    return PlainTextResponse("ok")


@router.post("/web/import", response_class=HTMLResponse)
async def web_import(
    request: Request, url: str = Form(default=""), playlist_id: int = Form(default=0)
):
    gate = _login_redirect(request)
    if gate:
        return gate
    from app.services.batch import submit_any

    form_error = None
    if url.strip():
        try:
            result = await submit_any(
                request.app.state.importer, request.app.state.bili, url,
                playlist_id=playlist_id,
            )
            recs.dismiss_for_text(url)  # 从发现收藏的歌：转正出池
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
