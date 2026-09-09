"""B 站 Web API 客户端。

接口参考 bilibili-API-collect；无官方兼容承诺，接口变动时集中改这里。
所有动态下发的 URL（封面、音频流、重定向）访问前都过 url_guard 白名单校验。
"""

import asyncio
import base64
import io
import re
import time
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlsplit

import httpx
import qrcode

from app.core.cookies import ACCOUNT_METADATA, CookieStore, local_fingerprint, login_cookies
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

# 账号下的专用收藏夹池：入库自动收藏、导出即这些夹；曲库清单 = 夹池内容并集。
# 命名规则：默认歌单「我的曲库」→ 主夹「bilimusic」（历史溢出 bilimusic2…）；
# 普通歌单 → 「bilimusic- <歌单名>」（溢出追加编号）。
# 歌单结构持久化在 B 站侧：换设备/换服务器登录后由同步自动收养重建。
FAV_FOLDER_NAME = "bilimusic"
_FOLDER_CAP = 2000  # B 站单个收藏夹条目上限
_FOLDER_RE = re.compile(r"^bilimusic(?:(?P<num>\d+)|-(?P<name>.+))?$")
_NAMED_RE = re.compile(r"^bilimusic-\s*(.+)$")
_FOLDERS_TTL = 60  # 夹池缓存秒数；建夹/改删夹/登出时失效
_UNFAV_SCAN_PAGES = 60  # 删歌时未知夹的有界扫描预算（页，20 条/页）

_WBI_KEY_TTL = 3600  # wbi key 每天轮换，缓存 1 小时足够

ERROR_MESSAGES = {
    -400: "请求参数错误",
    -403: "无权限访问（该内容可能需要登录）",
    -404: "视频不存在或已删除",
    -352: "触发 B 站风控校验，请稍后再试",
    -412: "请求被 B 站拦截，请稍后再试",
    11001: "名称超过字数限制（收藏夹总长约 20 字，歌单名请控制在 9 字内）",
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


def https_media_url(url: str) -> str:
    """B 站媒体地址统一升级 https：macOS ATS / Android 明文策略会拦 http:// 图片。"""
    if url.startswith("http://"):
        return "https://" + url[len("http://"):]
    if url.startswith("//"):
        return "https:" + url
    return url


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
    pages: list["VideoPage"] = field(default_factory=list)


@dataclass
class VideoPage:
    cid: int
    part: str
    duration: int


@dataclass
class AudioStream:
    quality_id: int
    base_url: str
    backup_urls: list[str] = field(default_factory=list)
    bandwidth: int = 0


@dataclass
class SearchHit:
    bvid: str
    avid: int
    title: str
    artist: str
    duration: int  # 秒
    cover_url: str
    play: int = 0


_EM_RE = re.compile(r"</?em[^>]*>")


def strip_highlight(title: str) -> str:
    """去掉搜索结果标题里的 <em class="keyword"> 高亮标签。"""
    return _EM_RE.sub("", title)


def parse_duration_text(text) -> int:
    """搜索结果的时长文本（"4:12" / "1:02:33"）→ 秒；无法解析返回 0。"""
    parts = str(text or "").strip().split(":")
    if not parts or len(parts) > 3 or not all(p.isdigit() for p in parts):
        return 0
    seconds = 0
    for p in parts:
        seconds = seconds * 60 + int(p)
    return seconds


def folder_sort_key(title: str) -> tuple[int, int, str]:
    """夹池排序：主夹「bilimusic」最前，其次编号溢出夹，再次歌单命名夹，最后其他。"""
    m = _FOLDER_RE.match(title.strip())
    if not m:
        return (3, 0, title)
    if m.group("num"):
        return (1, int(m.group("num")), title)
    if m.group("name"):
        return (2, 0, title)
    return (0, 0, title)


def next_folder_title(existing: list[str]) -> str:
    """默认歌单夹全满时应新建的夹名：编号取现有最大编号 +1（无编号夹视作 1）。"""
    nums = []
    for title in existing:
        m = _FOLDER_RE.match(title.strip())
        if m and m.group("num"):
            nums.append(int(m.group("num")))
    return f"bilimusic{max(nums + [1]) + 1}"


def playlist_folder_title(name: str) -> str:
    """歌单名 → 对应收藏夹名（B 站标题上限约 20 字，超长由接口报错提示）。"""
    return f"bilimusic- {name.strip()}"


def playlist_name_from_title(title: str) -> str | None:
    """收藏夹名 → 歌单名；非「bilimusic- X」命名的夹返回 None。"""
    m = _NAMED_RE.match(title.strip())
    if not m:
        return None
    name = m.group(1).strip()
    return name or None


@dataclass
class QrCode:
    url: str
    qrcode_key: str
    png_data_url: str
    matrix: list = field(default_factory=list)  # 点阵（"1"=黑模块），球海登录场景用
    modules: int = 0


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
        self._folders: tuple[float, list[dict]] | None = None  # (时间戳, 夹池)，TTL 缓存
        self._me: tuple[float, dict] | None = None  # (过期时间, nav 用户信息)，TTL 缓存
        self._playurl_cache: dict[tuple[str, int], tuple[float, list]] = {}  # playurl 解析缓存
        self.http = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            headers={
                "User-Agent": BROWSER_UA,
                "Referer": BILIBILI_REFERER,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
        )
        self._reset_http_cookies()

    def _reset_http_cookies(self) -> None:
        # httpx 自动接收的域 Cookie 与 dict.update 生成的无域 Cookie 会重名。
        # 从持久状态重建唯一的一组，账号元数据不作为 Cookie 发给 B 站。
        jar = httpx.Cookies()
        for key, value in self.store.all().items():
            if key not in ACCOUNT_METADATA:
                jar.set(key, value, domain=".bilibili.com", path="/")
        self.http.cookies = jar

    async def aclose(self) -> None:
        await self.http.aclose()

    # ---- 基础请求 ----

    async def _get_json(
        self, path: str, params: dict | None = None, *, ok_codes: tuple[int, ...] = (0,),
        headers: dict | None = None, timeout: float | None = None,
    ) -> dict:
        url = path if path.startswith("http") else _API + path
        resp = await self.http.get(url, params=params, headers=headers, timeout=timeout)
        return self._parse_json_response(resp, ok_codes=ok_codes)

    async def _post_json(self, path: str, data: dict, *, ok_codes: tuple[int, ...] = (0,)) -> dict:
        url = path if path.startswith("http") else _API + path
        resp = await self.http.post(url, data=data)
        return self._parse_json_response(resp, ok_codes=ok_codes)

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
            self._reset_http_cookies()
            return
        try:
            data = await self._get_json("/x/frontend/finger/spi")
            fp = {"buvid3": data["b_3"], "buvid4": data["b_4"]}
        except Exception:
            fp = local_fingerprint()
        self.store.set_many(fp)
        self._reset_http_cookies()

    # ---- WBI ----

    async def _wbi_keys(self) -> tuple[str, str]:
        # nav 未登录时 code=-101 但 data.wbi_img 照常返回
        if self._wbi is None or time.time() - self._wbi_at > _WBI_KEY_TTL:
            data = await self._get_json("/x/web-interface/nav", ok_codes=(0, -101))
            self._wbi = extract_wbi_keys(data)
            self._wbi_at = time.time()
        return self._wbi

    async def _get_json_signed(self, path: str, params: dict, headers: dict | None = None) -> dict:
        img_key, sub_key = await self._wbi_keys()
        return await self._get_json(path, sign_params(params, img_key, sub_key), headers=headers)

    # ---- 视频信息与播放地址 ----

    async def get_video_info(self, ref: VideoRef) -> VideoInfo:
        params: dict = {"bvid": ref.bvid} if ref.bvid else {"aid": ref.avid}
        # 旧版无签名 view 接口已被 WAF 拦截（412），必须走 WBI 签名版
        data = await self._get_json_signed("/x/web-interface/wbi/view", params)
        pages = data.get("pages") or []
        if not pages:
            raise BiliApiError(-400, "视频没有可用的分 P")
        idx = min(max(ref.page, 1), len(pages)) - 1
        page_rows = [VideoPage(int(p["cid"]), str(p.get("part", "") or "").strip(), int(p.get("duration") or data.get("duration") or 0)) for p in pages]
        return VideoInfo(
            bvid=data["bvid"],
            avid=int(data["aid"]),
            cid=int(pages[idx]["cid"]),
            title=str(data.get("title", "")).strip(),
            artist=str(data.get("owner", {}).get("name", "")).strip(),
            duration=int(pages[idx].get("duration") or data.get("duration") or 0),
            cover_url=https_media_url(str(data.get("pic") or "")),
            page=idx + 1,
            part_title=str(pages[idx].get("part", "") or "").strip(),
            pages=page_rows,
        )

    async def video_page_cids(self, bvid: str) -> list[int]:
        """视频全部分 P 的 cid 列表（与 get_video_info 同一 wbi view 数据）；无分 P 抛 BiliApiError。"""
        data = await self._get_json_signed("/x/web-interface/wbi/view", {"bvid": bvid})
        pages = data.get("pages") or []
        if not pages:
            raise BiliApiError(-400, "视频没有可用的分 P")
        return [int(p["cid"]) for p in pages]

    async def video_page_count(self, bvid: str) -> int | None:
        """#37：判断视频是否多 P（= 用户说的「合集」）。失败返回 None，调用方按单曲处理。"""
        try:
            data = await self._get_json_signed("/x/web-interface/wbi/view", {"bvid": bvid})
        except Exception:  # noqa: BLE001  风控/超时/失效都按「未知」处理，不阻塞搜索
            return None
        pages = data.get("pages") or []
        return len(pages) or None

    async def get_video_owner(self, bvid: str) -> dict:
        """视频 UP 主信息 {mid, name, face}（wbi view 同族；点 UP 名进作品页用）。"""
        data = await self._get_json_signed("/x/web-interface/wbi/view", {"bvid": bvid})
        owner = data.get("owner") or {}
        return {
            "mid": int(owner.get("mid") or 0),
            "name": str(owner.get("name") or "").strip(),
            "face": https_media_url(str(owner.get("face") or "")),
        }

    async def seasons_archives_list(
        self, mid: int, season_id: int, page_num: int = 1, page_size: int = 30
    ) -> tuple[list[dict], int]:
        """跨视频系列（合集）的视频清单（v0.5.0）；返回 (archives, 视频总数)。

        与空间投稿同族的 space 页接口，对 Referer/指纹同样敏感：带空间页
        Referer + -352/-412 短间隔重试。每条 archive 含 bvid/aid/title/pic/duration。
        """
        params = {
            "mid": mid, "season_id": season_id,
            "page_num": max(1, page_num), "page_size": max(1, min(page_size, 30)),
            "sort_reverse": "false",
        }
        headers = {"Referer": f"https://space.bilibili.com/{mid}/channel/collectiondetail?sid={season_id}"}
        last_err: BiliApiError | None = None
        for attempt in range(4):
            if attempt:
                await asyncio.sleep(1.0 if attempt == 1 else 2.0)
            try:
                data = await self._get_json_signed(
                    "/x/polymer/web-space/seasons_archives_list", params, headers=headers
                )
                break
            except BiliApiError as exc:
                if exc.code not in (-352, -412):
                    raise
                last_err = exc
        else:
            raise last_err or BiliApiError(-352, "请求被 B 站拦截，请稍后再试")
        archives = [a for a in (data.get("archives") or []) if isinstance(a, dict) and a.get("bvid")]
        total = int((data.get("page") or {}).get("total") or 0) or len(archives)
        return archives, total

    async def season_meta(self, mid: int, season_id: int) -> dict:
        """系列元信息（名称/封面/总数，v0.5.0）；best-effort，失败返回空 dict。

        seasons_series_list 一次返回 UP 主全部合集+列表，结构在不同版本间
        有差异（seasons_list.seasons_list / 顶层列表），这里做多形态兼容；
        导入方以「清单接口 + 兜底标题」为主，缺元信息不影响建容器。
        """
        headers = {"Referer": f"https://space.bilibili.com/{mid}/channel/collectionlist"}
        try:
            data = await self._get_json_signed(
                "/x/polymer/web-space/seasons_series_list", {"mid": mid}, headers=headers
            )
        except Exception:  # noqa: BLE001  元信息拿不到不阻塞导入
            return {}
        items: list[dict] = []
        for key in ("seasons_list", "series_list"):
            node = data.get(key) or {}
            items.extend(node.get(key) or [])
        items.extend(data.get("seasons") or [])
        for item in items:
            meta = item.get("meta") if isinstance(item.get("meta"), dict) else item
            try:
                if int(meta.get("season_id") or 0) == season_id:
                    return meta
            except (TypeError, ValueError):
                continue
        return {}

    async def space_arcs(self, mid: int, pn: int = 1, ps: int = 30, order: str = "pubdate") -> tuple[list[dict], int]:
        """UP 主投稿列表（wbi arc/search）；返回 (vlist, 投稿总数)。

        order: pubdate=最新发布 / click=最多播放；该接口间歇性 -352 风控
        （对 Referer/指纹敏感）：带空间页 Referer + 短间隔自动重试。
        """
        params = {"mid": mid, "pn": max(1, pn), "ps": ps, "tid": 0, "keyword": "", "order": order}
        headers = {"Referer": f"https://space.bilibili.com/{mid}/video"}
        last_err: BiliApiError | None = None
        for attempt in range(4):
            if attempt:
                await asyncio.sleep(1.0 if attempt == 1 else 2.0)
            try:
                data = await self._get_json_signed("/x/space/wbi/arc/search", params, headers=headers)
                break
            except BiliApiError as exc:
                if exc.code not in (-352, -412):
                    raise
                last_err = exc
        else:
            raise last_err or BiliApiError(-352, "请求被 B 站拦截，请稍后再试")
        vlist = (data.get("list") or {}).get("vlist") or []
        items = [v for v in vlist if isinstance(v, dict) and v.get("bvid")]
        total = int((data.get("page") or {}).get("count") or 0)
        return items, total

    async def get_audio_streams(self, bvid: str, cid: int) -> list[AudioStream]:
        # playurl 解析结果缓存：浏览器 audio 的分段 Range 请求会反复回源，
        # 每次都现解析会高频触发 B 站 playurl 风控（表现为播放卡住）。
        cache = self._playurl_cache.setdefault((bvid, cid), (0.0, []))
        import time as _time

        if cache[1] and _time.monotonic() - cache[0] < 600:
            return cache[1]
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
        self._playurl_cache[(bvid, cid)] = (_time.monotonic(), streams)
        return streams

    # ---- 字幕（歌词来源之一） ----

    async def get_subtitle_tracks(self, bvid: str, aid: int, cid: int) -> list[dict]:
        """视频字幕轨列表 [{id, lan, lan_doc, ai_type, subtitle_url}]。

        与 playurl 同族的 player/wbi/v2 接口；人工 CC 无需登录即可见，
        AI 字幕（ai_type=1）必须带登录 cookie，否则 subtitles 为空。
        """
        params: dict = {"bvid": bvid, "cid": cid}
        if aid:
            params["aid"] = aid
        data = await self._get_json_signed("/x/player/wbi/v2", params)
        subtitle = data.get("subtitle") or {}
        tracks = subtitle.get("subtitles") or []
        return [t for t in tracks if isinstance(t, dict) and t.get("subtitle_url")]

    async def download_subtitle_body(self, url: str) -> list[dict]:
        """下载字幕 JSON（hdslb CDN），返回行列表 [{from, to, content}]。"""
        if url.startswith("//"):  # 接口下发的是协议相对地址
            url = "https:" + url
        validate_bilibili_url(url)
        resp = await self.http.get(url)
        resp.raise_for_status()
        try:
            payload = resp.json()
        except ValueError:
            return []
        body = payload.get("body") or []
        return [line for line in body if isinstance(line, dict)]

    # ---- 搜索 ----

    async def search_videos(self, keyword: str, page: int = 1) -> list[SearchHit]:
        """关键词搜索 B 站视频：WBI 签名综合搜索，只取视频分区（默认首页约 20 条）。"""
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        data = await self._get_json_signed(
            "/x/web-interface/wbi/search/all/v2",
            {"keyword": keyword, "page": max(1, page)},
        )
        for block in data.get("result") or []:
            if block.get("result_type") != "video":
                continue
            hits = []
            for item in block.get("data") or []:
                bvid = str(item.get("bvid") or "")
                if not bvid:
                    continue  # 直播/课程等非视频条目或已失效
                hits.append(
                    SearchHit(
                        bvid=bvid,
                        avid=int(item.get("aid") or 0),
                        title=strip_highlight(str(item.get("title", ""))).strip(),
                        artist=str(item.get("author", "")).strip(),
                        duration=parse_duration_text(item.get("duration")),
                        cover_url=https_media_url(str(item.get("pic") or "")),
                        play=int(item.get("play") or 0),
                    )
                )
            return hits
        return []

    async def search_users(self, keyword: str, limit: int = 5) -> list[dict]:
        """关键词搜索 B 站 UP 主（bili_user 类型搜索，搜索框联动用）。"""
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        data = await self._get_json_signed(
            "/x/web-interface/wbi/search/type",
            {"keyword": keyword, "search_type": "bili_user"},
        )
        out = []
        for item in (data.get("result") or [])[:limit]:
            mid = int(item.get("mid") or 0)
            if not mid:
                continue
            face = item.get("upic") or item.get("face") or ""
            out.append(
                {
                    "mid": mid,
                    "name": strip_highlight(str(item.get("uname") or "")).strip(),
                    "sign": str(item.get("usign") or "").strip(),
                    "fans": int(item.get("fans") or 0),
                    "face": https_media_url(str(face)),
                }
            )
        return out

    async def get_user_card(self, mid: int) -> dict:
        """用户卡片信息（mid → name/face），打开 UP 主页用。"""
        data = await self._get_json_signed(
            "/x/web-interface/card", {"mid": int(mid), "photo": "true"}
        )
        card = data.get("card") or {}
        return {
            "mid": int(card.get("mid") or mid),
            "name": str(card.get("name") or "").strip(),
            "face": https_media_url(str(card.get("face") or "").strip()),
            "sign": str(card.get("sign") or "").strip(),
        }

    # ---- 推荐 ----

    async def related_videos(self, aid: int) -> list[dict]:
        """相关视频推荐（B 站协同过滤结果）；data 直接是视频字典列表。"""
        data = await self._get_json_signed(
            "/x/web-interface/archive/related", {"aid": aid}
        )
        return data if isinstance(data, list) else []

    async def video_tags(self, bvid: str) -> list[str]:
        """视频标签名列表（风格画像/分类用）。"""
        data = await self._get_json("/x/tag/archive/tags", {"bvid": bvid})
        if not isinstance(data, list):
            return []
        return [str(t.get("tag_name") or "").strip() for t in data if isinstance(t, dict)]

    async def music_rank(self, rid: int = 3) -> list[dict]:
        """分区排行榜（ranking/v2，音乐区 rid=3；无需 WBI 签名）。"""
        data = await self._get_json("/x/web-interface/ranking/v2", {"rid": rid, "type": "all"})
        return data.get("list") or []

    async def region_videos(self, rid: int, ps: int = 50) -> list[dict]:
        """子分区热门视频（dynamic/region，如演奏 59 / MV 30 / 音乐现场 31 / 音乐综合 28）。"""
        data = await self._get_json("/x/web-interface/dynamic/region", {"rid": rid, "ps": ps})
        return data.get("archives") or []

    async def my_info(self) -> dict:
        """当前登录用户信息（nav：mid/uname/face 等），进程内缓存 10 分钟；失败返回空 dict。"""
        if not self.store.logged_in:
            return {}
        now = time.time()
        if self._me and now < self._me[0]:
            return self._me[1]
        try:
            data = await self._get_json("/x/web-interface/nav")
            self._me = (now + 600, data or {})
        except Exception:
            self._me = (now + 60, {})  # 失败短缓存，避免每次请求都打接口
        return self._me[1]

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
        """拉取收藏夹内的视频条目（已失效或非视频条目自动过滤）。

        终止条件用响应里的 `has_more`——`/x/v3/fav/resource/list` **不返回**
        `media_count`（它在 `info` 里），旧代码拿它当终止条件会得到 0，
        导致永远只翻第一页 20 条（多端同步各自只拿到子集的根因）。
        """
        out: list[dict] = []
        pn = 1
        max_pages = max(1, cap // 20 + 1)  # ps=20；按 cap 放开页数，不再硬编码 50 页
        while len(out) < cap and pn <= max_pages:
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
            # 无更多页 / 本页空 / 已凑够目标数 → 停
            if not medias or not data.get("has_more"):
                break
            info_total = int((data.get("info") or {}).get("media_count") or 0)
            if info_total and len(out) >= info_total:
                break
            pn += 1
        return out

    # ---- 账号 ----

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

    async def verify_login(self) -> dict:
        """登录/恢复时向 nav 实时核验身份，不能使用旧账号或失败响应的缓存。"""
        if not self.store.logged_in:
            raise BiliApiError(-101, "未取得 B 站登录态，请重新登录")
        data = await self._get_json("/x/web-interface/nav")
        mid = str(data.get("mid") or "")
        if not data.get("isLogin") or not mid.isascii() or not mid.isdigit() or int(mid) <= 0:
            raise BiliApiError(-101, "B 站登录态未生效，请重新登录")
        cookie_mid = self.store.get("DedeUserID") or self.store.get("dedeuserid")
        if cookie_mid and cookie_mid != mid:
            raise BiliApiError(-101, "B 站登录凭据与账号不一致，请重新登录")
        self.store.set_many({"mid": mid})
        self._me = (time.time() + 600, data)
        return data

    # ---- 收藏夹池（曲库的 B 站侧存储） ----

    async def list_library_folders(self, refresh: bool = False) -> list[dict]:
        """账号下所有曲库夹（bilimusic / bilimusicN）：[{id, title, count}]，按序排列。"""
        if not refresh and self._folders and time.monotonic() - self._folders[0] < _FOLDERS_TTL:
            return self._folders[1]
        mid = await self.get_my_mid()
        data = await self._get_json_signed(
            "/x/v3/fav/folder/created/list-all", {"up_mid": mid, "jsonp": "jsonp"}
        )
        raw = data.get("list", []) if isinstance(data, dict) else (data or [])
        folders = [
            {
                "id": int(f["id"]),
                "title": str(f.get("title") or "").strip(),
                "count": int(f.get("media_count") or 0),
            }
            for f in raw
            if _FOLDER_RE.match(str(f.get("title") or "").strip().lower())
        ]
        folders.sort(key=lambda f: folder_sort_key(f["title"]))
        self._folders = (time.monotonic(), folders)
        return folders

    async def favorite_into(
        self, aid: int, folder_ids: list[int], next_title=None
    ) -> int:
        """收藏单曲进指定夹组中第一个未满的夹；全满且提供 next_title 时自动建新夹。

        返回实际入的夹 id；收藏失败（夹被删/刚好已满）时刷新夹池重试一次。
        """
        folder_id = await self._pick_in(aid, folder_ids, next_title)
        try:
            await self.fav_add(aid, folder_id)
        except BiliApiError:
            self._folders = None
            folder_id = await self._pick_in(aid, folder_ids, next_title)
            await self.fav_add(aid, folder_id)
        return folder_id

    async def _pick_in(self, aid: int, folder_ids: list[int], next_title=None) -> int:
        async with self._fav_lock:
            all_folders = {f["id"]: f for f in await self.list_library_folders()}
            candidates = [all_folders[i] for i in folder_ids if i in all_folders]
            for f in candidates:
                if f["count"] < _FOLDER_CAP:
                    return f["id"]
            if next_title is None:
                if candidates:
                    return candidates[0]["id"]  # 全满又不能建夹：兜底首夹
                raise BiliApiError(-400, "歌单没有可用的收藏夹（可能已被删除）")
            return await self.create_fav_folder(next_title([f["title"] for f in candidates]))

    async def rename_folder(self, media_id: int, title: str) -> None:
        """重命名收藏夹（B 站标题上限约 20 字，超长返回 11001）。"""
        await self._post_json(
            "/x/v3/fav/folder/edit",
            {"media_id": media_id, "title": title, "privacy": 0, "csrf": self._csrf()},
        )
        self._folders = None

    async def delete_folder(self, media_id: int) -> None:
        """删除收藏夹（歌单删除场景用；注意夹内收藏一并消失）。"""
        await self._post_json(
            "/x/v3/fav/folder/del", {"media_ids": str(media_id), "csrf": self._csrf()}
        )
        self._folders = None

    async def ensure_fav_folder(self) -> int:
        """默认歌单主夹「bilimusic」的 id；不存在则创建。"""
        folders = await self.list_library_folders()
        for f in folders:
            if f["title"].strip().lower() == FAV_FOLDER_NAME:
                return f["id"]
        return await self.create_fav_folder(FAV_FOLDER_NAME)

    async def favorite_song(self, aid: int) -> int:
        """收藏单曲进默认歌单夹池（主夹 bilimusic + 编号溢出夹），返回实际入的夹 id。"""
        main_id = await self.ensure_fav_folder()
        ids = [
            f["id"]
            for f in await self.list_library_folders()
            if f["id"] == main_id or re.match(r"^bilimusic\d+$", f["title"])
        ]
        return await self.favorite_into(aid, ids, next_folder_title)

    async def fav_remove(self, aid: int, media_id: int) -> None:
        """把视频移出指定收藏夹（rid 为 av 号，type=2 稿件）。"""
        await self._post_json(
            "/x/v3/fav/resource/deal",
            {
                "rid": aid,
                "type": 2,
                "del_media_ids": str(media_id),
                "csrf": self._csrf(),
            },
        )

    async def unfavorite_song(self, aid: int, folder_id: int = 0) -> int:
        """删歌时同步取消收藏：从曲库夹移除单曲，返回移除的夹数。

        folder_id 已知（入库时记录）直接删；未知（旧数据）时在夹池内
        按页有界查找，避免大夹全量翻页拖慢删除。
        """
        if folder_id:
            await self.fav_remove(aid, folder_id)
            return 1
        removed = 0
        budget = _UNFAV_SCAN_PAGES
        for f in await self.list_library_folders():
            if budget <= 0:
                break
            hit, pages = await self._find_in_folder(f["id"], aid, budget)
            budget -= pages
            if hit:
                await self.fav_remove(aid, f["id"])
                removed += 1
        return removed

    async def find_in_folder(self, media_id: int, aid: int, max_pages: int = 50) -> bool:
        """单曲是否在指定收藏夹内（对账删除前的二次核实）。"""
        found, _ = await self._find_in_folder(media_id, aid, max_pages)
        return found

    async def _find_in_folder(self, media_id: int, aid: int, max_pages: int) -> tuple[bool, int]:
        """按页在收藏夹里查找 aid，返回 (是否找到, 实际翻页数)。"""
        pn = 1
        while pn <= max_pages:
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
            medias = data.get("medias") or []
            if any(int(item.get("id") or 0) == aid for item in medias):
                return True, pn
            if len(medias) < 20:
                return False, pn
            pn += 1
        return False, max_pages

    async def create_fav_folder(self, title: str) -> int:
        """创建公开收藏夹，返回 media_id。"""
        data = await self._post_json(
            "/x/v3/fav/folder/add",
            {"title": title, "privacy": 0, "csrf": self._csrf()},
        )
        self._folders = None
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

    def _accept_login(self, resp: httpx.Response, data: dict) -> dict[str, str]:
        cookies = login_cookies({cookie.name: cookie.value for cookie in resp.cookies.jar})
        # 部分 passport 响应把凭据放在成功回调 URL，而非 Set-Cookie。
        callback = urlsplit(str(data.get("url") or ""))
        host = callback.hostname or ""
        if callback.scheme in ("http", "https") and (host == "bilibili.com" or host.endswith(".bilibili.com")):
            fallback = login_cookies(dict(parse_qsl(callback.query)))
            cookies = {**fallback, **cookies}
        if not cookies.get("SESSDATA") or not cookies.get("bili_jct"):
            self._reset_http_cookies()
            raise BiliApiError(-101, "B 站未返回完整登录凭据，请重新登录")
        self.store.replace_login(cookies)
        self._reset_http_cookies()
        self._me = None
        self._folders = None
        return cookies

    # ---- 短信验证码登录（passport 极验 v3：前端滑块拿三件套，后端只转发） ----

    async def captcha_get(self) -> dict:
        """登录用极验参数：{token(captcha_key), geetest:{gt, challenge}}。

        passport 接口偶发 ConnectTimeout（尤其经代理/VPN 时，实测 3 次里 1 次超时），
        这里重试 3 次再放弃，避免手机端一上来就「验证参数获取失败」。
        """
        last: Exception | None = None
        for attempt in range(3):
            try:
                return await self._get_json(
                    _PASSPORT + "/x/passport-login/captcha", {"source": "main-web"},
                    timeout=5.0,  # 短超时：失败也快，别让用户干等 20s 才重试
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last = exc
                await asyncio.sleep(0.4 * (attempt + 1))
        raise BiliApiError(-500, f"验证服务连不上（{type(last).__name__}），请检查网络后重试")

    async def sms_send(
        self, tel: str, cid: str = "86", *, token: str = "",
        challenge: str = "", validate: str = "", seccode: str = "",
    ) -> dict:
        """发送短信验证码（字段名对齐 B 站官方前端：token=极验captcha的token，三件套平铺）。

        成功响应 data.captcha_key 供登录接口使用。
        """
        resp = await self.http.post(
            _PASSPORT + "/x/passport-login/web/sms/send",
            data={
                "cid": cid, "tel": tel, "source": "main-web",
                "token": token, "challenge": challenge,
                "validate": validate, "seccode": seccode,
            },
        )
        payload = self._parse_json_response(resp)
        return payload

    async def sms_login(self, tel: str, code: str, captcha_key: str, cid: str = "86") -> dict:
        """短信验证码登录（端点 /web/login/sms，带发送时返回的 captcha_key）；成功即写入 CookieStore。"""
        resp = await self.http.post(
            _PASSPORT + "/x/passport-login/web/login/sms",
            data={
                "cid": cid, "tel": tel, "code": code,
                "captcha_key": captcha_key, "source": "main-web",
            },
        )
        data = self._parse_json_response(resp)
        if data.get("status") != 0:
            self._reset_http_cookies()
            raise BiliApiError(-101, "B 站登录尚未完成，请先在 B 站完成账号验证后重试")
        cookies = self._accept_login(resp, data)
        return {"cookies": list(cookies)}

    async def qrcode_generate(self) -> QrCode:
        data = await self._get_json(_PASSPORT + "/x/passport-login/web/qrcode/generate")
        img = qrcode.QRCode(border=1)
        img.add_data(data["url"])
        img.make(fit=True)
        buf = io.BytesIO()
        img.make_image(fill_color="black", back_color="white").save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        return QrCode(
            url=data["url"],
            qrcode_key=data["qrcode_key"],
            png_data_url=f"data:image/png;base64,{b64}",
            matrix=[("1" if cell else "0") for row in img.get_matrix() for cell in row],
            modules=img.modules_count,
        )

    async def qrcode_poll(self, qrcode_key: str) -> QrPoll:
        resp = await self.http.get(
            _PASSPORT + "/x/passport-login/web/qrcode/poll",
            params={"qrcode_key": qrcode_key},
        )
        data = self._parse_json_response(resp)
        code = int(data.get("code", -1))
        if code == 0:
            cookies = self._accept_login(resp, data)
            return QrPoll(status="confirmed", cookies=cookies)
        if code not in _QR_STATUS:
            raise BiliApiError(code, data.get("message") or "B 站登录失败，请重新生成二维码")
        return QrPoll(status=_QR_STATUS[code])

    async def login_status(self) -> dict:
        """校验当前登录态是否仍有效。"""
        if not self.store.logged_in:
            return {"loggedIn": False}
        data = await self._get_json("/x/web-interface/nav", ok_codes=(0, -101))
        if not data.get("isLogin"):
            self.logout()
        return {"loggedIn": bool(data.get("isLogin")), "username": data.get("uname") or ""}

    def logout(self) -> None:
        self.store.clear_login()
        self._folders = None
        self._me = None
        self._reset_http_cookies()
