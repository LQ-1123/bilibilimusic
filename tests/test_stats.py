"""B6 听歌统计：流水上报 + 聚合口径（本周/今日/近7天/最常听/分钟用真实收听秒数）。"""

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlmodel import select

from app.api.routes import PlayLogIn, log_play, stats_summary
from app.config import settings
from app.db import session as dbs
from app.db.models import PlayLog
from app.services import stats


@pytest.fixture
def db_env(tmp_path, monkeypatch):
    for name, value in {
        "data_dir": tmp_path, "db_path": tmp_path / "bilibili_music.db",
        "cookie_path": tmp_path / "cookies.json", "music_dir": tmp_path / "music",
        "cover_dir": tmp_path / "covers", "api_token": "",
    }.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(dbs, "_engines", {})
    monkeypatch.setattr(dbs, "_current_mid", None)
    dbs.init_db()


@pytest.fixture
def frozen_week(monkeypatch):
    """把 summary 的「现在」钉死在 2026-09-16（周三）14:00：测试与真实日期/星期几彻底解耦。"""
    class _Frozen(datetime):
        @classmethod
        def utcnow(cls):
            return cls(2026, 9, 16, 14, 0, 0)
    monkeypatch.setattr(stats, "datetime", _Frozen)


def _add(bvid, title, artist="UP", listened=120, duration=200, age_days=0, plays=1, played_at=None):
    with dbs.new_session() as session:
        for i in range(plays):
            session.add(PlayLog(
                bvid=bvid, cid=1, title=title, artist=artist,
                duration=duration, listened=listened,
                played_at=played_at or datetime.utcnow() - timedelta(days=age_days),
            ))
        session.commit()


async def test_log_play_inserts_row(db_env):
    assert await log_play(PlayLogIn(bvid="BV1xx411c7mD", cid=7, title="歌名", artist="歌手",
                                    duration=200, listened=95)) == {"ok": True}
    s = await stats_summary()
    assert s["total"]["plays"] == 1
    assert s["total"]["minutes"] == 1  # 95s → 1 分钟（整除）
    assert s["total"]["songs"] == 1


async def test_log_play_stores_cover_and_rejects_non_http(db_env):
    # v2.3 播放历史行级封面：http(s) 直链入库；非 http(s)（含注入样式的相对值）置空
    ok = await log_play(PlayLogIn(bvid="BV1xx411c7mD", title="有封面",
                                  cover="https://i0.hdslb.com/bfs/archive/x.jpg"))
    assert ok == {"ok": True}
    assert await log_play(PlayLogIn(bvid="BV2xx411c7mD", title="坏封面",
                                    cover="javascript:alert(1)")) == {"ok": True}
    h = stats.history()
    covers = {t["title"]: t["cover"] for t in h["top"]}
    assert covers["有封面"] == "https://i0.hdslb.com/bfs/archive/x.jpg"
    assert covers["坏封面"] == ""


async def test_log_play_rejects_empty_title(db_env):
    with pytest.raises(HTTPException):
        await log_play(PlayLogIn(title="   "))


def test_summary_buckets_week_today_and_days(db_env, frozen_week):
    # 冻结的「现在」= 周三 14:00：本周一为 09-14 00:00，今天为 09-16
    _add("BVtoday", "今天听的歌", listened=600, played_at=datetime(2026, 9, 16, 13, 0))
    _add("BVweek", "本周早些", listened=300, played_at=datetime(2026, 9, 15, 20, 0))
    _add("BVold", "上周的", listened=3600, played_at=datetime(2026, 9, 7, 12, 0))
    _add("BVmany", "连听三遍", plays=3, listened=60, played_at=datetime(2026, 9, 15, 9, 0))

    s = stats.summary()

    # 近 7 天条形：最后一天是今天
    assert s["days"][-1]["plays"] == 1
    assert len(s["days"]) == 7
    # 本周 = 今天 + 本周早些 + 连听三遍
    assert s["week"]["plays"] == 5
    assert s["week"]["songs"] == 3
    assert s["today"]["plays"] == 1
    assert s["today"]["minutes"] == 10
    # 分钟 = 真实收听秒数累加，不是歌曲时长；上周的不进本周但进累计
    assert s["total"]["plays"] == 6
    assert s["total"]["minutes"] == (600 + 300 + 3600 + 180) // 60


def test_summary_top_songs_and_artists(db_env, frozen_week):
    _add("BVa", "歌A", artist="歌手一", plays=3, listened=100, played_at=datetime(2026, 9, 16, 12, 0))
    _add("BVb", "歌B", artist="歌手一", plays=2, listened=100, played_at=datetime(2026, 9, 15, 10, 0))
    _add("BVc", "歌C", artist="歌手二", plays=1, listened=100, played_at=datetime(2026, 9, 14, 8, 0))
    _add("BVd", "上周歌", artist="歌手三", plays=9, listened=100, played_at=datetime(2026, 9, 7, 12, 0))

    s = stats.summary()
    tops = {t["title"]: t["plays"] for t in s["topSongs"]}
    assert tops.get("歌A") == 3
    assert tops.get("歌B") == 2
    assert "上周歌" not in tops  # 只统计本周
    artists = {a["artist"]: a["plays"] for a in s["topArtists"]}
    assert artists.get("歌手一") == 5
    assert "歌手三" not in artists


def test_summary_empty(db_env):
    s = stats.summary()
    assert s["total"]["plays"] == 0
    assert s["week"]["plays"] == 0
    assert len(s["days"]) == 7


def test_history_total_top_and_day_groups(db_env):
    # 播放历史页：全量 Top（不限本周）+ 最近流水按天分组（今天/昨天）
    _add("BVold", "老歌", plays=9, listened=60, played_at=datetime.utcnow() - timedelta(days=10))
    _add("BVnew", "新歌", plays=2, listened=90, played_at=datetime.utcnow())
    _add("BVyest", "昨天的歌", plays=1, listened=30, played_at=datetime.utcnow() - timedelta(days=1))

    h = stats.history()

    assert h["total"]["plays"] == 12
    assert h["total"]["minutes"] == (9 * 60 + 2 * 90 + 30) // 60
    assert h["total"]["songs"] == 3
    # 最常听是全量口径：上周听 9 次的老歌排第一
    assert h["top"][0]["title"] == "老歌"
    assert h["top"][0]["plays"] == 9
    assert all("minutes" in t and "cover" in t for t in h["top"])
    # 分组标签与顺序：第一组是今天（最新流水），昨天在后
    assert h["recent"][0]["label"] == "今天"
    assert h["recent"][0]["items"][0]["title"] == "新歌"
    assert h["recent"][1]["label"] == "昨天"
    assert h["recent"][1]["items"][0]["title"] == "昨天的歌"


def test_history_empty(db_env):
    h = stats.history()
    assert h["total"]["plays"] == 0
    assert h["top"] == []
    assert h["recent"] == []


def test_history_backfill_covers_only_fills_empty(db_env):
    # 懒补回写：只补空 cover 的行；已有封面的行不被覆盖
    _add("BVsolo", "歌", plays=2, listened=60, played_at=datetime.utcnow())
    with dbs.new_session() as session:
        rows = session.exec(select(PlayLog)).all()  # type: ignore[arg-type]
        rows[0].cover = "https://i0.hdslb.com/bfs/archive/keep.jpg"
        session.commit()

    stats.backfill_covers({"BVsolo": "https://i0.hdslb.com/bfs/archive/new.jpg"})

    with dbs.new_session() as session:
        covers = sorted(r.cover for r in session.exec(select(PlayLog)).all())  # type: ignore[arg-type]
    # 空行已补、已有封面原样保留
    assert covers == ["https://i0.hdslb.com/bfs/archive/keep.jpg",
                      "https://i0.hdslb.com/bfs/archive/new.jpg"]
