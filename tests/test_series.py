"""系列（合集）容器（v0.5.0）：链接解析、导入幂等/合并/降级、收藏与删除语义、自愈。"""

import asyncio

import httpx
import pytest
from sqlmodel import select

from app.bili.client import BiliApiError, VideoInfo, VideoPage
from app.config import settings
from app.core import url_guard
from app.core.link_parser import parse_series_url, resolve_target
from app.db import session as dbs
from app.db.models import Album, Song
from app.services import library, playlists
from app.services.importer import ImportService
from app.storage.files import FileStore


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: ("1.2.3.4",))


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


@pytest.fixture(autouse=True)
def no_throttle(monkeypatch):
    """频控间隔归零：系列导入/取消收藏的 sleep 全部免等。"""
    import random as _random

    monkeypatch.setattr(_random, "uniform", lambda a, b: 0)


SERIES_URL = "https://space.bilibili.com/12345/channel/collectiondetail?sid=678"


# ---- 链接解析 ----


def test_parse_series_url():
    ref = parse_series_url(SERIES_URL)
    assert ref is not None and ref.sid == 678 and ref.mid == 12345


def test_parse_series_url_with_extra_query():
    ref = parse_series_url(SERIES_URL + "&ctype=21")
    assert ref is not None and ref.sid == 678


def test_parse_series_url_rejects_others():
    assert parse_series_url("https://space.bilibili.com/12345/favlist?fid=9") is None
    assert parse_series_url("https://www.bilibili.com/video/BV1xx411c7mD") is None
    # 「列表」系列（seriesdetail）是另一套接口，本期不识别
    assert parse_series_url("https://space.bilibili.com/1/channel/seriesdetail?sid=2") is None
    assert parse_series_url("https://evil.com/123/channel/collectiondetail?sid=678") is None
    assert parse_series_url("https://space.bilibili.com/12345/channel/collectiondetail") is None


@pytest.mark.asyncio
async def test_resolve_target_via_short_link():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": SERIES_URL})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    ref = await resolve_target(client, "【合集】 https://b23.tv/abc 快来听！")
    await client.aclose()
    assert ref is not None
    assert ref.sid == 678 and ref.mid == 12345


@pytest.mark.asyncio
async def test_resolve_target_video_still_works():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302, headers={"location": "https://www.bilibili.com/video/BV1xx411c7mD"}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    ref = await resolve_target(client, "https://b23.tv/abc")
    await client.aclose()
    assert ref.bvid == "BV1xx411c7mD"


# ---- 导入流水线 ----


class StubSeriesBili:
    """系列导入用：清单分页 + 元信息 + 逐视频 view + 取消收藏可注入。"""

    def __init__(self, archives, infos, meta=None):
        self.archives = archives  # [{bvid, aid, title, pic}]
        self.infos = infos  # {bvid: VideoInfo}
        self.meta = meta or {}
        self.unfaved = []
        self.fail_unfav: set[int] = set()
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(404)))

    async def seasons_archives_list(self, mid, season_id, page_num=1, page_size=30):
        start = (page_num - 1) * page_size
        return self.archives[start:start + page_size], len(self.archives)

    async def season_meta(self, mid, season_id):
        return self.meta

    async def get_video_info(self, ref):
        info = self.infos.get(ref.bvid)
        if info is None:
            raise BiliApiError(-404, "视频已下架")
        return info

    async def unfavorite_song(self, aid, folder_id=0):
        if aid in self.fail_unfav:
            raise BiliApiError(-400, "取消收藏失败")
        self.unfaved.append((aid, folder_id))


def _info(bvid, avid, pages):
    return VideoInfo(
        bvid=bvid, avid=avid, cid=pages[0].cid, title=f"视频 {bvid}", artist="UP",
        duration=pages[0].duration, cover_url="https://i0.hdslb.com/b.jpg", page=1,
        pages=pages,
    )


def _make_importer(bili, files):
    return ImportService(bili, files, concurrency=2)


async def _run_series(importer, sid=678, mid=12345):
    task = importer.submit_series(sid, mid)
    job = importer._tasks[task.id]
    await asyncio.wait_for(job, 10)
    return ImportService.get_task(task.id)


def _albums():
    with dbs.new_session() as session:
        return list(session.exec(select(Album)).all())


def _album_songs(album_id):
    with dbs.new_session() as session:
        return list(session.exec(
            select(Song).where(Song.album_id == album_id).order_by(Song.track_no)  # type: ignore[attr-defined]
        ).all())


async def test_series_import_creates_container_and_rows(db_env):
    bili = StubSeriesBili(
        archives=[
            {"bvid": "BVone", "aid": 101, "title": "一", "pic": "https://i0.hdslb.com/1.jpg"},
            {"bvid": "BVtwo", "aid": 102, "title": "二", "pic": "https://i0.hdslb.com/2.jpg"},
        ],
        infos={
            "BVone": _info("BVone", 101, [VideoPage(cid=1, part="", duration=200)]),
            "BVtwo": _info("BVtwo", 102, [
                VideoPage(cid=21, part="上", duration=100),
                VideoPage(cid=22, part="下", duration=120),
            ]),
        },
        meta={"name": "我的音乐系列", "cover": "https://i0.hdslb.com/s.jpg", "up_name": "UP"},
    )
    importer = _make_importer(bili, db_env)

    task = await _run_series(importer)

    albums = _albums()
    assert len(albums) == 1
    album = albums[0]
    assert album.kind == "series"
    assert album.source_bvid == "sid:678"
    assert album.title == "我的音乐系列"
    assert album.artist == "UP"
    assert album.total_pages == 2
    assert album.materialized_pages == 3  # 视频1 一行 + 视频2 两行
    assert task.status == "ready" and task.progress == 100

    songs = _album_songs(album.id)
    assert [(s.bvid, s.cid, s.track_no) for s in songs] == [
        ("BVone", 1, 1), ("BVtwo", 21, 2), ("BVtwo", 22, 3)]
    assert all(s.collected is False for s in songs)  # 默认不进曲库，星标才收藏
    assert library.list_songs(limit=100) == []  # 曲库计数不受污染


async def test_series_import_is_idempotent_and_merges_loose_songs(db_env):
    # 换设备场景：sync 先把 BVone 拉回了曲库（散曲，album_id=0、已收藏）
    playlists.ensure_default()
    loose = Song(bvid="BVone", aid=101, cid=1, title="视频 BVone", artist="UP",
                 duration=200, audio_path="", cover_path="", playlist_id=1,
                 collected=True, fav_folder_id=9)
    with dbs.new_session() as session:
        session.add(loose)
        session.commit()
        session.refresh(loose)

    bili = StubSeriesBili(
        archives=[
            {"bvid": "BVone", "aid": 101, "title": "一"},
            {"bvid": "BVtwo", "aid": 102, "title": "二"},
        ],
        infos={
            "BVone": _info("BVone", 101, [VideoPage(cid=1, part="", duration=200)]),
            "BVtwo": _info("BVtwo", 102, [VideoPage(cid=21, part="", duration=100)]),
        },
    )
    importer = _make_importer(bili, db_env)
    await _run_series(importer)
    await _run_series(importer)  # 二次导入：幂等，不重复建容器/行

    albums = _albums()
    assert len(albums) == 1
    songs = _album_songs(albums[0].id)
    assert len(songs) == 2

    # 散曲被「认领」回容器：收藏状态与歌单原样保留（sid 重建 + 与收藏夹合并）
    claimed = next(s for s in songs if s.bvid == "BVone")
    assert claimed.id == loose.id
    assert claimed.collected is True and claimed.playlist_id == 1 and claimed.fav_folder_id == 9
    assert library.list_songs(limit=100) and library.list_songs(limit=100)[0].id == loose.id


async def test_series_import_degrades_on_single_video_failure(db_env):
    bili = StubSeriesBili(
        archives=[
            {"bvid": "BVok", "aid": 1, "title": "好"},
            {"bvid": "BVgone", "aid": 2, "title": "下架"},
        ],
        infos={"BVok": _info("BVok", 1, [VideoPage(cid=1, part="", duration=10)])},
    )
    importer = _make_importer(bili, db_env)

    task = await _run_series(importer)

    assert task.status == "ready"  # 单视频失败不阻塞整个系列
    assert task.error and "1 个视频导入失败" in task.error
    album = _albums()[0]
    songs = _album_songs(album.id)
    assert [s.bvid for s in songs] == ["BVok"]
    assert album.materialized_pages == 1


async def test_series_import_empty_raises(db_env):
    bili = StubSeriesBili(archives=[], infos={})
    importer = _make_importer(bili, db_env)

    task = await _run_series(importer)

    assert task.status == "failed"
    assert _albums() == []


# ---- 提交分发（/web/import 链路） ----


@pytest.mark.asyncio
async def test_submit_any_dispatches_series_link(db_env, monkeypatch):
    from app.services import batch

    calls = []

    def _stub_submit_series(sid, mid=0, playlist_id=0, raw_text=""):
        calls.append((sid, mid, playlist_id))
        return type("T", (), {"id": "t1"})()

    monkeypatch.setattr(
        ImportService, "submit_series", lambda self, sid, mid=0, playlist_id=0, raw_text="": _stub_submit_series(sid, mid, playlist_id)
    )
    importer = ImportService.__new__(ImportService)  # 不真起流水线，只验分发
    bili = StubSeriesBili([], {})

    result = await batch.submit_any(importer, bili, f"【合集】 {SERIES_URL} 快来听！")

    assert calls == [(678, 12345, 0)]
    assert result["mode"] == "series" and result["importId"] == "t1"


# ---- 收藏 / 删除语义 ----


def _seed_series(db_env):
    """建一个 2 视频系列容器（视频 B 多 2 个分 P），返回 (album, songs)。"""
    with dbs.new_session() as session:
        album = Album(kind="series", source_bvid="sid:678", title="系列",
                      total_pages=3, materialized_pages=3)
        session.add(album)
        session.flush()
        rows = [
            Song(bvid="BVone", aid=101, cid=1, title="一", artist="UP", duration=100,
                 audio_path="", cover_path="", album_id=album.id, track_no=1, collected=False),
            Song(bvid="BVtwo", aid=102, cid=21, title="二 · 上", artist="UP", duration=100,
                 audio_path="", cover_path="", album_id=album.id, track_no=2, collected=False),
            Song(bvid="BVtwo", aid=102, cid=22, title="二 · 下", artist="UP", duration=100,
                 audio_path="", cover_path="", album_id=album.id, track_no=3, collected=False),
        ]
        for row in rows:
            session.add(row)
        session.commit()
        for row in rows:
            session.refresh(row)
        session.refresh(album)
    return album, rows


async def test_uncollect_bvid_rows_retreats_all_pages_of_video(db_env):
    album, rows = _seed_series(db_env)
    for row in rows:
        library.collect_song(row.id)
    assert all(s.collected for s in _album_songs(album.id))

    library.uncollect_bvid_rows("BVtwo", album.id)

    after = _album_songs(album.id)
    assert next(s.collected for s in after if s.bvid == "BVone") is True
    two = [s for s in after if s.bvid == "BVtwo"]
    assert len(two) == 2 and all(not s.collected for s in two)  # 同视频分 P 一起退


async def test_find_fav_folder_by_bvid_reuses_sibling_record(db_env):
    album, rows = _seed_series(db_env)
    library.update_fav_folder(rows[1].id, 9)
    assert library.find_fav_folder_by_bvid("BVtwo") == 9
    assert library.find_fav_folder_by_bvid("BVone") == 0


async def test_unfavorite_series_songs_per_video_with_defer(db_env):
    album, rows = _seed_series(db_env)
    library.update_fav_folder(rows[0].id, 7)
    library.update_fav_folder(rows[1].id, 8)

    bili = StubSeriesBili([], {}, meta={})
    bili.fail_unfav = {102}  # BVtwo 取消失败
    importer = _make_importer(bili, db_env)

    deferred = []
    ok = await importer.unfavorite_series_songs(
        _album_songs(album.id), on_defer=lambda bvid, aid, fid: deferred.append((bvid, aid, fid))
    )

    assert ok == 1
    assert sorted(bili.unfaved) == [(101, 7)]
    assert deferred == [("BVtwo", 102, 8)]


async def test_syncer_drains_deferred_unfav_and_suppresses_pull(db_env):
    from app.services.sync import SyncService, SyncState
    from tests.test_sync_reconcile import StubBili, StubImporter

    p = playlists.ensure_default()
    playlists.set_folder_ids(p.id, [1])

    bili = StubBili(
        folders=[(1, "bilimusic")],
        contents={1: [{"bvid": "BVtwo", "aid": 102}]},  # 取消失败后仍留在夹里
    )
    importer = StubImporter()
    syncer = SyncService(bili, importer, db_env)

    unfaved = []
    fail_again = True

    async def _unfav(aid, folder_id=0):
        if fail_again:
            raise BiliApiError(-400, "再失败一次")
        unfaved.append((aid, folder_id))
        bili.contents[1] = [v for v in bili.contents[1] if v["bvid"] != "BVtwo"]

    bili.unfavorite_song = _unfav
    syncer.defer_unfav("BVtwo", 102, 1)

    # 第一轮：自愈重试又失败 → 压制拉取，夹里明明有也不导入
    state = SyncState(id="t1")
    await syncer._reconcile(state)
    assert unfaved == []
    assert importer.submitted == []
    assert "BVtwo" in syncer._pull_suppressed

    # 第二轮：自愈成功 → 欠账还清、压制解除，夹里也已没有它
    fail_again = False
    state = SyncState(id="t2")
    await syncer._reconcile(state)
    assert unfaved == [(102, 1)]
    assert importer.submitted == []
    assert "BVtwo" not in syncer._pull_suppressed
