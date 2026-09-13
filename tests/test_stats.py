"""B6 听歌统计：流水上报 + 聚合口径（本周/今日/近7天/最常听/分钟用真实收听秒数）。"""

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

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


def _add(bvid, title, artist="UP", listened=120, duration=200, age_days=0, plays=1):
    with dbs.new_session() as session:
        for i in range(plays):
            session.add(PlayLog(
                bvid=bvid, cid=1, title=title, artist=artist,
                duration=duration, listened=listened,
                played_at=datetime.utcnow() - timedelta(days=age_days),
            ))
        session.commit()


async def test_log_play_inserts_row(db_env):
    assert await log_play(PlayLogIn(bvid="BV1xx411c7mD", cid=7, title="歌名", artist="歌手",
                                    duration=200, listened=95)) == {"ok": True}
    s = await stats_summary()
    assert s["total"]["plays"] == 1
    assert s["total"]["minutes"] == 1  # 95s → 1 分钟（整除）
    assert s["total"]["songs"] == 1


async def test_log_play_rejects_empty_title(db_env):
    with pytest.raises(HTTPException):
        await log_play(PlayLogIn(title="   "))


def test_summary_buckets_week_today_and_days(db_env):
    _add("BVtoday", "今天听的歌", listened=600)                # 今天 10 分钟
    _add("BVweek", "本周早些", listened=300, age_days=1)       # 本周（周一之后视今天星期几）
    _add("BVold", "上周的", listened=3600, age_days=10)        # 上周：只进累计
    _add("BVmany", "连听三遍", plays=3, listened=60, age_days=2)

    s = stats.summary()

    # 近 7 天条形：最后一天是今天
    assert s["days"][-1]["plays"] >= 1
    assert len(s["days"]) == 7
    # 累计包含上周
    assert s["total"]["plays"] == 6
    # 本周口径：today + age_days=1 + age_days=2（1 天前一定在本周内，除非今天是周一；
    # 所以用「至少包含今天和 2 天前」的稳健断言）
    assert s["week"]["plays"] >= 5
    assert s["today"]["plays"] == 1
    assert s["today"]["minutes"] == 10
    # 分钟 = 真实收听秒数累加，不是歌曲时长
    assert s["total"]["minutes"] == (600 + 300 + 3600 + 180) // 60


def test_summary_top_songs_and_artists(db_env):
    _add("BVa", "歌A", artist="歌手一", plays=3, listened=100)
    _add("BVb", "歌B", artist="歌手一", plays=2, listened=100, age_days=1)
    _add("BVc", "歌C", artist="歌手二", plays=1, listened=100, age_days=1)
    _add("BVd", "上周歌", artist="歌手三", plays=9, listened=100, age_days=9)

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
