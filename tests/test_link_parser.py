"""链接解析单测：重定向用 httpx.MockTransport 模拟，不发真实网络请求。"""

import httpx
import pytest

from app.core import url_guard
from app.core.link_parser import (
    follow_redirects,
    parse_fav_id,
    parse_video_url,
    resolve_share_text,
)


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: ("1.2.3.4",))


def test_parse_direct_video_url():
    ref = parse_video_url("https://www.bilibili.com/video/BV1xx411c7mD?p=3&vd_source=abc")
    assert ref is not None
    assert ref.bvid == "BV1xx411c7mD"
    assert ref.page == 3


def test_parse_av_url():
    ref = parse_video_url("https://www.bilibili.com/video/av170001")
    assert ref is not None
    assert ref.avid == 170001


def test_parse_b23_with_bv_path():
    ref = parse_video_url("https://b23.tv/BV1xx411c7mD")
    assert ref is not None
    assert ref.bvid == "BV1xx411c7mD"


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


@pytest.mark.asyncio
async def test_resolve_share_text_via_short_link():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).startswith("https://b23.tv/abc")
        return httpx.Response(
            302,
            headers={"location": "https://www.bilibili.com/video/BV1xx411c7mD?buvid=1&spm_id_from=x"},
        )

    client = _client_with(handler)
    ref = await resolve_share_text(client, "【超好听的歌】 https://b23.tv/abc 快来听！（分享自 哔哩哔哩客户端）")
    await client.aclose()
    assert ref.bvid == "BV1xx411c7mD"


@pytest.mark.asyncio
async def test_resolve_bare_bvid_text():
    client = _client_with(lambda request: httpx.Response(404))
    ref = await resolve_share_text(client, "BV1xx411c7mD")
    await client.aclose()
    assert ref.bvid == "BV1xx411c7mD"


@pytest.mark.asyncio
async def test_resolve_rejects_private_redirect():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://192.168.1.10/admin"})

    client = _client_with(handler)
    with pytest.raises(url_guard.UnsafeUrlError):
        await resolve_share_text(client, "https://b23.tv/evil")
    await client.aclose()


@pytest.mark.asyncio
async def test_resolve_no_link_raises():
    client = _client_with(lambda request: httpx.Response(404))
    with pytest.raises(ValueError):
        await resolve_share_text(client, "今天天气不错")
    await client.aclose()


def test_parse_fav_id():
    assert parse_fav_id("https://space.bilibili.com/123/favlist?fid=456&ftype=create") == 456
    assert parse_fav_id("看看我的收藏 https://b23.tv/x?fid=789") == 789
    assert parse_fav_id("https://www.bilibili.com/video/BV1xx411c7mD") is None
    assert parse_fav_id("随便一段话") is None


@pytest.mark.asyncio
async def test_follow_redirects_to_fav():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"location": "https://space.bilibili.com/123/favlist?fid=456"},
        )

    client = _client_with(handler)
    final = await follow_redirects(client, "https://b23.tv/abc", stop=parse_fav_id)
    await client.aclose()
    assert "fid=456" in final
