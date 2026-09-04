"""REST API：导入任务、曲库、媒体流、扫码登录。

契约同时服务于 Web 页与二期 Flutter 安卓端，字段变更需同步 README.md 的契约文档。
"""

import asyncio
import hashlib
import re
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.bili.client import (
    BILIBILI_REFERER,
    BiliClient,
    BiliApiError,
    VideoRef,
)
from app.bili.quality import pick_best_audio, quality_label
from app.config import settings
from app.core.cookies import CookieStore
from app.core.url_guard import UnsafeUrlError, validate_bilibili_url
from app.db.models import ImportTask, Song
from app.services import library, playlists, recs
from app.services.importer import ImportService
from app.storage.files import FileStore

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
    store: CookieStore = request.app.state.cookies
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
    return request.app.state.bili


def _files(request: Request) -> FileStore:
    return request.app.state.files


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
    return {
        "id": s.id,
        "bvid": s.bvid,
        "title": s.title,
        "artist": s.artist,
        "duration": s.duration,
        "qualityId": s.quality_id,
        "qualityLabel": quality_label(s.quality_id),
        "audioUrl": f"/api/songs/{s.id}/audio" + _media_token_suffix(),
        "coverUrl": f"/api/songs/{s.id}/cover" + _media_token_suffix(),
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
    task = request.app.state.importer.submit(body.url, playlist_id=body.playlistId)
    recs.dismiss_for_text(body.url)  # 发现页收藏转正：出池
    return {"importId": task.id}


@router.post("/imports/batch", status_code=202)
async def create_batch_import(body: ImportCreate, request: Request) -> dict:
    """智能提交：收藏夹链接批量导入，否则单视频导入（响应含 mode 区分）。"""
    from app.services.batch import submit_any

    return await submit_any(
        request.app.state.importer, request.app.state.bili, body.url,
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
    p = await playlists.create(body.name, request.app.state.bili)
    return playlist_out(p)


@router.patch("/playlists/{playlist_id}")
async def rename_playlist_api(
    playlist_id: int, body: PlaylistBody, request: Request
) -> dict:
    """改歌单名；B 站收藏夹名同步更新（bilimusic- <新名字>）。"""
    if playlists.get_playlist(playlist_id) is None:
        raise HTTPException(status_code=404, detail="歌单不存在")
    await playlists.rename(playlist_id, body.name, request.app.state.bili)
    return playlist_out(playlists.get_playlist(playlist_id))


@router.delete("/playlists/{playlist_id}", status_code=202)
async def delete_playlist_api(playlist_id: int, request: Request) -> dict:
    """删除歌单：歌曲移入默认歌单（解放），B 站收藏夹一并删除；收藏转移后台执行。"""
    try:
        return await playlists.delete(playlist_id, request.app.state.bili)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/songs/{song_id}")
def get_song_api(song_id: int) -> dict:
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return song_out(song)


@router.get("/songs/{song_id}/audio")
def song_audio(
    song_id: int,
    files: FileStore = Depends(_files),
    range_header: str | None = Header(default=None, alias="Range"),
):
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return files.audio_response(Path(song.audio_path), range_header)


@router.get("/songs/{song_id}/cover")
def song_cover(song_id: int, files: FileStore = Depends(_files)):
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
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
        await request.app.state.lyrics.ensure_for_song(song_id)
        song = library.get_song(song_id) or song
    return {"lyrics": song.lyrics or None, "source": song.lyrics_source or None}


@router.delete("/songs/{song_id}")
async def delete_song_api(
    song_id: int, request: Request, files: FileStore = Depends(_files)
) -> dict:
    song = library.get_song(song_id)
    if song is None or not library.delete_song(song_id, files):
        raise HTTPException(status_code=404, detail="歌曲不存在")
    # 删歌即取消收藏（夹池强关联曲库）；失败不影响本地删除
    bili: BiliClient = request.app.state.bili
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
    state = request.app.state.syncer.submit()
    return state.out()


@router.get("/sync/{sync_id}")
def get_sync(sync_id: str, request: Request) -> dict:
    state = request.app.state.syncer.get(sync_id)
    if state is None:
        raise HTTPException(status_code=404, detail="同步任务不存在")
    return state.out()


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

@router.post("/exports", status_code=202)
async def create_export(request: Request) -> dict:
    state = request.app.state.exporter.submit()
    return {"exportId": state.id, "total": state.total, "status": state.status}


@router.get("/exports/{export_id}")
def get_export(export_id: str, request: Request) -> dict:
    state = request.app.state.exporter.get(export_id)
    if state is None:
        raise HTTPException(status_code=404, detail="导出任务不存在")
    return state.out()


class ExportPoll(BaseModel):
    exportId: str = Field(min_length=12, max_length=12, pattern=r"^[0-9a-f]{12}$")


@router.post("/exports/status")
def poll_export(body: ExportPoll, request: Request) -> dict:
    """Web 端轮询用（静态路径 + 请求体传 id）。"""
    state = request.app.state.exporter.get(body.exportId)
    if state is None:
        raise HTTPException(status_code=404, detail="导出任务不存在")
    return state.out()


# ---- 智能过渡分析 ----

class AnalysisRequest(BaseModel):
    songId: int = Field(gt=0)


@router.post("/songs/analysis")
def song_analysis(body: AnalysisRequest, request: Request) -> dict:
    """获取歌曲的 TrackAnalysis；未就绪则投递后台分析并返回 202（前端降级/稍后再取）。"""
    song = library.get_song(body.songId)
    if song is None:
        raise HTTPException(status_code=404, detail="歌曲不存在")
    result = request.app.state.analysis.get_or_schedule(song)
    if result is None:
        return JSONResponse(status_code=202, content={"status": "analyzing"})
    return result


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
    bili: BiliClient = request.app.state.bili
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

@router.get("/stream/{bvid}")
async def stream_bvid(
    bvid: str, request: Request, range_header: str | None = Header(default=None, alias="Range")
):
    """推荐歌曲实时播放：现解析 playurl → 代理 CDN 音频流（支持 Range/206）。

    直链域名经 url_guard 白名单校验，仅放行 B 站 CDN；不写磁盘。
    """
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
        raise HTTPException(status_code=400, detail="bvid 格式错误")
    bili: BiliClient = request.app.state.bili
    try:
        info = await bili.get_video_info(VideoRef(bvid=bvid))
        streams = await bili.get_audio_streams(info.bvid, info.cid)
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
async def create_qrcode(bili: BiliClient = Depends(_bili)) -> dict:
    qr = await bili.qrcode_generate()
    return {
        "qrContent": qr.url,
        "qrPngDataUrl": qr.png_data_url,
        "qrcodeKey": qr.qrcode_key,
        "matrix": qr.matrix,
        "modules": qr.modules,
    }


@auth_router.get("/qrcode/{qrcode_key}")
async def poll_qrcode(qrcode_key: str, request: Request, bili: BiliClient = Depends(_bili)) -> dict:
    poll = await bili.qrcode_poll(qrcode_key)
    if poll.status == "confirmed":
        # 登录成功即后台对账：拉回夹池曲库（换设备/换服务器时这步就是「恢复」）
        syncer = getattr(request.app.state, "syncer", None)
        if syncer is not None:
            asyncio.create_task(syncer.reconcile_quietly())
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
def logout(bili: BiliClient = Depends(_bili)) -> dict:
    bili.logout()
    return {"ok": True}


@auth_router.post("/logout")
def logout_post(bili: BiliClient = Depends(_bili)) -> dict:
    """Web 页用（静态路径 + POST）。"""
    bili.logout()
    return {"ok": True}
