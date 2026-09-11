"""漫游电台（v2.1 A5）：批次来自 recs 池、排除已知/排除列表、风格优先。"""
import pytest

from app.config import settings
from app.db import session as dbs
from app.db.models import RecPool, Song
from app.services import radio
from datetime import datetime, timedelta


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


def _pool(bvid, title, genre="", duration=200):
    with dbs.new_session() as session:
        session.add(RecPool(bvid=bvid, title=title, artist="UP", duration=duration,
                            cover_url="", seed_bvid="BVseed", genre=genre,
                            expires_at=datetime.utcnow() + timedelta(days=1)))
        session.commit()


def test_batch_prefers_seed_genre_and_excludes_known(db_env):
    _pool("BVrock1", "摇滚一", genre="摇滚金属")
    _pool("BVpop1", "流行一", genre="华语流行")
    _pool("BVrock2", "摇滚二", genre="摇滚金属")
    with dbs.new_session() as session:
        session.add(Song(bvid="BVrock2", cid=1, title="已收藏", artist="UP", duration=200,
                         audio_path="", cover_path="", source_url="", collected=True))
        session.commit()

    items = radio.next_batch("BVseed", exclude=["BVpop1"], n=3)

    bvids = [i.bvid for i in items]
    assert "BVrock2" not in bvids  # 已在曲库的不推
    assert "BVpop1" not in bvids   # 排除列表生效
    assert "BVrock1" in bvids


def test_batch_skips_non_song_like(db_env):
    _pool("BVlong", "三小时录音", duration=10800)
    _pool("BVok", "正常歌")
    items = radio.next_batch("BVseed", n=3)
    assert [i.bvid for i in items] == ["BVok"]


def test_batch_empty_pool_returns_empty(db_env):
    assert radio.next_batch("BVseed") == []
