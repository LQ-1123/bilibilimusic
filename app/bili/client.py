"""B 站 Web API 客户端。

接口参考 bilibili-API-collect；无官方兼容承诺，接口变动时集中改这里。
所有动态下发的 URL（封面、音频流、重定向）访问前都过 url_guard 白名单校验。
"""

import asyncio
import base64
import io
import time
from dataclasses import dataclass, field

import httpx
import qrcode

from app.core.cookies import CookieStore, local_fingerprint
from app.core.link_parser import VideoRef
from app.core.url_guard import validate_bilibili_url
from app.core.wbi import extract_wbi_keys, sign_params

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
BILIBILI_REFERER = "https://www.bilibili.com/"

_API = "https://api.bilibili.com"
_PASSPORT = "https://passport.bilibili.com"

# 账号下的专用收藏夹：入库自动收藏、导出即此夹
FAV_FOLDER_NAME = "bilimusic"

_WBI_KEY_TTL = 3600  # wbi key 每天轮换，缓存 1 小时足够

ERROR_MESSAGES = {
    -400: "请求参数错误",
    -403: "无权限访问（该内容可能需要登录）",
    -404: "视频不存在或已删除",
    -352: "触发 B 站风控校验，请稍后再试",
    -412: "请求被 B 站拦截，请稍后再试",
    62002: "稿件不可见",
    62004: "稿件审核中",
    62012: "稿件仅 UP 主本人可见",
    86038: "二维码已失效",
}

_QR_STATUS = {86101: "waiting", 86090: "scanned", 86038: "expired"}


class BiliApiError(Exception):
    """B 站接口返回错误；message 为可直接展示的中文文案。"""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class VideoInfo:
    bvid: str
    avid: int
    cid: int
    title: str
    artist: str
    duration: int  # 秒
    cover_url: str
    page: int
    part_title: str = ""


@dataclass
class AudioStream:
    quality_id: int
    base_url: str
    backup_urls: list[str] = field(default_factory=list)
    bandwidth: int = 0


@dataclass
class QrCode:
    url: str
    qrcode_key: str
    png_data_url: str


@dataclass
class QrPoll:
    status: str  # waiting / scanned / confirmed / expired
    cookies: dict[str, str] = field(default_factory=dict)


class BiliClient:
    def __init__(self, store: CookieStore, timeout: float = 20.0) -> None:
        self.store = store
        self._wbi: tuple[str, str] | None = None
        self._wbi_at = 0.0
        self._fav_lock = asyncio.Lock()
        self.http = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            headers={
                "User-Agent": BROWSER_UA,
                "Referer": BILIBILI_REFERER,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
            cookies=store.all(),
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    # ---- 基础请求 ----

    async def _get_json(
        self, path: str, params: dict | None = None, *, ok_codes: tuple[int, ...] = (0,)
    ) -> dict:
        url = path if path.startswith("http") else _API + path
        resp = await self.http.get(url, params=params)
        return self._parse_json_response(resp)

    async def _post_json(self, path: str, data: dict, *, ok_codes: tuple[int, ...] = (0,)) -> dict:
        url = path if path.startswith("http") else _API + path
        resp = await self.http.post(url, data=data)
        return self._parse_json_response(resp)

    def _parse_json_response(self, resp: httpx.Response, *, ok_codes: tuple[int, ...] = (0,)) -> dict:
        if resp.status_code == 412:
            raise BiliApiError(-412, ERROR_MESSAGES[-412])
        try:
            payload = resp.json()
        except ValueError as exc:
            raise BiliApiError(-400, f"B 站返回了无法解析的内容（HTTP {resp.status_code}）") from exc
        code = payload.get("code", -1)
        if code not in ok_codes:
            raise BiliApiError(code, ERROR_MESSAGES.get(code, payload.get("message") or f"B 站接口错误（code={code}）"))
        return payload.get("data") or {}

    # ---- 设备指纹 ----

    async def ensure_fingerprint(self) -> None:
        """首次运行获取 buvid3/buvid4，规避 -352 风控；失败则本地生成兜底。"""
        if self.store.has_fingerprint:
            self.http.cookies.update(self.store.all())
            return
        try:
            data = await self._get_json("/x/frontend/finger/spi")
            fp = {"buvid3": data["b_3"], "buvid4": data["b_4"]}
        except Exception:
            fp = local_fingerprint()
        self.store.set_many(fp)
        self.http.cookies.update(fp)

    # ---- WBI ----

    async def _wbi_keys(self) -> tuple[str, str]:
        # nav 未登录时 code=-101 但 data.wbi_img 照常返回
        if self._wbi is None or time.time() - self._wbi_at > _WBI_KEY_TTL:
            data = await self._get_json("/x/web-interface/nav", ok_codes=(0, -101))
            self._wbi = extract_wbi_keys(data)
            self._wbi_at = time.time()
        return self._wbi

    async def _get_json_signed(self, path: str, params: dict) -> dict:
        img_key, sub_key = await self._wbi_keys()
        return await self._get_json(path, sign_params(params, img_key, sub_key))

    # ---- 视频信息与播放地址 ----

    async def get_video_info(self, ref: VideoRef) -> VideoInfo:
        params: dict = {"bvid": ref.bvid} if ref.bvid else {"aid": ref.avid}
        # 旧版无签名 view 接口已被 WAF 拦截（412），必须走 WBI 签名版
        data = await self._get_json_signed("/x/web-interface/wbi/view", params)
        pages = data.get("pages") or []
        if not pages:
            raise BiliApiError(-400, "视频没有可用的分 P")
        idx = min(max(ref.page, 1), len(pages)) - 1
        return VideoInfo(
            bvid=data["bvid"],
            avid=int(data["aid"]),
            cid=int(pages[idx]["cid"]),
            title=str(data.get("title", "")).strip(),
            artist=str(data.get("owner", {}).get("name", "")).strip(),
            duration=int(data.get("duration") or 0),
            cover_url=data.get("pic", ""),
            page=idx + 1,
            part_title=str(pages[idx].get("part", "") or "").strip(),
        )

    async def get_audio_streams(self, bvid: str, cid: int) -> list[AudioStream]:
        params = {"bvid": bvid, "cid": cid, "qn": 64, "fnval": 16, "fourk": 1}
        data = await self._get_json_signed("/x/player/wbi/playurl", params)
        dash = data.get("dash") or {}
        audios = dash.get("audio") or []
        streams = []
        for a in audios:
            base = a.get("baseUrl") or a.get("base_url") or ""
            if not base:
                continue
            backups = a.get("backupUrl") or a.get("backup_url") or []
            streams.append(
                AudioStream(
                    quality_id=int(a.get("id", 0)),
                    base_url=base,
                    backup_urls=list(backups),
                    bandwidth=int(a.get("bandwidth") or 0),
                )
            )
        if not streams:
            raise BiliApiError(-404, "未取到音频流（视频可能太老，未提供 DASH 分离音轨）")
        return streams

    # ---- 音频/封面下载 ----

    def candidate_urls(self, stream: AudioStream) -> list[str]:
        return [stream.base_url, *stream.backup_urls]

    async def iter_download(self, url: str, chunk_size: int = 1 << 16):
        """按流迭代下载内容；动态 URL 先过白名单。"""
        validate_bilibili_url(url)
        async with self.http.stream("GET", url, headers={"Referer": BILIBILI_REFERER}) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes(chunk_size):
                yield chunk

    async def content_length(self, url: str) -> int:
        validate_bilibili_url(url)
        resp = await self.http.head(url, headers={"Referer": BILIBILI_REFERER})
        return int(resp.headers.get("content-length") or 0)

    # ---- 收藏夹 ----

    async def get_fav_folder_info(self, media_id: int) -> dict:
        """收藏夹元信息（标题/总数）；失败返回空 dict，不阻塞批量导入。"""
        try:
            return await self._get_json_signed(
                "/x/v3/fav/folder/info", {"media_id": media_id}
            )
        except BiliApiError:
            return {}

    async def get_fav_videos(self, media_id: int, cap: int = 200) -> list[dict]:
        """拉取收藏夹内的视频条目（已失效或非视频条目自动过滤）。"""
        out: list[dict] = []
        pn = 1
        total = None
        while len(out) < cap and pn <= 50:
            data = await self._get_json_signed(
                "/x/v3/fav/resource/list",
                {
                    "media_id": media_id,
                    "pn": pn,
                    "ps": 20,
                    "order": "mtime",
                    "tid": 0,
                    "platform": "web",
                },
            )
            if total is None:
                total = int(data.get("media_count") or 0)
            medias = data.get("medias") or []
            for item in medias:
                if not item.get("bvid"):
                    continue  # 已失效条目
                out.append(
                    {
                        "bvid": item["bvid"],
                        "title": str(item.get("title", "")).strip(),
                        "artist": str((item.get("upper") or {}).get("name", "")).strip(),
                    }
                )
                if len(out) >= cap:
                    break
            if not medias or (total is not None and len(out) >= total):
                break
            pn += 1
        return out

    # ---- 收藏夹导出 ----

    def _csrf(self) -> str:
        return self.store.get("bili_jct") or ""

    async def get_my_mid(self) -> int:
        """当前登录账号的 mid；登录态失效抛 BiliApiError。"""
        cached = self.store.get("mid")
        if cached:
            return int(cached)
        data = await self._get_json("/x/web-interface/nav", ok_codes=(0,))
        if not data.get("isLogin"):
            raise BiliApiError(-101, "B 站登录态已失效，请重新扫码登录")
        mid = int(data["mid"])
        self.store.set_many({"mid": str(mid)})
        return mid

    async def ensure_fav_folder(self) -> int:
        """确保账号下存在专用收藏夹「bilimusic」（公开），返回 media_id。

        media_id 缓存到本地；若用户在 B 站侧删除了该夹，下次调用会重建。
        """
        async with self._fav_lock:
            cached = self.store.get("fav_folder_id")
            if cached:
                return int(cached)
            mid = await self.get_my_mid()
            data = await self._get_json_signed(
                "/x/v3/fav/folder/created/list-all",
                {"up_mid": mid, "jsonp": "jsonp"},
            )
            folders = data.get("list", []) if isinstance(data, dict) else (data or [])
            for f in folders:
                if (f.get("title") or "").strip().lower() == FAV_FOLDER_NAME:
                    media_id = int(f["id"])
                    self.store.set_many({"fav_folder_id": str(media_id)})
                    return media_id
            media_id = await self.create_fav_folder(FAV_FOLDER_NAME)
            self.store.set_many({"fav_folder_id": str(media_id)})
            return media_id

    async def favorite_song(self, aid: int) -> None:
        """把单曲收藏进专用夹；夹被删时自动重建并重试一次。"""
        media_id = await self.ensure_fav_folder()
        try:
            await self.fav_add(aid, media_id)
        except BiliApiError:
            self.store.pop("fav_folder_id")
            media_id = await self.ensure_fav_folder()
            await self.fav_add(aid, media_id)

    async def create_fav_folder(self, title: str) -> int:
        """创建公开收藏夹，返回 media_id。"""
        data = await self._post_json(
            "/x/v3/fav/folder/add",
            {"title": title, "privacy": 0, "csrf": self._csrf()},
        )
        return int(data["id"])

    async def fav_add(self, aid: int, media_id: int) -> None:
        """把视频加入收藏夹（rid 为 av 号，type=2 稿件）。已在该夹内时为幂等操作。"""
        await self._post_json(
            "/x/v3/fav/resource/deal",
            {
                "rid": aid,
                "type": 2,
                "add_media_ids": str(media_id),
                "csrf": self._csrf(),
            },
        )

    async def bvid_to_aid(self, bvid: str) -> int | None:
        """旧数据懒补 aid 用；视频不可用时返回 None。"""
        try:
            info = await self.get_video_info(VideoRef(bvid=bvid))
        except BiliApiError:
            return None
        return info.avid

    # ---- 扫码登录 ----

    async def qrcode_generate(self) -> QrCode:
        data = await self._get_json(_PASSPORT + "/x/passport-login/web/qrcode/generate")
        img = qrcode.make(data["url"])
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        return QrCode(
            url=data["url"],
            qrcode_key=data["qrcode_key"],
            png_data_url=f"data:image/png;base64,{b64}",
        )

    async def qrcode_poll(self, qrcode_key: str) -> QrPoll:
        resp = await self.http.get(
            _PASSPORT + "/x/passport-login/web/qrcode/poll",
            params={"qrcode_key": qrcode_key},
        )
        try:
            payload = resp.json()
        except ValueError as exc:
            raise BiliApiError(-400, "登录轮询接口返回异常") from exc
        data = payload.get("data") or {}
        code = int(data.get("code", -1))
        if code == 0:
            cookies = {
                k: v
                for k, v in resp.cookies.items()
                if k in ("SESSDATA", "bili_jct", "dedeuserid", "sid")
            }
            if cookies:
                self.store.set_many(cookies)
                self.http.cookies.update(cookies)
                # 登录即后台确保专用收藏夹存在（不阻塞登录响应）
                asyncio.create_task(self._ensure_folder_quietly())
            return QrPoll(status="confirmed", cookies=cookies)
        return QrPoll(status=_QR_STATUS.get(code, "waiting"))

    async def _ensure_folder_quietly(self) -> None:
        try:
            await self.ensure_fav_folder()
        except Exception:  # noqa: BLE001  后台尽力而为，首次导入/导出还会懒建
            pass

    async def login_status(self) -> dict:
        """校验当前登录态是否仍有效。"""
        if not self.store.logged_in:
            return {"loggedIn": False}
        data = await self._get_json("/x/web-interface/nav", ok_codes=(0, -101))
        return {"loggedIn": bool(data.get("isLogin")), "username": data.get("uname") or ""}

    def logout(self) -> None:
        self.store.clear_login()
        for k in ("SESSDATA", "bili_jct", "dedeuserid", "sid"):
            try:
                del self.http.cookies[k]
            except KeyError:
                pass
