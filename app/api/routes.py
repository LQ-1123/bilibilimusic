"""REST API：导入任务、曲库、媒体流、扫码登录。

契约同时服务于 Web 页与二期 Flutter 安卓端，字段变更需同步 README.md 的契约文档。
"""

import asyncio
import hashlib
import logging
import re
import urllib.parse
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app import events
from app.bili.client import (
    BILIBILI_REFERER,
    BiliClient,
    BiliApiError,
    https_media_url,
)
from app.bili.quality import pick_best_audio, quality_label
from app.config import settings
from app.core.cookies import CookieStore
from app.core.url_guard import UnsafeUrlError, validate_bilibili_url
from app.db.models import ImportTask, Song
from app.services import library, playlists, recs
from app.services.importer import ImportService
from app.storage.files import FileStore

log = logging.getLogger(__name__)

def _require_token(request: Request) -> None:
    token = settings.api_token
    if not token:
        return
    auth = request.headers.get("Authorization", "")
    provided = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not provided:
        provided = request.query_params.get("token", "")
    if provided != token:
        raise HTTPException(status_code=401, detail="无效的 API Token")


def _require_login(request: Request) -> None:
    """强制登录：除登录流程外的所有 API 都要求已扫码登录。"""
    store: CookieStore = request.state.cookies
    if not store.logged_in:
        raise HTTPException(status_code=401, detail="需要先扫码登录 B 站账号")


router = APIRouter(
    prefix="/api", dependencies=[Depends(_require_token), Depends(_require_login)]
)
# 登录流程自身不能被登录门禁挡住
auth_router = APIRouter(prefix="/api/auth", dependencies=[Depends(_require_token)])

STATUS_LABELS = {
    "pending": "排队中",
    "resolving": "解析中",
    "downloading": "下载中",
    "ready": "已完成",
    "failed": "失败",
}


# ---- 依赖 ----

def _bili(request: Request) -> BiliClient:
    return request.state.bili


async def _login_bili(request: Request):
    accounts = request.app.state.accounts
    candidate = accounts.login_client()
    try:
        yield candidate
    finally:
        if accounts.current.bili is not candidate:
            await candidate.aclose()


def _files(request: Request) -> FileStore:
    return request.state.files


def _media_token_suffix() -> str:
    if settings.api_token:
        return "?token=" + urllib.parse.quote(settings.api_token)
    return ""


# ---- 序列化 ----

def _fallback_color(bvid: str) -> str:
    """无封面主色时的稳定兜底色（由 bvid 哈希派生，同一首歌颜色恒定）。"""
    h = int(hashlib.sha256(bvid.encode()).hexdigest()[:6], 16)
    r, g, b = h >> 16 & 0xFF, h >> 8 & 0xFF, h & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


def song_out(s: Song) -> dict:
    cover = s.cover_path or ""
    return {
        "id": s.id,
        "bvid": s.bvid,
        "title": s.title,
        "artist": s.artist,
        "duration": s.duration,
        "qualityId": s.quality_id,
        "qualityLabel": "在线" if not s.quality_id else quality_label(s.quality_id),
        # 多分 P 视频按导入时存的 cid 路由（p>1 的歌曲不再播成第一分 P）
        "audioUrl": f"/api/stream/{s.bvid}" + (f"?cid={s.cid}" if s.cid else ""),
        "coverUrl": https_media_url(cover) if cover.startswith("http") else f"/api/songs/{s.id}/cover" + _media_token_suffix(),
        "coverColor": s.cover_color or _fallback_color(s.bvid),
        "aid": s.aid,
        "playlistId": s.playlist_id,
        "favFolderId": s.fav_folder_id,
        "createdAt": s.created_at.isoformat(),
    }


def task_out(t: ImportTask) -> dict:
    song = library.get_song(t.song_id) if t.song_id else None
    return {
        "id": t.id,
        "sourceUrl": t.source_url,
        "status": t.status,
        "statusLabel": STATUS_LABELS.get(t.status, t.status),
        "progress": t.progress,
        "error": t.error,
        "songId": t.song_id,
        "song": song_out(song) if song else None,
        "createdAt": t.created_at.isoformat(),
    }


# ---- 收藏（导入） ----

class ImportCreate(BaseModel):
    url: str = Field(min_length=1, max_length=2000, description="B 站链接或完整分享文本")
    playlistId: int = Field(default=0, description="目标歌单；0 = 默认歌单")


@router.post("/imports", status_code=202)
async def create_import(body: ImportCreate, request: Request) -> dict:
    task = request.state.importer.submit(body.url, playlist_id=body.playlistId)
    recs.dismiss_for_text(body.url)  # 发现页收藏转正：出池
    return {"importId": task.id}


@router.post("/imports/batch", status_code=202)
async def create_batch_import(body: ImportCreate, request: Request) -> dict:
    """智能提交：收藏夹链接批量导入，否则单视频导入（响应含 mode 区分）。"""
    from app.services.batch import submit_any

    return await submit_any(
        request.state.importer, request.state.bili, body.url,
        playlist_id=body.playlistId,
    )


@router.get("/imports")
def list_imports() -> dict:
    return {"tasks": [task_out(t) for t in ImportService.recent_tasks(50)]}


@router.get("/imports/{task_id}")
def get_import(task_id: str) -> dict:
    task = ImportService.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task_out(task)


# ---- 曲库 ----

@router.get("/songs")
def list_songs(q: str = "", playlist_id: int = 0) -> dict:
    return {"songs": [song_out(s) for s in library.list_songs(q, playlist_id=playlist_id)]}

def playlist_out(p) -> dict:
    from app.services.playlists import folder_ids

    return {"id": p.id, "name": p.name, "folderIds": folder_ids(p)}


# ---- 歌单（每歌单对应收藏夹 bilimusic- <歌单名>） ----

class PlaylistBody(BaseModel):
    name: str = Field(min_length=1, max_length=16)


@router.get("/playlists")
def list_playlists_api() -> dict:
    return {"playlists": [playlist_out(p) for p in playlists.list_playlists()]}


@router.post("/playlists", status_code=201)
async def create_playlist_api(body: PlaylistBody, request: Request) -> dict:
    p = await playlists.create(body.name, request.state.bili)
    return playlist_out(p)


@router.patch("/playlists/{playlist_id}")
async def rename_playlist_api(
    playlist_id: int, body: PlaylistBody, request: Request
) -> dict:
    """改歌单名；B 站收藏夹名同步更新（bilimusic- <新名字>）。"""
    if playlists.get_playlist(playlist_id) is None:
        raise HTTPException(status_code=404, detail="歌单不存在")
    await playlists.rename(playlist_id, body.name, request.state.bili)
    return playlist_out(playlists.get_playlist(playlist_id))


@router.delete("/playlists/{playlist_id}", status_code=202)
async def delete_playlist_api(playlist_id: int, request: Request) -> dict:
    """删除歌单：歌曲移入默认歌单（解放），B 站收藏夹一并删除；收藏转移后台执行。"""
    try:
        return await playlists.delete(playlist_id, request.state.bili)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/songs/{song_id}")
def get_song_api(song_id: int) -> dict:
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return song_out(song)


@router.get("/songs/{song_id}/cover")
def song_cover(song_id: int, files: FileStore = Depends(_files)):
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    if (song.cover_path or "").startswith("http"):  # 在线封面：直接重定向 CDN
        return RedirectResponse(https_media_url(song.cover_path))
    return files.cover_response(Path(song.cover_path))


@router.get("/songs/{song_id}/lyrics")
async def song_lyrics(song_id: int, request: Request) -> dict:
    """歌词（带轴 LRC 或无轴纯文本）；未抓取过则现场懒抓（B站字幕+LRCLIB）并缓存。

    存量歌曲无需回填脚本：首次打开歌词面板时由此端点自动补齐。
    取不到返回 {"lyrics": null}，已标记不再重复请求外部接口。
    """
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    if not song.lyrics_checked:
        await request.state.lyrics.ensure_for_song(song_id)
        song = library.get_song(song_id) or song
    return {"lyrics": song.lyrics or None, "source": song.lyrics_source or None}


@router.post("/lyrics/preview")
async def lyrics_preview(request: Request, payload: dict) -> dict:
    """实时流试听歌取词（不落库）：按 bvid 现解析 cid/aid，走同一套字幕+LRCLIB 链路。"""
    bvid = str(payload.get("bvid") or "")
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
        raise HTTPException(status_code=400, detail="bvid 格式错误")
    result = await request.state.lyrics.fetch_preview(
        bvid,
        title=str(payload.get("title") or ""),
        artist=str(payload.get("artist") or ""),
        duration=max(0, int(payload.get("duration") or 0)),
    )
    return {"lyrics": result[0] if result else None, "source": result[1] if result else None}


@router.delete("/songs/{song_id}")
async def delete_song_api(
    song_id: int, request: Request, files: FileStore = Depends(_files)
) -> dict:
    song = library.get_song(song_id)
    if song is None or not library.delete_song(song_id, files):
        raise HTTPException(status_code=404, detail="歌曲不存在")
    # 删歌即取消收藏（夹池强关联曲库）；失败不影响本地删除
    bili: BiliClient = request.state.bili
    if song.aid:
        try:
            if song.fav_folder_id:
                await bili.unfavorite_song(song.aid, folder_id=song.fav_folder_id)
            else:
                asyncio.create_task(bili.unfavorite_song(song.aid))  # 旧数据：后台有界查找
        except BiliApiError:
            pass
    return {"ok": True}


# ---- 曲库同步（账号 ⇆ 收藏夹池） ----

@router.post("/sync", status_code=202)
async def create_sync(request: Request) -> dict:
    """双向对账：拉取（夹→本地导入）+ 推送（本地→补收藏）。已有进行中的同步则幂等返回。"""
    state = request.state.syncer.submit()
    return state.out()


@router.get("/sync/{sync_id}")
def get_sync(sync_id: str, request: Request) -> dict:
    state = request.state.syncer.get(sync_id)
    if state is None:
        raise HTTPException(status_code=404, detail="同步任务不存在")
    return state.out()


@router.get("/events")
async def library_events(request: Request) -> StreamingResponse:
    """SSE：曲库/歌单变更实时推给浏览器（EventSource），前端免手动刷新。

    事件按账号 mid 过滤（导入入库、对账删除发布时携带）；15 秒无事件发
    心跳注释行保活，断开由连接取消触发 finally 退订。
    """
    mid = request.state.mid
    queue = events.subscribe(mid)

    async def stream():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    name = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"event: {name}\ndata: {name}\n\n"
        finally:
            events.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---- B 站搜索 ----

def _fmt_duration(seconds: int) -> str:
    h, rem = divmod(max(0, int(seconds or 0)), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def search_out(h) -> dict:
    return {
        "bvid": h.bvid,
        "avid": h.avid,
        "title": h.title,
        "artist": h.artist,
        "duration": h.duration,
        "durationText": _fmt_duration(h.duration),
        "coverUrl": h.cover_url,
        "play": h.play,
        "importUrl": f"https://www.bilibili.com/video/{h.bvid}",
    }


@router.get("/search")
async def search_bili(
    q: str = "", keyword: str = "", page: int = 1, bili: BiliClient = Depends(_bili)
) -> dict:
    """B 站站内搜索（WBI 签名综合搜索，仅视频分区），找到后可直接把 importUrl 提交导入。

    兼容 q / keyword 两种参数名（q 与曲库搜索框一致）。
    """
    kw = (keyword or q).strip()
    hits = await bili.search_videos(kw, page=page)
    return {"keyword": kw, "results": [search_out(h) for h in hits]}


# ---- 导出（曲库 → B 站收藏夹） ----

@router.get("/playlists/{pid}/covers")
def playlist_covers(pid: int) -> dict:
    """用户歌单详情封面素材：取歌单内最新的 4 首视频封面（前端做 mosaic 艺术化）。"""
    covers = [song_out(s)["coverUrl"] for s in library.list_songs(limit=4, playlist_id=pid)]
    return {"covers": [c for c in covers if c]}


@router.get("/playlists/{pid}/share-link")
async def playlist_share_link(pid: int, request: Request) -> dict:
    """歌单详情页「分享」：返回该歌单对应 B 站收藏夹的首夹链接。"""
    bili = request.state.bili
    mid = int(bili.store.get("mid") or await bili.get_my_mid())
    if pid == 0:  # 全部歌曲 = 主夹（bilimusic）
        main_id = await bili.ensure_fav_folder()
        return {"name": "我的曲库", "link": f"https://space.bilibili.com/{mid}/favlist?fid={main_id}", "folderCount": 1}
    p = playlists.get_playlist(pid)
    if p is None:
        raise HTTPException(status_code=404, detail="歌单不存在")
    ids = playlists.folder_ids(p)
    if not ids:  # 本地还没记到夹 id：现场比对一次 B 站收藏夹（按标题认领）
        await playlists.adopt_folders(bili)
        ids = playlists.folder_ids(p)
    if not ids:
        raise HTTPException(status_code=409, detail="该歌单还没有同步到 B 站收藏夹，先收藏几首歌")
    return {"name": p.name, "link": f"https://space.bilibili.com/{mid}/favlist?fid={ids[0]}", "folderCount": len(ids)}


@router.post("/exports", status_code=202)
async def create_export(request: Request) -> dict:
    state = request.state.exporter.submit()
    return {"exportId": state.id, "total": state.total, "status": state.status}


@router.get("/exports/{export_id}")
def get_export(export_id: str, request: Request) -> dict:
    state = request.state.exporter.get(export_id)
    if state is None:
        raise HTTPException(status_code=404, detail="导出任务不存在")
    return state.out()


class ExportPoll(BaseModel):
    exportId: str = Field(min_length=12, max_length=12, pattern=r"^[0-9a-f]{12}$")


@router.post("/exports/status")
def poll_export(body: ExportPoll, request: Request) -> dict:
    """Web 端轮询用（静态路径 + 请求体传 id）。"""
    state = request.state.exporter.get(body.exportId)
    if state is None:
        raise HTTPException(status_code=404, detail="导出任务不存在")
    return state.out()


# ---- 推荐池（滚动链接组，不落音频） ----

def rec_out(i) -> dict:
    return {
        "bvid": i.bvid,
        "title": i.title,
        "artist": i.artist,
        "duration": i.duration,
        "durationText": _fmt_duration(i.duration),
        "coverUrl": i.cover_url,
        "genre": i.genre,
        "seedBvid": i.seed_bvid,
        "expiresAt": i.expires_at.isoformat(),
    }


class RecSeed(BaseModel):
    songId: int = Field(gt=0)


@router.post("/recs/seed", status_code=202)
async def recs_seed(body: RecSeed, request: Request) -> dict:
    """播放起播时搭车调用：以当前歌为种子采集相关推荐（服务端频控，幂等）。"""
    song = library.get_song(body.songId)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    bili: BiliClient = request.state.bili
    asyncio.create_task(recs.collect_for_song(bili, song))
    return {"queued": True}


@router.get("/recs")
def recs_list(genre: str = "", mode: str = "") -> dict:
    """mode=today 返回今日推荐；否则按 genre 过滤（空 = 全部）。"""
    if mode == "today":
        items = recs.daily_items()
    else:
        items = recs.list_items(genre=genre)
    return {"items": [rec_out(i) for i in items]}


@router.delete("/recs/{bvid}")
def recs_dismiss(bvid: str) -> dict:
    recs.dismiss(bvid)
    return {"ok": True}


# ---- 实时流代理（推荐试听：解析直链后边下边转发，不落盘） ----

def _pick_stream_cid(cids: list[int], cid: int | None) -> int:
    """流路由分 P 选择：默认第一分 P；显式 cid 必须属于该视频（防串 P），否则 400。"""
    picked = cids[0]
    if cid is not None and cid > 0:
        if cid not in cids:
            raise HTTPException(status_code=400, detail="cid 与该视频不匹配")
        picked = cid
    return picked


@router.get("/stream/{bvid}")
async def stream_bvid(
    bvid: str,
    request: Request,
    cid: int | None = None,
    range_header: str | None = Header(default=None, alias="Range"),
):
    """推荐歌曲实时播放：现解析 playurl → 代理 CDN 音频流（支持 Range/206）。

    直链域名经 url_guard 白名单校验，仅放行 B 站 CDN；不写磁盘。
    cid：可选分 P 指定（曲库多分 P 歌曲按导入时存的 Song.cid 路由，避免播成 P1）；
    必须属于该视频，否则 400 而不是静默播错。
    """
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
        raise HTTPException(status_code=400, detail="bvid 格式错误")
    bili: BiliClient = request.state.bili
    try:
        cids = await bili.video_page_cids(bvid)
    except BiliApiError as exc:
        raise HTTPException(status_code=502, detail=exc.message)
    picked = _pick_stream_cid(cids, cid)
    try:
        streams = await bili.get_audio_streams(bvid, picked)
    except BiliApiError as exc:
        raise HTTPException(status_code=502, detail=exc.message)
    best = pick_best_audio(streams)
    url = best.base_url
    try:
        validate_bilibili_url(url)
    except UnsafeUrlError:
        raise HTTPException(status_code=502, detail="CDN 地址未通过安全校验")

    headers = {"Referer": BILIBILI_REFERER}
    if range_header:
        headers["Range"] = range_header
    upstream = await bili.http.send(
        bili.http.build_request("GET", url, headers=headers), stream=True
    )
    if upstream.status_code >= 400:
        await upstream.aclose()
        raise HTTPException(status_code=502, detail="B 站 CDN 拒绝了播放请求")

    out_headers = {}
    for h in ("content-length", "content-range", "accept-ranges"):
        if h in upstream.headers:
            out_headers[h] = upstream.headers[h]

    async def gen():
        try:
            async for chunk in upstream.aiter_bytes(64 * 1024):
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        gen(), status_code=upstream.status_code, media_type="audio/mp4", headers=out_headers
    )


# ---- 登录（免登录门禁） ----

@auth_router.post("/qrcode")
async def create_qrcode(bili: BiliClient = Depends(_login_bili)) -> dict:
    qr = await bili.qrcode_generate()
    return {
        "qrContent": qr.url,
        "qrPngDataUrl": qr.png_data_url,
        "qrcodeKey": qr.qrcode_key,
        "matrix": qr.matrix,
        "modules": qr.modules,
    }


@auth_router.get("/captcha")
async def get_captcha(bili: BiliClient = Depends(_login_bili)) -> dict:
    """短信登录用的极验参数（gt/challenge/token），前端 initGeetest 弹滑块。"""
    return await bili.captcha_get()


@auth_router.post("/sms/send")
async def sms_send(payload: dict, bili: BiliClient = Depends(_login_bili)) -> dict:
    tel = str(payload.get("tel") or "").strip()
    if not (tel.isdigit() and len(tel) == 11):
        raise HTTPException(status_code=400, detail="手机号格式不对")
    try:
        data = await bili.sms_send(
            tel, str(payload.get("cid") or "86"),
            token=str(payload.get("token") or ""),
            challenge=str(payload.get("challenge") or ""),
            validate=str(payload.get("validate") or ""),
            seccode=str(payload.get("seccode") or ""),
        )
    except BiliApiError as exc:
        raise HTTPException(status_code=400, detail=exc.message)
    return {"ok": True, "captchaKey": data.get("captcha_key") or ""}


@auth_router.post("/sms/login")
async def sms_login(payload: dict, request: Request, bili: BiliClient = Depends(_login_bili)) -> dict:
    tel = str(payload.get("tel") or "").strip()
    code = str(payload.get("code") or "").strip()
    if not (tel.isdigit() and len(tel) == 11) or not (code.isdigit() and len(code) == 6):
        raise HTTPException(status_code=400, detail="手机号或验证码格式不对")
    try:
        await bili.sms_login(tel, code, str(payload.get("captchaKey") or ""), str(payload.get("cid") or "86"))
    except BiliApiError as exc:
        raise HTTPException(status_code=400, detail=exc.message)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="连接 B 站登录服务失败，请稍后重试") from exc
    await _activate_account_for(request, bili)
    return {"ok": True}


async def _activate_account_for(request: Request, bili: BiliClient) -> None:
    try:
        await request.app.state.accounts.activate(bili, generation=request.state.account_generation)
    except BiliApiError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="无法确认 B 站登录态，请稍后重试") from exc
    except Exception as exc:
        log.error("账号激活失败（%s）", type(exc).__name__)
        raise HTTPException(status_code=500, detail="账号数据保存失败，登录未完成，请稍后重试") from exc


@auth_router.get("/qrcode/{qrcode_key}")
async def poll_qrcode(qrcode_key: str, request: Request, bili: BiliClient = Depends(_login_bili)) -> dict:
    try:
        poll = await bili.qrcode_poll(qrcode_key)
    except BiliApiError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="连接 B 站登录服务失败，请稍后重试") from exc
    if poll.status == "confirmed":
        await _activate_account_for(request, bili)
    return {"status": poll.status}


@auth_router.get("/status")
async def auth_status(bili: BiliClient = Depends(_bili)) -> dict:
    status = await bili.login_status()
    return {
        "loggedIn": status.get("loggedIn", False),
        "username": status.get("username", ""),
        "maxQuality": "192K" if status.get("loggedIn") else "64K",
    }


@auth_router.delete("")
async def logout(request: Request) -> dict:
    await request.app.state.accounts.logout()
    return {"ok": True}


@auth_router.post("/logout")
async def logout_post(request: Request) -> dict:
    """Web 页用（静态路径 + POST）。"""
    await request.app.state.accounts.logout()
    return {"ok": True}
