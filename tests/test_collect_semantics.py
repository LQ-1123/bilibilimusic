"""v2.0.1 星标语义（验收定稿）的回归。

用户验收口径：「多p不是让你全部星星，是收藏的才星星」——#37 的逐分 P 挑歌
（paged 目录态）保留；本轮真正统一的是三处入口（播放条星/歌词页星/行内星）
的取消行为与幽灵态：

1. paged 点星 → 仅点亮该行（B 站视频收藏导入时已成立，本地挑歌标记）
2. paged 取消 → 仅该行退目录态，B 站收藏与专辑容器都不动（可再点星收回）
3. 单视频取消 → 行删除 + 取消 B 站收藏（不留「应用没了、收藏夹还在」的幽灵行）
4. series 取消 → 同视频行退目录态、容器保留（合集里其余作品不受影响）
"""

import asyncio
import types

import pytest
from sqlmodel import select

from app.api import routes
from app.config import settings
from app.db import session as dbs
from app.db.models import Album, Song
from app.services import library, playlists
from app.storage.files import FileStore


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
    return FileStore(settings.music_dir, settings.cover_dir)


class _Bili:
    def __init__(self):
        self.unfavorited = []

    async def unfavorite_song(self, aid, folder_id=0):
        self.unfavorited.append((aid, folder_id))


def _request(bili, files):
    return types.SimpleNamespace(state=types.SimpleNamespace(bili=bili, files=files))


def _paged_album_with_rows(collected=False, playlist_id=0):
    """建一张 paged 专辑 + 三个分 P 行。"""
    with dbs.new_session() as session:
        album = Album(kind="paged", source_bvid="BVpaged", title="陶喆合集",
                      artist="陶喆", cover_url="", total_pages=3, materialized_pages=3)
        session.add(album)
        session.flush()
        for i, cid in enumerate((11, 12, 13), start=1):
            session.add(Song(bvid="BVpaged", aid=42, cid=cid, title=f"歌{i}", artist="陶喆",
                             duration=200, audio_path="", cover_path="", source_url="",
                             playlist_id=playlist_id, album_id=album.id or 0,
                             track_no=i, collected=collected))
        session.commit()


def _all_rows():
    with dbs.new_session() as session:
        return sorted(
            (s.cid, s.collected, s.playlist_id) for s in session.exec(select(Song)).all()
        )


def test_import_keeps_paged_children_in_catalog_state(db_env):
    """铁律 0：paged 导入是目录态——「收藏的才星星」，不全亮。"""
    _paged_album_with_rows()
    assert all(collected is False for _cid, collected, _pl in _all_rows())


def test_collect_lights_only_the_picked_row(db_env):
    """铁律 1：paged 点星只点亮这一行。"""
    _paged_album_with_rows()
    song = library.list_songs(limit=10, only_collected=False)[0]

    picked = library.collect_song(song.id)

    assert picked.collected is True
    rows = _all_rows()
    assert sum(1 for _cid, collected, _pl in rows if collected) == 1


def test_uncollect_paged_exits_only_that_row(db_env):
    """铁律 2：paged 取消只退该行，B 站不动、容器保留。"""
    _paged_album_with_rows(collected=True, playlist_id=1)
    bili = _Bili()
    song = library.list_songs(limit=10)[0]

    result = asyncio.run(routes.uncollect_song_api(song.id, _request(bili, None)))

    assert result == {"ok": True}
    assert bili.unfavorited == []  # B 站视频级收藏不动
    rows = _all_rows()
    assert sum(1 for _cid, collected, _pl in rows if collected) == 2  # 只退了那一行
    with dbs.new_session() as session:
        album = session.exec(select(Album)).first()
        assert album is not None  # 容器保留，可再点星收回


def test_uncollect_single_video_deletes_row_and_unfavorites(db_env):
    """铁律 3：单视频取消 = 删行 + 取消 B 站收藏，不留幽灵行。"""
    with dbs.new_session() as session:
        session.add(Song(bvid="BVsingle", aid=7, cid=99, title="枫", artist="周杰伦",
                         duration=200, audio_path="", cover_path="", source_url="",
                         playlist_id=1, album_id=0, collected=True, fav_folder_id=5))
        session.commit()
    song = library.list_songs(limit=10)[0]
    bili = _Bili()

    result = asyncio.run(routes.uncollect_song_api(song.id, _request(bili, db_env)))

    assert result == {"ok": True}
    assert bili.unfavorited == [(7, 5)]  # 带夹 id 取消
    assert _all_rows() == []


def test_uncollect_series_keeps_container_and_rows_return_to_catalog(db_env):
    """铁律 4：series 取消退同视频行 + 取消该视频收藏，容器与其余作品不受影响。"""
    with dbs.new_session() as session:
        album = Album(kind="series", source_bvid="BVa", title="合集", artist="UP",
                      cover_url="", total_pages=2, materialized_pages=2)
        session.add(album)
        session.flush()
        session.add(Song(bvid="BVa", aid=1, cid=21, title="第一首", artist="UP",
                         duration=100, audio_path="", cover_path="", source_url="",
                         playlist_id=1, album_id=album.id or 0, track_no=1,
                         collected=True, fav_folder_id=3))
        session.add(Song(bvid="BVb", aid=2, cid=22, title="第二首", artist="UP",
                         duration=100, audio_path="", cover_path="", source_url="",
                         playlist_id=1, album_id=album.id or 0, track_no=2,
                         collected=True, fav_folder_id=3))
        session.commit()
        target = session.exec(select(Song).where(Song.bvid == "BVa")).first()

    class _Importer:
        async def favorite_series_song(self, song_id):
            raise AssertionError("取消收藏不应触发收藏动作")

    request = types.SimpleNamespace(state=types.SimpleNamespace(
        bili=_Bili(), files=None, importer=_Importer(),
        syncer=types.SimpleNamespace(defer_unfav=lambda *a, **k: None),
    ))
    result = asyncio.run(routes.uncollect_song_api(target.id, request))

    assert result == {"ok": True}
    rows = {s.bvid: s.collected for s in library.list_songs(limit=10, only_collected=False)}
    assert rows["BVa"] is False  # 同视频行退回目录态
    assert rows["BVb"] is True   # 合集其余作品不受影响
    with dbs.new_session() as session:
        assert session.get(Album, target.album_id) is not None  # 容器保留
