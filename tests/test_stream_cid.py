"""F0 流路由 cid：多分 P 歌曲按存的 cid 取流，伪造 cid 拒绝（不静默播错）。"""

import time

import httpx
import pytest
from fastapi import HTTPException

from app.api.routes import _pick_stream_cid, song_out
from app.bili.client import BiliApiError, BiliClient
from app.core.cookies import CookieStore
from app.db.models import Song


@pytest.fixture
async def client(tmp_path):
    c = BiliClient(CookieStore(tmp_path / "cookies.json"))
    await c.http.aclose()
    c.http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={"code": 0, "data": {"pages": [
                    {"cid": 111, "part": "第一首"},
                    {"cid": 222, "part": "第二首"},
                    {"cid": 333, "part": "第三首"},
                ]}},
            )
        )
    )
    c._wbi = ("a" * 32, "b" * 32)
    c._wbi_at = time.time()
    yield c
    await c.aclose()


async def test_video_page_cids_reads_all_pages(client):
    assert await client.video_page_cids("BV1xx411c7mD") == [111, 222, 333]


async def test_video_page_cids_raises_on_empty(client):
    await client.http.aclose()
    client.http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"code": 0, "data": {}})
        )
    )
    client._wbi = ("a" * 32, "b" * 32)
    client._wbi_at = time.time()
    with pytest.raises(BiliApiError):
        await client.video_page_cids("BV1xx411c7mD")


def test_pick_stream_cid_defaults_to_first_page():
    assert _pick_stream_cid([111, 222, 333], None) == 111
    assert _pick_stream_cid([111, 222, 333], 0) == 111  # 0 视为未指定


def test_pick_stream_cid_routes_explicit_cid():
    assert _pick_stream_cid([111, 222, 333], 333) == 333


def test_pick_stream_cid_rejects_foreign_cid():
    with pytest.raises(HTTPException) as exc:
        _pick_stream_cid([111, 222, 333], 999)
    assert exc.value.status_code == 400


def test_song_audio_url_carries_cid():
    multi = Song(bvid="BV1xx411c7mD", cid=222, title="t", artist="a", audio_path="")
    assert song_out(multi)["audioUrl"] == "/api/stream/BV1xx411c7mD?cid=222"
    single = Song(bvid="BV1xx411c7mD", cid=111, title="t", artist="a", audio_path="")
    assert song_out(single)["audioUrl"] == "/api/stream/BV1xx411c7mD?cid=111"
