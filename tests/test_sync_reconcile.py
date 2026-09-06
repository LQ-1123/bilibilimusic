"""对账回归：B 站为准——取消收藏删歌、删夹删歌单、收藏跨夹转移、未收藏的照常推送。"""

import pytest

from app.config import settings
from app.db import session as dbs
from app.db.models import Song
from app.services import library, playlists
from app.services.sync import SyncService, SyncState
from app.storage.files import FileStore


class StubBili:
    """只覆盖对账用到的 B 站接口：多夹内容与核实结果可注入。"""

    def __init__(self, folders=(1,), contents=None, in_folder=False, aid_map=None):
        # folders: [(id, title)]；contents: {folder_id: [{bvid, aid}]}
        self.folders = [
            {"id": fid, "title": title, "count": len((contents or {}).get(fid, ()))}
            for fid, title in folders
        ]
        self.contents = dict(contents or {})
        self.in_folder = in_folder  # find_in_folder 的核实结果
        self.aid_map = dict(aid_map or {})
        self.pushed = []
        self.created = []

    async def list_library_folders(self, refresh=False):
        return self.folders

    async def get_fav_videos(self, media_id, cap=2000):
        return self.contents.get(media_id, [])

    async def find_in_folder(self, media_id, aid, max_pages=50):
        return self.in_folder

    async def bvid_to_aid(self, bvid):
        return self.aid_map.get(bvid)

    async def favorite_into(self, aid, ids, next_title=None):
        self.pushed.append(aid)
        return ids[0]

    async def create_fav_folder(self, title):
        fid = max((f["id"] for f in self.folders), default=0) + 1
        self.folders.append({"id": fid, "title": title, "count": 0})
        self.created.append(title)
        return fid


class StubImporter:
    def __init__(self):
        self.submitted = []

    def submit_bvid(self, bvid, fav_folder_id=0, playlist_id=0):
        self.submitted.append(bvid)


def _add_song(bvid, *, fav=0, aid=0):
    song = Song(bvid=bvid, title=f"歌 {bvid}", cid=1, artist="UP",
                audio_path="", cover_path="", fav_folder_id=fav, aid=aid)
    with dbs.new_session() as session:
        session.add(song)
        session.commit()
        session.refresh(song)
        return song.id


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


def _reconcile(files, bili, importer=None):
    return SyncService(bili, importer or StubImporter(), files)


async def test_reconcile_deletes_unfavorited_pulls_and_pushes(db_env):
    files = db_env
    p = playlists.ensure_default()
    playlists.set_folder_ids(p.id, [1])
    kept = _add_song("BV1kept", fav=1)
    gone = _add_song("BV2gone", fav=1)  # B 站已取消收藏：应被删除
    fresh = _add_song("BV3fresh", fav=0)  # 本地刚加未收藏：应推送而非删除

    bili = StubBili(
        folders=[(1, "bilimusic")],
        contents={1: [{"bvid": "BV1kept", "aid": 101}, {"bvid": "BV4new", "aid": 104}]},
        in_folder=False,
        aid_map={"BV2gone": 202, "BV3fresh": 303},
    )
    importer = StubImporter()
    syncer = _reconcile(files, bili, importer)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert state.removed == 1
    assert library.get_song(gone) is None
    assert library.get_song(kept) is not None
    assert library.get_song(fresh) is not None
    assert bili.pushed == [303]  # 只有未收藏的本地歌被推送
    assert importer.submitted == ["BV4new"]  # 夹里有、本地没有 → 拉取
    assert syncer._folder_counts == {1: 2}  # 对账后留下数量快照供心跳比对


async def test_reconcile_keeps_song_when_folder_still_contains_it(db_env):
    files = db_env
    p = playlists.ensure_default()
    playlists.set_folder_ids(p.id, [1])
    song_id = _add_song("BV1kept", fav=1)

    # 清单里没有（拉清单后才收藏的窗口期），但回查发现还在夹内：不删
    bili = StubBili(folders=[(1, "bilimusic")], in_folder=True, aid_map={"BV1kept": 101})
    syncer = _reconcile(files, bili)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert state.removed == 0
    assert library.get_song(song_id) is not None


async def test_reconcile_skips_deletion_when_folder_list_looks_broken(db_env):
    files = db_env
    p = playlists.ensure_default()
    playlists.set_folder_ids(p.id, [1])
    song_id = _add_song("BV1kept", fav=1)

    syncer = _reconcile(files, StubBili(folders=[]))  # 接口异常返回空：绝不能据此清库
    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert state.removed == 0
    assert library.get_song(song_id) is not None


async def test_reconcile_drops_playlist_whose_folders_were_deleted_on_bilibili(db_env):
    files = db_env
    default = playlists.ensure_default()
    playlists.set_folder_ids(default.id, [1])
    rock = await playlists.create("摇滚", None, folder_id=7)
    song_id = _add_song("BV1rock", fav=7, aid=707)
    library.update_playlist(song_id, rock.id)

    # B 站侧夹 7 已被删除（只剩主夹）：歌单与歌一并删除
    bili = StubBili(folders=[(1, "bilimusic")], contents={1: []})
    syncer = _reconcile(files, bili)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert state.dropped == 1
    assert state.removed == 1
    assert playlists.get_playlist(rock.id) is None
    assert library.get_song(song_id) is None
    assert playlists.get_default() is not None  # 默认歌单不受影响


async def test_reconcile_moves_song_following_favorite_to_another_playlist(db_env):
    files = db_env
    default = playlists.ensure_default()
    playlists.set_folder_ids(default.id, [1])
    rock = await playlists.create("摇滚", None, folder_id=7)
    song_id = _add_song("BV1mv", fav=1, aid=101)  # 原在默认歌单的主夹

    # B 站侧把收藏从夹 1 移进了夹 7（另一歌单）：本地歌跟随转移，不删
    bili = StubBili(
        folders=[(1, "bilimusic"), (7, "bilimusic- 摇滚")],
        contents={1: [], 7: [{"bvid": "BV1mv", "aid": 101}]},
        in_folder=False,
    )
    syncer = _reconcile(files, bili)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert state.removed == 0
    song = library.get_song(song_id)
    assert song is not None
    assert song.playlist_id == rock.id
    assert song.fav_folder_id == 7


async def test_reconcile_default_playlist_survives_when_main_folders_deleted(db_env):
    files = db_env
    default = playlists.ensure_default()
    playlists.set_folder_ids(default.id, [1])
    song_id = _add_song("BV1gone", fav=1, aid=101)

    # 主夹 1 在 B 站被删（账号下只剩别的夹）：默认歌单行保留，歌随夹删除
    bili = StubBili(folders=[(9, "bilimusic- 别的")], contents={9: []})
    syncer = _reconcile(files, bili)

    state = SyncState(id="test")
    await syncer._reconcile(state)

    assert state.dropped == 0
    assert state.removed == 1
    assert library.get_song(song_id) is None
    default_after = playlists.get_default()
    assert default_after is not None
    assert playlists.folder_ids(default_after) == []  # 夹池清空，等待懒建
