"""Paged albums: migration, import and video-level favorites."""
import asyncio
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.config import settings
from app.db import session as dbs
from app.db.models import Song
from app.services import library, playlists


@pytest.fixture
def db_env(tmp_path, monkeypatch):
    for name, value in {
        "data_dir": tmp_path, "db_path": tmp_path / "library.db",
        "cookie_path": tmp_path / "cookies.json", "music_dir": tmp_path / "music",
        "cover_dir": tmp_path / "covers", "api_token": "",
    }.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(dbs, "_engines", {})
    monkeypatch.setattr(dbs, "_current_mid", None)
    dbs.init_db()
    yield
    for engine in dbs._engines.values():
        engine.dispose()


@pytest.mark.parametrize("table_unique", [False, True])
def test_old_song_uniqueness_migration_preserves_data(tmp_path, table_unique):
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.exec_driver_sql('CREATE TABLE song (id INTEGER PRIMARY KEY, bvid VARCHAR '
                             + ('UNIQUE' if table_unique else '') + ', cid INTEGER, title VARCHAR, '
                             'artist VARCHAR, duration INTEGER, quality_id INTEGER, audio_path VARCHAR, '
                             'cover_path VARCHAR, source_url VARCHAR, created_at DATETIME)')
        if not table_unique:
            conn.exec_driver_sql('CREATE UNIQUE INDEX ix_song_bvid ON song (bvid)')
        conn.exec_driver_sql("INSERT INTO song VALUES (42, 'BV1xx411c7mD', 111, '旧标题', 'UP', 20, 0, '', '', '', '2026-09-08 00:00:00')")
    dbs._init_engine(engine)
    dbs._init_engine(engine)
    with Session(engine) as session:
        old = session.get(Song, 42)
        assert old.title == '旧标题'
        session.add(Song(bvid=old.bvid, cid=222, title='第二首', artist='UP', audio_path='', cover_path=''))
        session.commit()
        session.add(Song(bvid=old.bvid, cid=111, title='重复', artist='UP', audio_path='', cover_path=''))
        with pytest.raises(IntegrityError):
            session.commit()
    engine.dispose()


def test_part_duration_and_pages_from_one_view():
    from app.bili.client import BiliClient
    from app.core.link_parser import VideoRef
    async def run():
        client = object.__new__(BiliClient)
        calls = []
        async def view(path, params):
            calls.append(params)
            return {"bvid": "BV1xx411c7mD", "aid": 9, "duration": 500,
                    "title": "整张", "owner": {"name": "UP"}, "pages": [
                        {"cid": 111, "part": "01 · 晴天", "duration": 200},
                        {"cid": 222, "part": "02. 夜曲", "duration": 300}]}
        client._get_json_signed = view
        info = await client.get_video_info(VideoRef(bvid="BV1xx411c7mD", page=2))
        assert info.duration == 300
        assert [(p.cid, p.part, p.duration) for p in info.pages] == [(111, '01 · 晴天', 200), (222, '02. 夜曲', 300)]
        assert len(calls) == 1
    asyncio.run(run())
