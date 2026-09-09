"""同步一致性回归（v0.5.0 修复）：合集视频在本地只有未收藏子作品时，对账不得反复导入。

#37 之后 list_songs() 默认 only_collected=True；sync 曾用同一默认值判断
「B 站收藏夹视频是否已在本地」，导致合集（多 P）视频只要子作品没被星标，
每次对账都被当成「不在本地」重新提交导入。
"""

import pytest
from sqlmodel import select

from app.config import settings
from app.db import session as dbs
from app.db.models import Album, Song
from app.services import library, playlists
from app.services.sync import SyncService, SyncState
from app.storage.files import FileStore

from tests.test_sync_reconcile import StubBili, StubImporter, _reconcile


def _add_album_child(album_bvid, cid, *, collected=False, playlist_id=0, aid=0):
    song = Song(bvid=album_bvid, title=f"分 P {cid}", cid=cid, artist="UP", aid=aid,
                audio_path="", cover_path="", album_id=_album_id(album_bvid),
                track_no=cid, collected=collected, playlist_id=playlist_id)
    with dbs.new_session() as session:
        session.add(song)
        session.commit()
        session.refresh(song)
    return song.id


def _album_id(album_bvid):
    with dbs.new_session() as session:
        row = session.exec(
            select(Album).where(Album.source_bvid == album_bvid)  # type: ignore[attr-defined]
        ).first()
        if row is not None:
            return row.id or 0
        album = Album(kind="paged", source_bvid=album_bvid, title="测试合集",
                      total_pages=3, materialized_pages=3)
        session.add(album)
        session.commit()
        session.refresh(album)
        return album.id or 0


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


async def test_reconcile_does_not_reimport_album_with_only_uncollected_children(db_env):
    """合集视频三个分 P 都没星标：对账看到夹里有该视频，也绝不能重复提交导入。"""
    p = playlists.ensure_default()
    playlists.set_folder_ids(p.id, [1])
    _add_album_child("BValbum", 11)
    _add_album_child("BValbum", 12)
    _add_album_child("BValbum", 13)

    importer = StubImporter()
    syncer = _reconcile(db_env, StubBili(
        folders=[(1, "bilimusic")],
        contents={1: [{"bvid": "BValbum", "aid": 101}]},
    ), importer)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert importer.submitted == []  # 本地已有容器行：不是「不在本地」
    assert state.pulled == 0


async def test_reconcile_imports_video_truly_absent_locally(db_env):
    """对照：完全没见过的 bvid 仍照常拉取导入。"""
    p = playlists.ensure_default()
    playlists.set_folder_ids(p.id, [1])
    _add_album_child("BValbum", 11)

    importer = StubImporter()
    syncer = _reconcile(db_env, StubBili(
        folders=[(1, "bilimusic")],
        contents={1: [{"bvid": "BValbum", "aid": 101}, {"bvid": "BVfresh", "aid": 202}]},
    ), importer)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert importer.submitted == ["BVfresh"]


async def test_reconcile_deletes_every_row_of_unfavorited_album_video(db_env):
    """同 bvid 的多个分 P 行都已收藏：B 站取消收藏后各行都要删（不能只删映射里最后一条）。"""
    p = playlists.ensure_default()
    playlists.set_folder_ids(p.id, [1])
    first = _add_album_child("BValbum", 11, collected=True, playlist_id=p.id, aid=101)
    library.update_fav_folder(first, 1)
    second = _add_album_child("BValbum", 12, collected=True, playlist_id=p.id, aid=101)
    library.update_fav_folder(second, 1)

    importer = StubImporter()
    syncer = _reconcile(db_env, StubBili(
        folders=[(1, "bilimusic")], contents={1: []},
    ), importer)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert state.removed == 2
    assert library.get_song(first) is None
    assert library.get_song(second) is None
