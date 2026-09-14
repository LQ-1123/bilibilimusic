"""#45 后续：卡顿自愈取证端点（只进日志不落库）。"""

import pytest

from app.api.routes import StallIn, debug_stall
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


async def test_debug_stall_accepts_payload(db_env, caplog):
    with caplog.at_level("WARNING"):
        r = await debug_stall(StallIn(phase="reopen", tries=2, ready_state=2, network_state=2,
                                      current=88.3, duration=200, buffered_ahead=0.4,
                                      hidden=True, tier="64", src="/api/stream/BV1xx411c7mD"))
    assert r == {"ok": True}
    assert "stall-heal" in caplog.text
    assert "reopen" in caplog.text and "hidden=True" in caplog.text
