"""B6 轻量听歌统计：播放流水的纯聚合。本地数据、零算法。

口径：一次「有效收听」= 客户端实际听满 30s 或自然播完（跳过不计）；
分钟数用真实收听秒数（listened）累加，不拿歌曲时长凑数。
"""

from datetime import datetime, timedelta

from sqlmodel import select

from app.db.models import PlayLog
from app.db.session import new_session

# 汇总上限：个人应用一年流水也就几万行，够用了
_MAX_ROWS = 50000
_TOP_SONGS = 8
_TOP_ARTISTS = 5


def _fmt_day(d: datetime) -> str:
    return f"{d.month}/{d.day}"


def summary() -> dict:
    """全量聚合：本周/今日/累计、近 7 天条形、本周最常听。"""
    with new_session() as session:
        rows = session.exec(
            select(PlayLog).order_by(PlayLog.played_at.desc()).limit(_MAX_ROWS)
        ).all()

    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=now.weekday())  # 本周一（UTC，与全库口径一致）

    week_plays = week_minutes = 0
    week_songs: set[str] = set()
    today_plays = today_minutes = 0
    total_plays = total_minutes = 0
    total_songs: set[str] = set()
    day_buckets: dict[str, dict] = {}
    song_buckets: dict[str, dict] = {}
    artist_buckets: dict[str, dict] = {}

    for i in range(7):
        d = today_start - timedelta(days=i)
        day_buckets[d.strftime("%Y-%m-%d")] = {"label": _fmt_day(d), "plays": 0, "minutes": 0}

    for r in rows:
        at = r.played_at
        seconds = max(0, r.listened)
        total_plays += 1
        total_minutes += seconds
        total_songs.add(r.bvid or r.title)
        if at >= week_start:
            week_plays += 1
            week_minutes += seconds
            week_songs.add(r.bvid or r.title)
            skey = r.bvid or f"t:{r.title}"
            bucket = song_buckets.setdefault(
                skey, {"title": r.title, "artist": r.artist, "plays": 0, "seconds": 0}
            )
            bucket["plays"] += 1
            bucket["seconds"] += seconds
            if r.artist:
                ab = artist_buckets.setdefault(r.artist, {"artist": r.artist, "plays": 0})
                ab["plays"] += 1
        if at >= today_start:
            today_plays += 1
            today_minutes += seconds
        dkey = at.strftime("%Y-%m-%d")
        if dkey in day_buckets:
            day_buckets[dkey]["plays"] += 1
            day_buckets[dkey]["minutes"] += seconds // 60

    top_songs = sorted(song_buckets.values(), key=lambda x: -x["plays"])[:_TOP_SONGS]
    for t in top_songs:
        t["minutes"] = t["seconds"] // 60
        del t["seconds"]

    return {
        "week": {
            "plays": week_plays,
            "minutes": week_minutes // 60,
            "songs": len(week_songs),
        },
        "today": {"plays": today_plays, "minutes": today_minutes // 60},
        "total": {
            "plays": total_plays,
            "minutes": total_minutes // 60,
            "songs": len(total_songs),
        },
        "days": [day_buckets[k] for k in sorted(day_buckets.keys())],
        "topSongs": top_songs,
        "topArtists": sorted(artist_buckets.values(), key=lambda x: -x["plays"])[:_TOP_ARTISTS],
    }
