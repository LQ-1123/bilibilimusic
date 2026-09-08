"""Web 页面路由：服务端渲染 + htmx 局部刷新。强制登录，未登录一律跳登录页。"""

import asyncio
import math
import os
import time
from pathlib import Path

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlmodel import func, select

from app.bili.client import BiliApiError, https_media_url
from app.core.link_parser import BV_RE, parse_video_url
from app.core.url_guard import validate_bilibili_url
from app.db.models import Album, ImportTask, Song
from app.db.session import new_session
from app.services import library, playlists, recs, zone
from app.services.importer import ImportService

templates = Jinja2Templates(directory=str(Path(os.environ.get("BM_WEB_DIR", Path(__file__).parent)) / "templates"))
router = APIRouter(include_in_schema=False)

_ACTIVE = ("pending", "resolving", "downloading")
_last_ready_count: int | None = None  # 用于检测新入库，触发前端曲库刷新

_SEARCH_CACHE_TTL = 300  # B 站搜索风控较严：同词 5 分钟内直接复用结果
_search_cache: dict[str, tuple[float, list]] = {}


def _login_redirect(request: Request):
    """未登录拦截：htmx/局部请求返回 401（前端全局监听后弹登录弹窗），整页导航跳 /?login=1。"""
    if request.state.cookies.logged_in:
        return None
    if request.headers.get("hx-request") == "true":
        return JSONResponse({"detail": "需要先扫码登录 B 站账号"}, status_code=401)
    return RedirectResponse("/?login=1", status_code=307)


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
        "bvid": d["bvid"],
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
    """侧栏 + 海报架共用的歌单卡片数据（含每歌单曲目数 + 最新封面）。返回 (cards, 总曲数)。"""
    from app.api.routes import song_out

    pls = playlists.list_playlists()
    all_songs = library.list_songs(limit=10000)
    counts: dict[int, int] = {}
    covers: dict[int, str] = {}  # 每歌单最新一首的封面（list_songs 新歌在前）
    newest_cover = ""
    for s in all_songs:
        pid = s.playlist_id or 0
        counts[pid] = counts.get(pid, 0) + 1
        if pid not in covers:
            url = song_out(s)["coverUrl"]
            if url:
                covers[pid] = url
                if not newest_cover:
                    newest_cover = url
    cards = [{
        "id": 0, "name": "全部歌曲", "count": len(all_songs), "default": False, "hue": 340,
        "cover": covers.get(0, newest_cover),
    }]
    for i, p in enumerate(pls):
        cards.append({
            "id": p.id,
            "name": p.name,
            "count": counts.get(p.id, 0),
            "default": p.name == playlists.DEFAULT_NAME,
            "hue": _HUES[i % len(_HUES)],
            "cover": covers.get(p.id, ""),
        })
    return cards, len(all_songs)


@router.get("/", response_class=HTMLResponse)
async def home(request: Request):
    """曲库主界面（含歌单、收藏、发现、播放）。未登录也渲染骨架，操作时前端弹登录弹窗。"""
    if not request.state.cookies.logged_in:
        return templates.TemplateResponse(
            request,
            "library.html",
            {
                "playlists": [],
                "logged_in": False,
                "recent": [],
                "user": {"uname": "", "face": ""},
                "stats": {"songs": 0, "playlists": 0, "recs": 0},
            },
        )
    _, total = _playlist_cards()
    recent = [_song_ctx(s) for s in library.list_songs()[:8]]
    try:
        rec_count = len(recs.list_items())
    except Exception:
        rec_count = 0
    me = await request.state.bili.my_info()
    user = {"uname": str(me.get("uname") or "已登录"), "face": https_media_url(str(me.get("face") or ""))}
    return templates.TemplateResponse(
        request,
        "library.html",
        {
            "playlists": playlists.list_playlists(),
            "logged_in": True,
            "mid": request.state.mid or "",
            "recent": recent,
            "user": user,
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
        await playlists.create(name, request.state.bili)
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
        await playlists.rename(id, name, request.state.bili)
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
        result = await playlists.delete(id, request.state.bili)
    except (ValueError, BiliApiError) as exc:
        return PlainTextResponse(str(exc), status_code=400)
    return PlainTextResponse(f"ok {result['moved']}")


@router.post("/web/playlists/add-song", response_class=PlainTextResponse)
async def web_playlist_add_song(
    request: Request, song_id: int = Form(default=0), playlist_id: int = Form(default=0)
):
    """把曲库内已有歌曲加入歌单（playlist_id=0 → 默认歌单），同步 B 站收藏转移。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    try:
        await playlists.add_song(playlist_id, song_id, request.state.bili)
    except (ValueError, BiliApiError) as exc:
        return PlainTextResponse(str(exc), status_code=400)
    return PlainTextResponse("ok")


@router.get("/partials/songs", response_class=HTMLResponse)
def songs_partial(request: Request, q: str = "", playlist_id: int = 0, artist: str = ""):
    gate = _login_redirect(request)
    if gate:
        return gate
    pl_names = {p.id: p.name for p in playlists.list_playlists()}
    songs = []
    for s in library.list_songs(q, playlist_id=playlist_id):
        if artist and s.artist != artist:
            continue
        d = _song_ctx(s)
        d["pl_name"] = pl_names.get(s.playlist_id or 0, "")
        songs.append(d)
    return templates.TemplateResponse(request, "partials/songs.html", {"songs": songs})


@router.get("/partials/up-list", response_class=HTMLResponse)
def up_list_partial(request: Request):
    """UP 主视图左栏：曲库内所有 UP 主（客户端按拼音排序），首歌 bvid 供头像懒解析。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    stats: dict[str, dict] = {}
    order: list[str] = []
    for s in library.list_songs():
        st = stats.get(s.artist)
        if st is None:
            st = stats[s.artist] = {"artist": s.artist, "count": 0, "bvid": s.bvid}
            order.append(s.artist)
        st["count"] += 1
    return templates.TemplateResponse(request, "partials/up_list.html", {"ups": [stats[a] for a in order]})


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
async def rec_playlists_partial(request: Request):
    """主页推荐歌单架：每日精选 + B站音乐区电台 + 各风格精选卡（线上内容，非用户曲库）。

    封面用前 4 首歌的真实封面拼贴（Apple Music 精选歌单风格），不用渐变。
    """
    gate = _login_redirect(request)
    if gate:
        return gate
    bili = request.state.bili

    def _covers(items: list) -> list[str]:
        first = items[0] if items else None
        if first is None:
            return []
        if isinstance(first, dict):
            return [i["cover_url"] for i in items[:4]]
        return [i.cover_url for i in items[:4]]

    daily = recs.daily_items()
    cards = [{
        "key": "daily", "name": "每日精选",
        "count": len(daily), "hue": 340, "covers": _covers(daily),
    }]
    for key, _rid, name in zone.RADIOS:
        items = await zone.items_for(bili, key)
        cards.append({
            "key": key, "name": name,
            "count": len(items), "hue": _HUES[(len(cards) + 1) % len(_HUES)],
            "covers": _covers(items),
        })
    for i, g in enumerate(recs.GENRE_KEYWORDS.keys()):
        items = recs.list_items(genre=g)
        if items:
            cards.append({
                "key": g, "name": f"{g}精选",
                "count": len(items), "hue": _HUES[(i + 1) % len(_HUES)],
                "covers": _covers(items),
            })
    return templates.TemplateResponse(request, "partials/rec_playlists.html", {"cards": cards})


@router.get("/partials/recommend-shelves", response_class=HTMLResponse)
async def recommend_shelves_partial(request: Request):
    """推荐页货架：除「每日精选」（已单独成列表）外的每个歌单一条横栏——B站音乐区电台 + 各风格精选。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    bili = request.state.bili

    def _card(i):
        if isinstance(i, dict):
            return {
                "bvid": i["bvid"], "title": i["title"], "artist": i["artist"],
                "duration_text": _fmt_duration(i["duration"]),
                "cover_url": i["cover_url"], "genre": i["genre"],
            }
        return {
            "bvid": i.bvid, "title": i.title, "artist": i.artist,
            "duration_text": _fmt_duration(i.duration),
            "cover_url": i.cover_url, "genre": i.genre,
        }

    shelves = []
    for key, _rid, name in zone.RADIOS:
        items = await zone.items_for(bili, key)
        if items:
            shelves.append({"name": name, "cards": [_card(i) for i in items[:15]]})
    for g in recs.GENRE_KEYWORDS:
        items = recs.list_items(genre=g)
        if items:
            shelves.append({"name": f"{g}精选", "cards": [_card(i) for i in items[:15]]})
    return templates.TemplateResponse(request, "partials/recommend_shelves.html", {"shelves": shelves})


@router.get("/partials/rec-genre-tracks", response_class=HTMLResponse)
async def rec_genre_tracks_partial(request: Request, genre: str = "daily", layout: str = "rows"):
    """推荐歌单详情曲目表：daily=每日精选；rank/z*=B站音乐区电台；其余=风格推荐池。layout=cards 时渲染大封面横滑卡。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    if genre == "daily":
        rows = recs.daily_items()
        ctx_items = [
            {
                "bvid": i.bvid, "title": i.title, "artist": i.artist,
                "duration_text": _fmt_duration(i.duration),
                "cover_url": i.cover_url, "genre": i.genre,
            }
            for i in rows
        ]
    elif zone.is_zone_key(genre):
        rows = (await zone.items_for(request.state.bili, genre))[:30]
        ctx_items = [
            {
                "bvid": i["bvid"], "title": i["title"], "artist": i["artist"],
                "duration_text": _fmt_duration(i["duration"]),
                "cover_url": i["cover_url"], "genre": i["genre"],
            }
            for i in rows
        ]
    else:
        rows = recs.list_items(genre=genre)[:30]
        ctx_items = [
            {
                "bvid": i.bvid, "title": i.title, "artist": i.artist,
                "duration_text": _fmt_duration(i.duration),
                "cover_url": i.cover_url, "genre": i.genre,
            }
            for i in rows
        ]
    template = {
        "cards": "partials/rec_cards.html",
        "dcols": "partials/daily_columns.html",
    }.get(layout, "partials/rec_genre_tracks.html")
    return templates.TemplateResponse(
        request, template, {"items": ctx_items, "genre": genre}
    )


@router.get("/partials/genre-shelves", response_class=HTMLResponse)
async def genre_shelves_partial(request: Request):
    """首页流派货架：池子优先、按风格搜索补位，每栏 15 首；空栏跳过；按池内歌曲数从多到少排序。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    bili = request.state.bili
    with new_session() as session:  # 补位搜索结果排除已在曲库的（避免「已收藏的歌」混进推荐）
        known = set(session.exec(select(Song.bvid)).all())

    def _card(bvid, title, artist, duration, cover, genre):
        return {
            "bvid": bvid, "title": title, "artist": artist,
            "duration_text": _fmt_duration(duration),
            "cover_url": cover, "genre": genre,
        }

    shelves = []
    seen_global = set()  # 跨货架去重：同一搜索结果只进第一个取到它的货架
    for genre in recs.GENRE_KEYWORDS:
        pool = recs.list_items(genre=genre)[:15]
        seen = known | {i.bvid for i in pool} | seen_global
        cards = [_card(i.bvid, i.title, i.artist, i.duration, i.cover_url, i.genre) for i in pool]
        if len(cards) < 15:  # 池子不够：按风格搜一批补位（zone 侧 10 分钟缓存，排除已在曲库的）
            for e in await zone.genre_items(bili, genre):
                if len(cards) >= 15:
                    break
                if e["bvid"] in seen:
                    continue
                seen.add(e["bvid"])
                seen_global.add(e["bvid"])
                cards.append(_card(e["bvid"], e["title"], e["artist"], e["duration"], e["cover_url"], e["genre"]))
        if not cards:
            continue
        shelves.append({"genre": genre, "count": len(pool), "cards": cards})
    shelves.sort(key=lambda s: s["count"], reverse=True)
    return templates.TemplateResponse(request, "partials/genre_shelves.html", {"shelves": shelves})


_UP_HUE_CACHE: dict[str, int | None] = {}  # face url → 主色调 h（0-359），None=提取失败


def _dominant_hue(data: bytes) -> int | None:
    """头像主色调：缩到 8×8 后按 饱和度×明度 加权平均（比纯平均更贴近人眼感知的主题色）。"""
    import colorsys
    import io

    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data)).convert("RGB").resize((8, 8))
    except Exception:
        return None
    sx = sy = sw = 0.0
    for r, g, b in img.getdata():
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s < 0.12:  # 跳过近灰像素，避免把主色洗灰
            continue
        x, y = ((h % 1) * 360 - 180), s * v  # 角度加权，避免 359° 与 1° 相消
        sx += math.cos(math.radians(x)) * y
        sy += math.sin(math.radians(x)) * y
        sw += y
    if sw <= 0:
        return None
    hue = (math.degrees(math.atan2(sy, sx)) + 180 + 360) % 360
    return round(hue)


async def _face_hue(bili, face: str) -> int | None:
    """下载头像提主色调；结果按 url 缓存，失败返回 None（前端回退默认粉紫）。"""
    if not face:
        return None
    if face in _UP_HUE_CACHE:
        return _UP_HUE_CACHE[face]
    hue: int | None = None
    try:
        validate_bilibili_url(face)
        resp = await bili.http.get(face)
        resp.raise_for_status()
        hue = _dominant_hue(resp.content)
    except Exception:
        hue = None
    _UP_HUE_CACHE[face] = hue
    return hue


@router.get("/web/up/resolve")
async def up_resolve(request: Request, bvid: str = "", mid: int = 0):
    """bvid 或 mid → UP 主 {mid, name, face, hue}；hue=头像主色调（作品页背景配色用）。"""
    if not request.state.cookies.logged_in:
        return JSONResponse({"error": "需要先登录"}, status_code=401)
    bvid = (bvid or "").strip()
    if not bvid and mid <= 0:
        return JSONResponse({"error": "缺少 bvid 或 mid"}, status_code=400)
    try:
        if mid > 0:
            owner = await request.state.bili.get_user_card(mid)
        else:
            owner = await request.state.bili.get_video_owner(bvid)
    except BiliApiError as exc:
        return JSONResponse({"error": exc.message}, status_code=502)
    if not owner.get("mid"):
        return JSONResponse({"error": "未找到 UP 主"}, status_code=404)
    owner["hue"] = await _face_hue(request.state.bili, owner.get("face", ""))
    return JSONResponse(owner)


@router.get("/partials/up", response_class=HTMLResponse)
async def up_videos_partial(request: Request, mid: int = 0, pn: int = 1, name: str = ""):
    """UP 主投稿视频列表（试听 + ♥ 收藏入库），作品页覆盖层局部。

    投稿接口被风控拦截时降级：站内搜索该 UP 名并过滤其作品（结果可能不全）。
    """
    gate = _login_redirect(request)
    if gate:
        return gate
    if mid <= 0:
        return HTMLResponse("<div class='empty'>缺少 UP 主 id</div>")
    bili = request.state.bili
    has_more = False
    total = 0
    top10: list[dict] = []
    try:
        items, total = await bili.space_arcs(mid, pn=pn, ps=30)
        has_more = pn * 30 < total
    except BiliApiError:
        if not name.strip():
            raise
        hits = await bili.search_videos(name.strip())
        items = [
            {
                "bvid": h.bvid,
                "title": h.title,
                "pic": h.cover_url,
                "length": _fmt_duration(h.duration),
                "play": h.play,
            }
            for h in hits
            if h.artist == name.strip()
        ][:30]
    if pn == 1 and len(items) >= 5:
        # 首屏 TOP10（click 排序，风控时页内降级），其余作品去重后排列
        try:
            tops, _ = await bili.space_arcs(mid, pn=1, ps=10, order="click")
            top10 = tops[:10]
        except BiliApiError:
            top10 = sorted(items, key=lambda v: int(v.get("play") or 0), reverse=True)[:10]
        shown = {v["bvid"] for v in top10}
        items = [v for v in items if v["bvid"] not in shown]

    def _vctx(v: dict) -> dict:
        pic = str(v.get("pic") or "")
        return {
            "bvid": v["bvid"],
            "title": str(v.get("title") or "").strip(),
            "pic": https_media_url(pic),
            "length": str(v.get("length") or ""),
            "play_text": _fmt_play(int(v.get("play") or 0)),
        }

    ctx = [_vctx(v) for v in items]
    return templates.TemplateResponse(
        request,
        "partials/up_videos.html",
        {
            "items": ctx,
            "mid": mid,
            "pn": pn,
            "has_more": has_more,
            "name": name.strip(),
            "total": total,
            "total_text": _fmt_play(total) if total else "",
            "top10": [_vctx(v) for v in top10],
        },
    )


@router.get("/partials/recent", response_class=HTMLResponse)
def recent_partial(request: Request):
    """最近收藏架（refreshSongs 触发实时刷新）。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    recent = [_song_ctx(s) for s in library.list_songs()[:8]]
    return templates.TemplateResponse(request, "partials/recent_rack.html", {"recent": recent})


@router.get("/partials/albums", response_class=HTMLResponse)
def albums_partial(request: Request):
    gate = _login_redirect(request)
    if gate:
        return gate
    with new_session() as session:
        albums = session.exec(select(Album).order_by(Album.created_at.desc())).all()
    cards = [{"id": a.id, "title": a.title, "artist": a.artist, "totalPages": a.total_pages,
              "coverUrl": https_media_url(a.cover_url)} for a in albums]
    return templates.TemplateResponse(request, "partials/albums.html", {"albums": cards})


@router.get("/partials/album-tracks", response_class=HTMLResponse)
def album_tracks_partial(request: Request, album_id: int):
    gate = _login_redirect(request)
    if gate:
        return gate
    with new_session() as session:
        album = session.get(Album, album_id)
        songs = session.exec(select(Song).where(Song.album_id == album_id).order_by(Song.track_no)).all() if album else []
    return templates.TemplateResponse(request, "partials/album_tracks.html", {"album": album, "songs": [_song_ctx(s) for s in songs], "has_more": False})


async def _web_search_all(bili, q: str) -> tuple[list[dict], list[dict]]:
    """视频 + UP 主站内搜索（带缓存），搜索下拉与搜索详情页共用。"""
    cached = _search_cache.get(q)
    if cached and time.monotonic() - cached[0] < _SEARCH_CACHE_TTL:
        return cached[1], cached[2]
    hits, users = await asyncio.gather(
        bili.search_videos(q), bili.search_users(q, limit=8)
    )
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
        for h in hits
    ]
    ups = [
        {
            "mid": u["mid"],
            "name": u["name"],
            "sign": u["sign"],
            "fans_text": _fmt_play(u["fans"]),
            "face": u["face"],
        }
        for u in users
    ]
    _search_cache[q] = (time.monotonic(), results, ups)
    if len(_search_cache) > 64:  # 只留最近 32 词
        for k in sorted(_search_cache, key=lambda k: _search_cache[k][0])[:-32]:
            _search_cache.pop(k, None)
    return results, ups


@router.get("/partials/web-search", response_class=HTMLResponse)
async def web_search(request: Request, q: str = ""):
    """B 站站内搜索结果（曲库搜索框联动）：UP 主 + 视频；导入按钮复用 /web/import 链路。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    q = (q or "").strip()
    results, ups, error = [], [], None
    # 粘贴的是链接 / BV 号时不做站内搜索，交给导入框处理
    if q and not (q.lower().startswith("http") or BV_RE.search(q) or parse_video_url(q)):
        try:
            results, ups = await _web_search_all(request.state.bili, q)
        except BiliApiError as exc:
            error = str(exc)
    return templates.TemplateResponse(
        request, "partials/web_search.html",
        {"results": results, "ups": ups, "error": error},
    )


@router.get("/partials/search-detail", response_class=HTMLResponse)
async def search_detail(request: Request, q: str = ""):
    """搜索详情页（回车进入）：上排 UP 主圆形卡、下方视频方形封面网格。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    q = (q or "").strip()
    results, ups, error = [], [], None
    if q and not (q.lower().startswith("http") or BV_RE.search(q) or parse_video_url(q)):
        try:
            results, ups = await _web_search_all(request.state.bili, q)
        except BiliApiError as exc:
            error = str(exc)
    return templates.TemplateResponse(
        request, "partials/search_detail.html",
        {"q": q, "results": results, "ups": ups, "error": error},
    )


@router.post("/web/sync", response_class=HTMLResponse)
async def web_sync(request: Request):
    """顶栏「同步」：与 B 站夹池双向对账。拉取的歌会以导入任务形式出现在任务列表。"""
    gate = _login_redirect(request)
    if gate:
        return gate
    request.state.syncer.submit()

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
        items = recs.discover_items()  # 发现板块：刷新即换一批（每日精选歌单仍按日轮换）
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
                request.state.importer, request.state.bili, url,
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
    """登录已改为全局弹窗：本路由保留兼容旧链接，跳主页并自动弹窗。"""
    return RedirectResponse("/?login=1", status_code=307)
