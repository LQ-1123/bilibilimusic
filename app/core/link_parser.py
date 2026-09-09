"""分享文本 / 链接 → BV 号（或 av 号）+ 分 P 页码。

兼容输入：
- B 站 App 分享文本：【标题】 https://b23.tv/xxxx （分享自 哔哩哔哩客户端）
- 短链 b23.tv/xxxx（302 跳转逐跟随，每一跳过 url_guard 校验）
- 明链 www.bilibili.com/video/BVxxxx?p=n、b23.tv/BVxxxx
- 裸 BV 号文本
- 系列明链 space.bilibili.com/{mid}/channel/collectiondetail?sid=N → SeriesRef（v0.5.0）
"""

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx

from app.core.url_guard import BILIBILI_SUFFIXES, UnsafeUrlError, validate_url

URL_RE = re.compile(r"https?://[^\s\"'<>【】，。；！？]+", re.IGNORECASE)
BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")
AV_RE = re.compile(r"(?<!\w)av(\d{1,15})(?!\d)", re.IGNORECASE)
VIDEO_PATH_RE = re.compile(r"/video/(BV[0-9A-Za-z]{10}|av\d+)", re.IGNORECASE)
FAV_FID_RE = re.compile(r"[?&]fid=(\d+)")
SERIES_PATH_RE = re.compile(r"^/(\d+)/channel/collectiondetail/?$", re.IGNORECASE)

_REDIRECT_CODES = (301, 302, 303, 307, 308)
_MAX_REDIRECT_HOPS = 5


@dataclass
class VideoRef:
    bvid: str | None = None
    avid: int | None = None
    page: int = 1


@dataclass
class SeriesRef:
    """B 站跨视频系列（合集）：space.bilibili.com/{mid}/channel/collectiondetail?sid=N。"""

    sid: int
    mid: int = 0


def parse_video_url(url: str) -> VideoRef | None:
    """静态解析明链；不是视频链接返回 None。"""
    parts = urlsplit(url)
    qs = parse_qs(parts.query)
    page = 1
    if qs.get("p"):
        try:
            page = max(1, int(qs["p"][0]))
        except ValueError:
            page = 1

    m = VIDEO_PATH_RE.search(parts.path)
    if m:
        vid = m.group(1)
        if vid.lower().startswith("av"):
            return VideoRef(avid=int(vid[2:]), page=page)
        return VideoRef(bvid=vid, page=page)

    # b23.tv/BVxxxx 形式的短链（路径本身携带 BV 号，无需跳转）
    host = (parts.hostname or "").lower()
    if host == "b23.tv" or host.endswith(".b23.tv"):
        m = BV_RE.search(parts.path)
        if m:
            return VideoRef(bvid=m.group(0), page=page)
    return None


def parse_fav_id(text: str) -> int | None:
    """从收藏夹链接/文本中提取 fid（即收藏夹 media_id）。"""
    m = FAV_FID_RE.search(text or "")
    return int(m.group(1)) if m else None


def parse_series_url(url: str) -> SeriesRef | None:
    """静态解析系列明链；不是系列链接返回 None。

    形如 https://space.bilibili.com/12345/channel/collectiondetail?sid=678
    （「列表」系列 seriesdetail 是另一套接口，本期不支持）。
    """
    parts = urlsplit(url or "")
    host = (parts.hostname or "").lower()
    if host not in ("space.bilibili.com", "www.space.bilibili.com"):
        return None
    m = SERIES_PATH_RE.match(parts.path)
    if not m:
        return None
    qs = parse_qs(parts.query)
    try:
        sid = int(qs["sid"][0])
    except (KeyError, IndexError, ValueError):
        return None
    if sid <= 0:
        return None
    try:
        mid = int(m.group(1))
    except ValueError:
        mid = 0
    return SeriesRef(sid=sid, mid=mid)


async def follow_redirects(
    client: httpx.AsyncClient,
    url: str,
    *,
    stop=None,
    max_hops: int = _MAX_REDIRECT_HOPS,
) -> str:
    """跟随重定向直到终点或 stop(url) 命中；每一跳都过安全校验，返回最终 URL。"""
    current = validate_url(url, suffix_allowlist=BILIBILI_SUFFIXES)
    if stop and stop(current):
        return current
    for _ in range(max_hops):
        resp = await client.get(current)
        if resp.status_code not in _REDIRECT_CODES:
            break
        location = resp.headers.get("location", "")
        if not location:
            break
        current = urljoin(current, location)
        current = validate_url(current, suffix_allowlist=BILIBILI_SUFFIXES)
        if stop and stop(current):
            break
    return current


async def _resolve_single_url(client: httpx.AsyncClient, url: str) -> VideoRef | SeriesRef | None:
    direct: VideoRef | SeriesRef | None = parse_series_url(url) or parse_video_url(url)
    if direct:
        return direct
    final = await follow_redirects(client, url, stop=lambda u: parse_series_url(u) or parse_video_url(u))
    return parse_series_url(final) or parse_video_url(final)


async def resolve_target(client: httpx.AsyncClient, text: str) -> VideoRef | SeriesRef:
    """从任意分享文本中解析出视频或系列引用；失败抛 ValueError（文案可直接展示）。"""
    text = (text or "").strip()
    if not text:
        raise ValueError("分享内容为空")

    # 命中裸 BV 号的快速路径
    m = BV_RE.search(text)
    if m and "http" not in text.split(m.group(0), 1)[0][-8:]:
        return VideoRef(bvid=m.group(0))

    urls = URL_RE.findall(text)
    if not urls:
        if m:
            return VideoRef(bvid=m.group(0))
        raise ValueError("分享内容中没有找到链接")

    last_error: Exception | None = None
    for url in urls:
        try:
            ref = await _resolve_single_url(client, url)
        except UnsafeUrlError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
            continue
        if ref:
            return ref
    raise ValueError(f"链接不是可识别的 B 站视频/系列：{last_error or '未知原因'}")


async def resolve_share_text(client: httpx.AsyncClient, text: str) -> VideoRef:
    """视频版解析（系列链接在这里抛 ValueError）；系列导入走 resolve_target。"""
    ref = await resolve_target(client, text)
    if not isinstance(ref, VideoRef):
        raise ValueError("这是系列（合集）链接，请通过支持合集的入口导入")
    return ref
