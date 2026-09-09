"""分享链接拼装（#25）：把本地对象映射成真实 B 站链接。

只做纯字符串映射（不碰网络/数据库），便于单测。缺关键字段时返回空串，
由调用方决定兜底文案——分享链路不允许拼出半截链接（如 `video/sid:123`）。
"""

from urllib.parse import quote

SERIES_PREFIX = "sid:"


def video_link(bvid: str) -> str:
    """单曲 / 多 P 专辑：B 站视频页（自带 B 站预览卡）。"""
    bvid = (bvid or "").strip()
    return f"https://www.bilibili.com/video/{quote(bvid, safe='')}" if bvid else ""


def fav_folder_link(mid: int, fid: int) -> str:
    """歌单 / 曲库：对应 B 站收藏夹。"""
    if mid <= 0 or fid <= 0:
        return ""
    return f"https://space.bilibili.com/{mid}/favlist?fid={fid}"


def series_link(mid: int, sid: int) -> str:
    """跨视频系列（合集）。"""
    if mid <= 0 or sid <= 0:
        return ""
    return f"https://space.bilibili.com/{mid}/channel/collectiondetail?sid={sid}"


def series_sid(source_bvid: str) -> int:
    """从容器键 `sid:<id>` 取系列 id；不是系列键返回 0。"""
    key = (source_bvid or "").strip()
    if not key.startswith(SERIES_PREFIX):
        return 0
    try:
        return int(key[len(SERIES_PREFIX):])
    except ValueError:
        return 0


def album_share_url(kind: str, source_bvid: str, mid: int = 0) -> str:
    """专辑/合集的分享链接；系列缺 mid 时返回空串（调用方回填后重试）。"""
    if kind == "series":
        return series_link(mid, series_sid(source_bvid))
    return video_link(source_bvid)
