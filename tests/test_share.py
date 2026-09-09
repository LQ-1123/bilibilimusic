"""#25 分享：链接拼装、容器 mid 迁移与懒回填。"""
import asyncio
import types

from sqlalchemy import create_engine
from sqlmodel import Session, select

from app.api.routes import _album_out, _backfill_series_mid
from app.config import settings
from app.core.share_links import (
    album_share_url,
    fav_folder_link,
    series_link,
    series_sid,
    video_link,
)
from app.db import session as dbs
from app.db.models import Album, Song


def test_link_builders():
    assert video_link("BV1xx411c7mD") == "https://www.bilibili.com/video/BV1xx411c7mD"
    assert video_link("") == ""
    assert fav_folder_link(398522315, 12345) == "https://space.bilibili.com/398522315/favlist?fid=12345"
    assert fav_folder_link(0, 12345) == ""
    assert series_link(398522315, 777) == "https://space.bilibili.com/398522315/channel/collectiondetail?sid=777"
    assert series_link(398522315, 0) == ""


def test_series_key_parsing():
    assert series_sid("sid:777") == 777
    assert series_sid("sid:not-a-number") == 0
    assert series_sid("BV1xx411c7mD") == 0
    assert series_sid("") == 0


def test_album_share_url_never_emits_half_links():
    # 多 P 专辑：真视频链接
    assert album_share_url("paged", "BV1xx411c7mD") == "https://www.bilibili.com/video/BV1xx411c7mD"
    # 系列合集：缺 mid 时给空串（绝不能拼出 video/sid:777 这种废链接）
    assert album_share_url("series", "sid:777", 0) == ""
    assert album_share_url("series", "sid:777", 398522315).endswith("/channel/collectiondetail?sid=777")


def test_album_out_carries_mid_and_share_url():
    paged = _album_out(Album(id=1, kind="paged", source_bvid="BV1xx411c7mD", title="专辑", mid=0))
    assert paged["shareUrl"] == "https://www.bilibili.com/video/BV1xx411c7mD"
    series = _album_out(Album(id=2, kind="series", source_bvid="sid:777", title="合集", mid=398522315))
    assert series["mid"] == 398522315
    assert series["shareUrl"].endswith("/channel/collectiondetail?sid=777")


def test_album_mid_migration_on_legacy_db(tmp_path):
    """老库的 album 表没有 mid 列：迁移补列且默认 0，数据不丢。"""
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE album (id INTEGER PRIMARY KEY, kind VARCHAR, source_bvid VARCHAR, "
            "title VARCHAR, artist VARCHAR, cover_url VARCHAR, total_pages INTEGER, "
            "materialized_pages INTEGER, created_at DATETIME)"
        )
        conn.exec_driver_sql(
            "INSERT INTO album VALUES (7, 'series', 'sid:777', '老合集', 'UP', '', 3, 3, '2026-09-01 00:00:00')"
        )
    dbs._init_engine(engine)
    dbs._init_engine(engine)  # 幂等：重复初始化不再 ALTER
    with engine.connect() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info('album')").fetchall()}
        assert "mid" in cols
        assert conn.exec_driver_sql("SELECT mid FROM album WHERE id = 7").scalar() == 0
    engine.dispose()


def _db_env(tmp_path, monkeypatch):
    for name, value in {
        "data_dir": tmp_path, "db_path": tmp_path / "library.db",
        "cookie_path": tmp_path / "cookies.json", "music_dir": tmp_path / "music",
        "cover_dir": tmp_path / "covers", "api_token": "",
    }.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(dbs, "_engines", {})
    monkeypatch.setattr(dbs, "_current_mid", None)
    dbs.init_db()


def _fake_request(mid: int, calls: list):
    async def video_owner_mid(bvid):
        calls.append(bvid)
        return mid

    return types.SimpleNamespace(state=types.SimpleNamespace(
        bili=types.SimpleNamespace(video_owner_mid=video_owner_mid)))


def test_backfill_series_mid_from_child_bvid(tmp_path, monkeypatch):
    _db_env(tmp_path, monkeypatch)
    with Session(dbs._get_engine(None)) as session:
        album = Album(kind="series", source_bvid="sid:777", title="合集", total_pages=2)
        session.add(album)
        session.commit()
        session.refresh(album)
        album_id = album.id
        session.add(Song(bvid="BV1child", cid=1, title="第一首", artist="UP",
                         audio_path="", cover_path="", album_id=album_id))
        session.commit()

    calls: list = []
    mid = asyncio.run(_backfill_series_mid(album_id, _fake_request(398522315, calls)))
    assert mid == 398522315
    assert calls == ["BV1child"]
    with Session(dbs._get_engine(None)) as session:
        assert session.get(Album, album_id).mid == 398522315
        # 已回填的容器直接返回存量 mid，不再打一次接口
        assert asyncio.run(_backfill_series_mid(album_id, _fake_request(1, calls))) == 398522315
        assert calls == ["BV1child"]


def test_backfill_series_mid_without_child_songs(tmp_path, monkeypatch):
    _db_env(tmp_path, monkeypatch)
    with Session(dbs._get_engine(None)) as session:
        album = Album(kind="series", source_bvid="sid:999", title="空合集")
        session.add(album)
        session.commit()
        session.refresh(album)
        album_id = album.id
    calls: list = []
    assert asyncio.run(_backfill_series_mid(album_id, _fake_request(5, calls))) == 0
    assert calls == []  # 没曲目可反查：直接放弃，不瞎打接口
