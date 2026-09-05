"""B 站音乐分区电台：从 B 站音乐区内容直接生成"推荐歌单"（不下载，实时流播放）。

- B站热歌榜：ranking/v2 rid=3（音乐区排行榜，96 行，无需 WBI）
- 音乐区新上架：newlist rid=3（主分区最新上传；dynamic/region 已废弃返回 -404，子分区不可用）
- 主题电台：search_videos 关键词搜索（搜索接口实测稳定，风控由调用侧缓存兜底）
- 时长过滤复用 recs.is_song_like，只留"像一首歌"的
- 进程内 TTL 缓存：成功 10 分钟，失败 60 秒（失败返回空列表，页面优雅空态后重试）
"""

import time

from app.bili.client import BiliClient, SearchHit, strip_highlight
from app.services.recs import is_song_like

CACHE_TTL_OK = 600
CACHE_TTL_FAIL = 60

# (key, 搜索关键词, 卡片名)；rank/nl3 走专用接口不走搜索
RADIOS: list[tuple[str, str, str]] = [
    ("rank", "", "B站热歌榜"),
    ("nl3", "", "音乐区·新上架"),
    ("s-piano", "钢琴 演奏", "钢琴·纯音乐"),
    ("s-guitar", "吉他弹唱", "吉他弹唱精选"),
    ("s-cover", "翻唱 现场", "热门翻唱"),
    ("s-gufeng", "古风 翻唱", "古风电台"),
    ("s-jazz", "爵士 乐队", "爵士电台"),
    ("s-edm", "电子音乐 舞曲", "电子舞曲台"),
]

_cache: dict[str, tuple[float, list[dict]]] = {}


def _norm_video(v: dict, genre: str) -> dict | None:
    bvid = str(v.get("bvid") or "")
    duration = int(v.get("duration") or 0)
    if not bvid or not is_song_like(duration):
        return None
    return {
        "bvid": bvid,
        "title": strip_highlight(str(v.get("title") or "")).strip(),
        "artist": str((v.get("owner") or {}).get("name") or "").strip(),
        "duration": duration,
        "cover_url": str(v.get("pic") or ""),
        "genre": genre,
    }


def _norm_hit(h: SearchHit, genre: str) -> dict | None:
    if not h.bvid or not is_song_like(h.duration):
        return None
    return {
        "bvid": h.bvid,
        "title": h.title,
        "artist": h.artist,
        "duration": h.duration,
        "cover_url": h.cover_url,
        "genre": genre,
    }


def _cached(key: str) -> list[dict] | None:
    hit = _cache.get(key)
    if hit and time.time() < hit[0]:
        return hit[1]
    return None


def _store(key: str, items: list[dict], ttl: float) -> list[dict]:
    _cache[key] = (time.time() + ttl, items)
    return items


def is_zone_key(key: str) -> bool:
    return key == "rank" or key.startswith("nl") or key.startswith("s-")


def radio_name(key: str) -> str:
    for k, _kw, name in RADIOS:
        if k == key:
            return name
    return "电台"


async def items_for(bili: BiliClient, key: str) -> list[dict]:
    hit = _cached(key)
    if hit is not None:
        return hit
    try:
        if key == "rank":
            rows = await bili.music_rank(rid=3)
            name = radio_name(key)
            return _store(key, [n for v in rows if (n := _norm_video(v, name))], CACHE_TTL_OK)
        if key == "nl3":
            data = await bili._get_json("/x/web-interface/newlist", {"rid": 3, "ps": 50})
            rows = (data or {}).get("archives") or []
            name = radio_name(key)
            return _store(key, [n for v in rows if (n := _norm_video(v, name))], CACHE_TTL_OK)
        radio = next((r for r in RADIOS if r[0] == key), None)
        if radio is None:
            return []
        _key, keyword, name = radio
        hits = await bili.search_videos(keyword)
        return _store(key, [n for h in hits if (n := _norm_hit(h, name))], CACHE_TTL_OK)
    except Exception:
        return _store(key, [], CACHE_TTL_FAIL)  # 失败短缓存：页面空态，下轮重试
