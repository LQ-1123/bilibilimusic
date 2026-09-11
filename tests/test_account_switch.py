"""真实 FastAPI/SQLite 账号切换回归，B 站接口用内存 transport 隔离。"""

import asyncio
import json
from http.cookies import SimpleCookie

import httpx
import pytest
from sqlmodel import select

from app.bili.client import BiliClient
from app.config import settings
from app.core.cookies import CookieStore
from app.db import session as dbs
from app.db.models import Playlist, Song
from app.main import app
from app.services.sync import SyncService


class Passport:
    def __init__(self):
        self.mid = 101
        self.reject_mid = None

    def __call__(self, request):
        path = request.url.path
        if path.endswith(("/qrcode/poll", "/login/sms")):
            status = {"code": 0} if path.endswith("/qrcode/poll") else {"status": 0}
            return httpx.Response(200, json={"code": 0, "data": status}, headers=[
                ("set-cookie", f"{key}={value}; Domain=.bilibili.com; Path=/")
                for key, value in {
                    "SESSDATA": f"session-{self.mid}", "bili_jct": f"csrf-{self.mid}",
                    "DedeUserID": str(self.mid),
                }.items()
            ])
        if path.endswith("/nav"):
            cookies = SimpleCookie(request.headers.get("cookie", ""))
            sess = cookies.get("SESSDATA")
            mid = int(sess.value.removeprefix("session-")) if sess else 0
            if not mid or mid == self.reject_mid:
                return httpx.Response(200, json={"code": -101, "data": {"isLogin": False}})
            return httpx.Response(200, json={"code": 0, "data": {
                "isLogin": True, "mid": mid, "uname": f"账号 {mid}", "face": "",
            }})
        if path.endswith("/finger/spi"):
            return httpx.Response(200, json={"code": 0, "data": {"b_3": "device", "b_4": "device4"}})
        raise AssertionError(f"Unexpected Bilibili request: {path}")


@pytest.fixture
async def api(tmp_path, monkeypatch):
    for name, value in {
        "data_dir": tmp_path, "db_path": tmp_path / "bilibili_music.db",
        "cookie_path": tmp_path / "cookies.json", "music_dir": tmp_path / "music",
        "cover_dir": tmp_path / "covers", "api_token": "",
    }.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(dbs, "_engines", {})
    monkeypatch.setattr(dbs, "_current_mid", None)
    passport = Passport()
    original_init = BiliClient.__init__
    clients = []
    unused_http_clients = []

    def init(self, store, *args, **kwargs):
        original_init(self, store, *args, **kwargs)
        unused_http_clients.append(self.http)
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(passport), cookies=store.session_cookies())
        clients.append(self)

    # 自动同步另有服务测试；此处只禁用外部收藏副作用，登录/激活/数据库均用真实实现。
    async def quiet(self):
        pass

    monkeypatch.setattr(BiliClient, "__init__", init)
    monkeypatch.setattr(SyncService, "reconcile_quietly", quiet)
    monkeypatch.setattr(app.router, "routes", list(app.router.routes))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as web:
            yield web, passport
    for client in clients:
        await client.aclose()
    for client in unused_http_clients:
        await client.aclose()
    for engine in dbs._engines.values():
        engine.dispose()


async def sign_in(web, passport, mid, method="qr"):
    passport.mid = mid
    if method == "qr":
        return await web.get("/api/auth/qrcode/" + "a" * 32)
    return await web.post("/api/auth/sms/login", json={
        "tel": "13800000000", "code": "123456", "captchaKey": "captcha-key",
    })


def add_song(bvid, title):
    with dbs.new_session() as session:
        session.add(Song(bvid=bvid, title=title, cid=1, artist="UP", audio_path="", cover_path=""))
        session.commit()


@pytest.mark.parametrize("method", ["qr", "sms"])
async def test_switch_preserves_old_credentials_and_restores_each_library(api, method):
    web, passport = api
    assert (await sign_in(web, passport, 101, method)).is_success
    add_song("BV1xx411c7mD", "A 的歌曲")
    cookie_a = dbs.account_cookie_path("101").read_text()

    assert (await sign_in(web, passport, 202, method)).is_success
    assert (await web.get("/api/auth/status")).json()["username"] == "账号 202"
    assert (await web.get("/api/songs")).json()["songs"] == []
    assert dbs.account_cookie_path("101").read_text() == cookie_a
    assert json.loads(dbs.account_cookie_path("202").read_text())["mid"] == "202"
    assert (await web.get("/api/playlists")).json()["playlists"]
    add_song("BV1xx411c7mE", "B 的歌曲")

    assert (await sign_in(web, passport, 101, method)).is_success
    songs = (await web.get("/api/songs")).json()["songs"]
    assert [song["title"] for song in songs] == ["A 的歌曲"]
    assert (await web.get("/api/auth/status")).json()["username"] == "账号 101"


@pytest.mark.parametrize("method", ["qr", "sms"])
async def test_failed_verification_keeps_existing_account_and_returns_error(api, method):
    web, passport = api
    assert (await sign_in(web, passport, 101, method)).is_success
    add_song("BV1xx411c7mD", "A 的歌曲")
    cookie_a = dbs.account_cookie_path("101").read_text()
    passport.reject_mid = 202

    result = await sign_in(web, passport, 202, method)
    assert result.status_code in (400, 502)
    assert result.json()["detail"]
    assert dbs.active_mid() == "101"
    assert dbs.account_cookie_path("101").read_text() == cookie_a
    assert (await web.get("/api/auth/status")).json()["username"] == "账号 101"
    assert [song["title"] for song in (await web.get("/api/songs")).json()["songs"]] == ["A 的歌曲"]


@pytest.mark.parametrize("endpoint", ["/api/auth/logout", "/api/auth"])
async def test_logout_clears_active_account_marker_and_protects_private_routes(api, endpoint):
    web, passport = api
    assert (await sign_in(web, passport, 101)).is_success
    response = await (web.post(endpoint) if endpoint.endswith("logout") else web.delete(endpoint))
    assert response.is_success
    assert dbs.active_mid() is None
    assert not dbs.active_mid_file().exists()
    assert not (await web.get("/api/auth/status")).json()["loggedIn"]
    assert (await web.get("/api/songs")).status_code == 401
    saved = json.loads(dbs.account_cookie_path("101").read_text())
    assert "SESSDATA" not in saved and "mid" not in saved


async def test_database_failure_during_activation_does_not_report_login_success(api, monkeypatch):
    web, passport = api
    assert (await sign_in(web, passport, 101)).is_success

    def fail(mid, *args, **kwargs):
        raise OSError("test database unavailable")

    monkeypatch.setattr(dbs, "activate_account", fail)
    result = await sign_in(web, passport, 202)
    assert result.status_code >= 400
    assert dbs.active_mid() == "101"
    assert (await web.get("/api/auth/status")).json()["username"] == "账号 101"


async def test_inflight_request_keeps_original_database_after_switch(api):
    web, passport = api
    started, release = asyncio.Event(), asyncio.Event()

    @app.get("/test/delayed-account-write")
    async def delayed_write():
        started.set()
        await release.wait()
        with dbs.new_session() as session:
            session.add(Playlist(name="A 的延迟写入"))
            session.commit()
        return {"ok": True}

    assert (await sign_in(web, passport, 101)).is_success
    pending = asyncio.create_task(web.get("/test/delayed-account-write"))
    await asyncio.wait_for(started.wait(), timeout=2)
    try:
        assert (await sign_in(web, passport, 202)).is_success
    finally:
        release.set()
        await pending
    with dbs.new_session() as session:
        assert "A 的延迟写入" not in [p.name for p in session.exec(select(Playlist)).all()]
    assert (await sign_in(web, passport, 101)).is_success
    with dbs.new_session() as session:
        assert "A 的延迟写入" in [p.name for p in session.exec(select(Playlist)).all()]


async def stop_for_restart():
    await app.state.accounts.aclose()
    for engine in dbs._engines.values():
        engine.dispose()
    dbs._engines.clear()
    dbs._current_mid = None


async def test_restart_restores_verified_account_and_library(api):
    web, passport = api
    assert (await sign_in(web, passport, 101)).is_success
    add_song("BV1xx411c7mD", "A 的歌曲")
    await stop_for_restart()
    async with app.router.lifespan_context(app):
        status = (await web.get("/api/auth/status")).json()
        assert status["loggedIn"] and status["username"] == "账号 101"
        assert [song["title"] for song in (await web.get("/api/songs")).json()["songs"]] == ["A 的歌曲"]


async def test_logout_then_restart_does_not_resurrect_legacy_login(api):
    web, passport = api
    assert (await sign_in(web, passport, 101)).is_success
    CookieStore(settings.cookie_path).set_many({
        "SESSDATA": "session-101", "bili_jct": "csrf-101", "mid": "101",
    })
    assert (await web.post("/api/auth/logout")).is_success
    await stop_for_restart()
    async with app.router.lifespan_context(app):
        assert not (await web.get("/api/auth/status")).json()["loggedIn"]
        assert (await web.get("/api/songs")).status_code == 401


async def test_restart_rejects_cookie_belonging_to_another_directory(api):
    web, passport = api
    assert (await sign_in(web, passport, 101)).is_success
    add_song("BV1xx411c7mD", "A 的歌曲")
    await stop_for_restart()
    CookieStore(dbs.account_cookie_path("101")).replace_login({
        "SESSDATA": "session-202", "bili_jct": "csrf-202", "DedeUserID": "202",
    })
    async with app.router.lifespan_context(app):
        assert not (await web.get("/api/auth/status")).json()["loggedIn"]
        assert (await web.get("/api/songs")).status_code == 401
        assert not dbs.account_db_path("202").exists()


async def test_new_account_does_not_inherit_unverified_legacy_library(api):
    web, passport = api
    add_song("BV1xx411c7mD", "归属尚未核验的旧曲库")
    assert (await sign_in(web, passport, 202)).is_success
    assert (await web.get("/api/songs")).json()["songs"] == []
    assert settings.db_path.exists()


async def test_retired_client_cannot_erase_a_new_login_for_same_account(api):
    web, passport = api
    assert (await sign_in(web, passport, 101)).is_success
    retired = app.state.bili
    assert (await sign_in(web, passport, 202)).is_success
    assert (await sign_in(web, passport, 101)).is_success
    cookie_a = dbs.account_cookie_path("101").read_text()
    # 旧请求迟到的登录失效响应，不能清掉同一账号的新一轮登录凭据。
    retired.logout()
    assert dbs.account_cookie_path("101").read_text() == cookie_a


async def test_legacy_identity_mismatch_cannot_assign_old_library_to_new_login(api):
    web, _ = api
    add_song("BV1xx411c7mD", "A 的旧版曲库")
    CookieStore(settings.cookie_path).set_many({
        "SESSDATA": "session-202", "bili_jct": "csrf-202", "mid": "101",
    })
    await stop_for_restart()
    async with app.router.lifespan_context(app):
        assert not (await web.get("/api/auth/status")).json()["loggedIn"]
        assert not dbs.account_db_path("202").exists()
        assert settings.db_path.exists()
