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


def test_part_display_title_keeps_part_song_name():
    # 子曲目标题只保留分P名（歌名），不再重复拼接合集名
    from app.services.importer import part_display_title
    assert part_display_title("陶喆合集", "01 · 晴天") == "晴天"
    assert part_display_title("陶喆合集", "第3集 夜曲") == "夜曲"
    assert part_display_title("陶喆合集", "12.《Melody》") == "《Melody》"


def test_part_display_title_falls_back_to_main_for_placeholder():
    from app.services.importer import part_display_title
    assert part_display_title("陶喆合集", "P1") == "陶喆合集"
    assert part_display_title("陶喆合集", "正片") == "陶喆合集"
    assert part_display_title("陶喆合集", "") == "陶喆合集"
    # 单字中文歌名是有效歌名，不能按长度丢掉
    assert part_display_title("陶喆合集", "枫") == "枫"


def test_part_display_title_no_duplicate_main_title():
    from app.services.importer import part_display_title
    main = "PLAYLIST | 陶喆 | 精选歌单"
    assert part_display_title(main, f"{main} · 11.月亮") == f"{main} · 11.月亮"
    # 分P名完整覆盖主标题时不重复拼接


def test_short_title_collapses_album_prefix_only():
    from app.services.titles import short_title
    main = "【周杰伦】50首精选合集/后台播放/无损音质/HIFI音质/华语流行音乐才是最叼的"
    assert short_title(f"{main} · 001.周杰伦-晴天", main) == "周杰伦-晴天"
    # 标题里本来就有 ` · `（非合集结构）时不能乱切
    other = "黄小琥《没那么简单》 但是方大同风格编曲 · 没那么简单"
    assert short_title(other, main) == other
    # 分P名是占位名时保持原样
    assert short_title(f"{main} · P1", main) == f"{main} · P1"


def test_album_child_titles_shortened_by_migration(db_env):
    """存量库：引擎初始化时把「合集标题 · 分P标题」收敛为分P标题。"""
    from app.db.models import Album
    from app.db.session import _get_engine, new_session
    main = "【周杰伦】50首精选合集/后台播放/无损音质/HIFI音质/华语流行音乐才是最叼的"
    with new_session() as session:
        album = Album(kind="paged", source_bvid="BVmig000001", title=main, artist="UP",
                      cover_url="", total_pages=2, materialized_pages=2)
        session.add(album)
        session.flush()
        session.add(Song(bvid="BVmig000001", cid=1, title=f"{main} · 001.周杰伦-晴天",
                         artist="UP", audio_path="", cover_path="", album_id=album.id, track_no=1))
        session.add(Song(bvid="BVmig000001", cid=2, title=f"{main} · P2",
                         artist="UP", audio_path="", cover_path="", album_id=album.id, track_no=2))
        session.commit()
    dbs._migrate(_get_engine(None))
    with new_session() as session:
        titles = [s.title for s in session.exec(select(Song).order_by(Song.track_no)).all()]
    assert titles == ["周杰伦-晴天", f"{main} · P2"]  # 占位名不收敛


def test_album_songs_payload_respects_materialized_pages(db_env):
    from app.api.routes import _album_songs_payload
    from app.db.models import Album
    with Session(dbs._get_engine(None)) as session:
        album = Album(kind="paged", source_bvid="BV1lazy0000", title="懒专辑",
                      artist="UP", cover_url="", total_pages=5, materialized_pages=2)
        session.add(album)
        session.flush()
        for i in range(1, 6):
            session.add(Song(bvid=f"BVlazy{i:02d}", cid=9000 + i, title=f"t{i}",
                             artist="a", audio_path="", cover_path="",
                             album_id=album.id, track_no=i))
        session.commit()
        payload = _album_songs_payload(album, session)
    assert len(payload["songs"]) == 2          # 只返回已物化的前两首
    assert payload["hasMore"] is True          # 提示前端继续 materialize
    assert payload["materializedPages"] == 2