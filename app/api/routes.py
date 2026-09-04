"""REST API：导入任务、曲库、媒体流、扫码登录。

契约同时服务于 Web 页与二期 Flutter 安卓端，字段变更需同步 README.md 的契约文档。
"""

import urllib.parse
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.bili.client import BiliClient
from app.bili.quality import quality_label
from app.config import settings
from app.core.cookies import CookieStore
from app.db.models import ImportTask, Song
from app.services import library
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


# ---- 导入 ----

class ImportCreate(BaseModel):
    url: str = Field(min_length=1, max_length=2000, description="B 站链接或完整分享文本")


@router.post("/imports", status_code=202)
async def create_import(body: ImportCreate, request: Request) -> dict:
    task = request.app.state.importer.submit(body.url)
    return {"importId": task.id}


@router.post("/imports/batch", status_code=202)
async def create_batch_import(body: ImportCreate, request: Request) -> dict:
    """智能提交：收藏夹链接批量导入，否则单视频导入（响应含 mode 区分）。"""
    from app.services.batch import submit_any

    return await submit_any(
        request.app.state.importer, request.app.state.bili, body.url
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
def list_songs(q: str = "") -> dict:
    return {"songs": [song_out(s) for s in library.list_songs(q)]}


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


@router.delete("/songs/{song_id}")
def delete_song_api(song_id: int, files: FileStore = Depends(_files)) -> dict:
    if not library.delete_song(song_id, files):
        raise HTTPException(status_code=404, detail="歌曲不存在")
    return {"ok": True}


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


# ---- 登录（免登录门禁） ----

@auth_router.post("/qrcode")
async def create_qrcode(bili: BiliClient = Depends(_bili)) -> dict:
    qr = await bili.qrcode_generate()
    return {"qrContent": qr.url, "qrPngDataUrl": qr.png_data_url, "qrcodeKey": qr.qrcode_key}


@auth_router.get("/qrcode/{qrcode_key}")
async def poll_qrcode(qrcode_key: str, bili: BiliClient = Depends(_bili)) -> dict:
    poll = await bili.qrcode_poll(qrcode_key)
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
