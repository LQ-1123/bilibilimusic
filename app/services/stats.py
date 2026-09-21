"""B6 轻量听歌统计：播放流水的纯聚合。本地数据、零算法。

口径：一次「有效收听」= 客户端实际听满 30s 或自然播完（跳过不计）；
分钟数用真实收听秒数（listened）累加，不拿歌曲时长凑数。
"""

from datetime import datetime, timedelta, timezone

from sqlmodel import select

from app.db.models import PlayLog
from app.db.session import new_session

# 汇总上限：个人应用一年流水也就几万行，够用了
_MAX_ROWS = 50000
_TOP_SONGS = 8
_TOP_ARTISTS = 5
_HISTORY_TOP = 10   # 播放历史页「最常听」曲目数（全量口径，不限本周）
_HISTORY_RECENT = 60  # 播放历史页「最近播放」流水条数


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
                skey, {"title": r.title, "artist": r.artist, "plays": 0, "seconds": 0,
                       "bvid": r.bvid, "cid": r.cid}
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


def history() -> dict:
    """播放历史页（v2.3 重设计，替代旧的柱状图统计视图）：纯流水，三块内容——
    累计收听时长 / 最常听全量 Top N（组成可播放的歌单）/ 最近播放按天分组。
    与 summary()（手机账号卡片沿用）分道：不做周聚合，也不做条形图。
    时刻转服务器本地时区展示（内嵌后端跑在用户设备上，本地时区即用户时区）。
    封面由路由层按曲库回填（本地封面的 /api/songs/{id}/cover 与 token 逻辑在那侧）。
    """
    with new_session() as session:
        rows = session.exec(
            select(PlayLog).order_by(PlayLog.played_at.desc()).limit(_MAX_ROWS)
        ).all()

    total_seconds = 0
    total_songs: set[str] = set()
    song_buckets: dict[str, dict] = {}
    for r in rows:
        seconds = max(0, r.listened)
        total_seconds += seconds
        total_songs.add(r.bvid or r.title)
        if not r.bvid:
            continue
        bucket = song_buckets.setdefault(r.bvid, {
            "title": r.title, "artist": r.artist, "bvid": r.bvid, "cid": r.cid,
            "plays": 0, "seconds": 0, "cover": r.cover or "",
        })
        bucket["plays"] += 1
        bucket["seconds"] += seconds

    top = sorted(song_buckets.values(), key=lambda x: -x["plays"])[:_HISTORY_TOP]
    for t in top:
        t["minutes"] = t["seconds"] // 60
        del t["seconds"]

    # 最近播放：新→旧逐条入组；同一天自然聚在一起（rows 已按时间倒序）
    now_local = datetime.now(timezone.utc).astimezone()
    today_local = now_local.date()
    groups: list[dict] = []
    by_label: dict[str, dict] = {}
    for r in rows[:_HISTORY_RECENT]:
        local = r.played_at.replace(tzinfo=timezone.utc).astimezone()
        d = local.date()
        if d == today_local:
            label = "今天"
        elif d == today_local - timedelta(days=1):
            label = "昨天"
        else:
            label = f"{d.month}月{d.day}日"
        item = {
            "title": r.title, "artist": r.artist, "bvid": r.bvid, "cid": r.cid,
            "cover": r.cover or "", "at": local.strftime("%H:%M"),
        }
        if label in by_label:
            by_label[label]["items"].append(item)
        else:
            group = {"label": label, "items": [item]}
            by_label[label] = group
            groups.append(group)

    return {
        "total": {"plays": len(rows), "minutes": total_seconds // 60, "songs": len(total_songs)},
        "top": top,
        "recent": groups,
    }


def backfill_covers(covers: dict[str, str]) -> None:
    """把懒取的封面写回流水（按 bvid 只补空值行）：第一次出页外呼一次，此后零外呼。"""
    if not covers:
        return
    with new_session() as session:
        for bvid, cover in covers.items():
            if not cover:
                continue
            rows = session.exec(
                select(PlayLog).where(PlayLog.bvid == bvid, PlayLog.cover == "")  # type: ignore[arg-type]
            ).all()
            for r in rows:
                r.cover = cover
        session.commit()
