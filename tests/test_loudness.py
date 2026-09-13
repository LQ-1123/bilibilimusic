"""A4 音量均衡：响度缓存接口（客户端实测落库，跨设备共享）。"""

import pytest
from fastapi import HTTPException

from app.api.routes import LoudnessIn, get_loudness, save_loudness
from app.config import settings
from app.db import session as dbs


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


async def test_loudness_roundtrip(db_env):
    assert await get_loudness("BV1xx411c7mD", 7) == {"db": None}
    assert await save_loudness(LoudnessIn(bvid="BV1xx411c7mD", cid=7, db=-15.3, duration=201.2)) == {"ok": True}
    assert await get_loudness("BV1xx411c7mD", 7) == {"db": -15.3}
    # 不同分 P 是不同的曲，不串响度
    assert await get_loudness("BV1xx411c7mD", 9) == {"db": None}
    # 重听复测：覆盖更新
    await save_loudness(LoudnessIn(bvid="BV1xx411c7mD", cid=7, db=-14.9))
    assert await get_loudness("BV1xx411c7mD", 7) == {"db": -14.9}


async def test_loudness_cid_defaults_to_first_page_key(db_env):
    await save_loudness(LoudnessIn(bvid="BV1xx411c7mD", db=-16.5))
    assert await get_loudness("BV1xx411c7mD") == {"db": -16.5}
    assert await get_loudness("BV1xx411c7mD", 0) == {"db": -16.5}


async def test_loudness_rejects_bad_bvid(db_env):
    with pytest.raises(HTTPException):
        await get_loudness("av12345")
    with pytest.raises(HTTPException):
        await save_loudness(LoudnessIn(bvid="av12345", db=-16))


async def test_loudness_rejects_out_of_range_db(db_env):
    # 正值与低于 -60 都是脏数据：会把增益算上天或全无意义
    with pytest.raises(HTTPException):
        await save_loudness(LoudnessIn(bvid="BV1xx411c7mD", db=3))
    with pytest.raises(HTTPException):
        await save_loudness(LoudnessIn(bvid="BV1xx411c7mD", db=-70))
