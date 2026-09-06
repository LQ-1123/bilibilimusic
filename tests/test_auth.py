"""登录回归：使用真实 CookieStore/httpx CookieJar，只替换 B 站网络响应。"""

import time
from urllib.parse import urlencode

import httpx
import pytest

from app.bili.client import BiliApiError, BiliClient
from app.core.cookies import CookieStore


@pytest.fixture
async def make_client(tmp_path):
    clients = []

    async def make(handler, initial=None):
        store = CookieStore(tmp_path / f"cookies-{len(clients)}.json")
        store.set_many(initial or {})
        client = BiliClient(store)
        await client.http.aclose()
        client.http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), cookies=store.all()
        )
        clients.append(client)
        return client

    yield make
    for client in clients:
        await client.aclose()


def login_response(method, cookies=None, **data):
    payload = {"code" if method == "qr" else "status": 0, **data}
    return httpx.Response(
        200,
        json={"code": 0, "message": "0", "data": payload},
        headers=[
            ("set-cookie", f"{key}={value}; Domain=.bilibili.com; Path=/; Secure")
            for key, value in (cookies or {}).items()
        ],
    )


async def login(client, method):
    if method == "qr":
        return await client.qrcode_poll("a" * 32)
    return await client.sms_login("13800000000", "123456", "captcha-key")


@pytest.mark.parametrize("method", ["qr", "sms"])
async def test_login_replaces_previous_identity_and_sends_one_session_cookie(make_client, method):
    request_cookies = []

    def handler(request):
        if request.url.host == "passport.bilibili.com":
            return login_response(method, {
                "SESSDATA": "session-b", "bili_jct": "csrf-b",
                "DedeUserID": "202", "DedeUserID__ckMd5": "check-b",
            })
        request_cookies.append(request.headers.get("cookie", ""))
        return httpx.Response(200, json={
            "code": 0, "data": {"isLogin": True, "mid": 202, "uname": "账号 B"},
        })

    client = await make_client(handler, {
        "SESSDATA": "session-a", "bili_jct": "csrf-a", "DedeUserID": "101",
        "mid": "101", "fav_folder_id": "1001", "buvid3": "device-a",
    })
    client._me = (time.time() + 600, {"isLogin": True, "mid": 101, "uname": "账号 A"})
    await login(client, method)

    assert (await client.my_info())["mid"] == 202
    assert await client.get_my_mid() == 202
    assert client.store.get("DedeUserID") == "202"
    assert client.store.get("DedeUserID__ckMd5") == "check-b"
    assert client.store.get("fav_folder_id") is None
    assert client.store.get("buvid3") == "device-a"
    assert request_cookies
    assert all(header.count("SESSDATA=") == 1 for header in request_cookies)
    assert all("session-a" not in header for header in request_cookies)


@pytest.mark.parametrize("method", ["qr", "sms"])
async def test_login_without_session_cookies_is_rejected(make_client, method):
    client = await make_client(lambda request: login_response(method))
    with pytest.raises(BiliApiError):
        await login(client, method)
    assert not client.store.logged_in


async def test_sms_requires_completed_login_status(make_client):
    client = await make_client(lambda request: login_response(
        "sms", {"SESSDATA": "session-b", "bili_jct": "csrf-b"}, status=1,
        url="https://passport.bilibili.com/account/security",
    ))
    with pytest.raises(BiliApiError):
        await login(client, "sms")
    assert not client.store.logged_in


async def test_qr_checks_outer_api_error(make_client):
    client = await make_client(lambda request: httpx.Response(200, json={
        "code": -412, "message": "请求被拦截", "data": {"code": 0},
    }))
    with pytest.raises(BiliApiError) as error:
        await login(client, "qr")
    assert error.value.code == -412


async def test_qr_can_read_login_cookies_from_bilibili_callback(make_client):
    query = urlencode({"SESSDATA": "session-b", "bili_jct": "csrf-b", "DedeUserID": "202"})
    client = await make_client(lambda request: login_response(
        "qr", url=f"https://passport.bilibili.com/login?{query}",
    ))
    result = await login(client, "qr")
    assert result.status == "confirmed"
    assert client.store.get("SESSDATA") == "session-b"
    assert client.store.get("DedeUserID") == "202"


async def test_logout_clears_identity_and_cookies_across_domains(make_client):
    client = await make_client(lambda request: httpx.Response(200, json={"code": -101}), {
        "SESSDATA": "session-a", "bili_jct": "csrf-a", "DedeUserID": "101",
        "DedeUserID__ckMd5": "check-a", "dedeuserid": "101", "sid": "sid-a",
        "mid": "101", "fav_folder_id": "1001", "buvid3": "device-a",
    })
    client._me = (time.time() + 600, {"mid": 101, "uname": "账号 A"})
    client.http.cookies.set("SESSDATA", "session-a", domain=".bilibili.com")
    client.http.cookies.set("DedeUserID", "101", domain="passport.bilibili.com")
    client.logout()

    assert client.store.all() == {"buvid3": "device-a"}
    assert await client.my_info() == {}
    assert "SESSDATA" not in client.http.cookies
    assert "DedeUserID" not in client.http.cookies
    assert CookieStore(client.store.path).all() == {"buvid3": "device-a"}


async def test_expired_session_is_not_still_accepted_by_local_login_gate(make_client):
    client = await make_client(lambda request: httpx.Response(200, json={
        "code": -101, "data": {"isLogin": False},
    }), {"SESSDATA": "expired", "bili_jct": "csrf-a", "mid": "101"})
    assert not (await client.login_status())["loggedIn"]
    assert not client.store.logged_in
