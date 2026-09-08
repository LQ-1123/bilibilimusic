"""B 站搜索结果解析：标题高亮标签清理 + 时长文本转秒。"""

import time

import httpx

from app.bili.client import BiliClient, parse_duration_text, strip_highlight
from app.core.cookies import CookieStore


def test_strip_highlight_removes_em_tags():
    raw = '<em class="keyword">寄明月</em>官方MV'
    assert strip_highlight(raw) == "寄明月官方MV"


def test_strip_highlight_multiple_and_attrs():
    raw = '<em class="keyword">洛</em>天依<em class="keyword">新歌</em>'
    assert strip_highlight(raw) == "洛天依新歌"


def test_strip_highlight_plain_title_untouched():
    assert strip_highlight("普通标题") == "普通标题"


def test_duration_minutes_seconds():
    assert parse_duration_text("4:12") == 252


def test_duration_hours():
    assert parse_duration_text("1:02:33") == 3753


def test_duration_invalid_returns_zero():
    assert parse_duration_text("") == 0
    assert parse_duration_text(None) == 0
    assert parse_duration_text("--:--") == 0
    assert parse_duration_text("4:1a") == 0


async def test_search_users_reads_upic_as_https_avatar(tmp_path):
    """用户搜索接口将头像放在 upic，而非用户卡片接口的 face 字段。"""
    client = BiliClient(CookieStore(tmp_path / "cookies.json"))
    await client.http.aclose()
    client.http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={"code": 0, "data": {"result": [{
                    "mid": 1001,
                    "uname": "陶喆的音乐产房",
                    "usign": "DT in The Studio!",
                    "fans": 1_067_000,
                    "upic": "//i0.hdslb.com/bfs/face/tao.jpg",
                }]}},
            )
        )
    )
    client._wbi = ("a" * 32, "b" * 32)
    client._wbi_at = time.time()

    try:
        users = await client.search_users("陶喆")
    finally:
        await client.aclose()

    assert users[0]["face"] == "https://i0.hdslb.com/bfs/face/tao.jpg"
