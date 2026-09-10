"""#45 弱网取流：/api/stream 在首选 CDN 失败时按候选顺序换源。"""
import asyncio
import types

import httpx
import pytest
from fastapi import HTTPException

from app.api.routes import stream_bvid
from app.bili.client import AudioStream


class _Resp:
    def __init__(self, status):
        self.status_code = status
        self.headers = {"content-length": "1234", "accept-ranges": "bytes"}

    async def aclose(self):
        self.aclosed = True


class _HTTP:
    """记录每次取流的 URL，并按预设脚本返回成功/失败。"""

    def __init__(self, script):
        self.script = script
        self.calls = []

    def build_request(self, method, url, headers=None):
        return {"method": method, "url": url, "headers": headers}

    async def send(self, request, stream=False):
        url = request["url"]
        self.calls.append(url)
        behavior = self.script.get(url, "ok")
        if behavior == "connect_error":
            raise httpx.ConnectError("boom")
        return _Resp(200 if behavior == "ok" else 503)


class _Bili:
    def __init__(self, stream, script):
        self._stream = stream
        self.http = _HTTP(script)

    async def video_page_cids(self, bvid):
        return [111]

    async def get_audio_streams(self, bvid, cid):
        return [self._stream]

    def candidate_urls(self, stream):
        return [stream.base_url, *stream.backup_urls]


def _request(bili, range_header=None):
    return types.SimpleNamespace(
        state=types.SimpleNamespace(bili=bili),
        headers={} if range_header is None else {"range": range_header},
    )


STREAM = AudioStream(
    quality_id=30280,
    base_url="https://upos-sz-mirrorcos.bilivideo.com/a.m4s",
    backup_urls=["https://upos-sz-mirrorali.bilivideo.com/a.m4s"],
    bandwidth=192000,
)


def _run(coro):
    return asyncio.run(coro)


def test_stream_uses_primary_when_healthy():
    bili = _Bili(STREAM, {STREAM.base_url: "ok"})
    resp = _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))
    assert resp.status_code == 200
    assert bili.http.calls == [STREAM.base_url]


def test_stream_falls_back_to_backup_on_connect_error():
    bili = _Bili(STREAM, {STREAM.base_url: "connect_error"})
    resp = _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header="bytes=0-1"))
    assert resp.status_code == 200
    assert bili.http.calls == [STREAM.base_url, STREAM.backup_urls[0]]


def test_stream_falls_back_when_primary_returns_5xx():
    bili = _Bili(STREAM, {STREAM.base_url: "http_503"})
    resp = _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))
    assert resp.status_code == 200
    assert len(bili.http.calls) == 2


def test_stream_reports_502_only_after_all_mirrors():
    bili = _Bili(STREAM, {STREAM.base_url: "http_503", STREAM.backup_urls[0]: "http_503"})
    with pytest.raises(HTTPException) as err:
        _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))
    assert err.value.status_code == 502
    assert "镜像" in err.value.detail
    assert bili.http.calls == [STREAM.base_url, STREAM.backup_urls[0]]


def test_stream_forwards_range_header():
    bili = _Bili(STREAM, {STREAM.base_url: "ok"})
    seen = {}
    orig = bili.http.build_request

    def spy(method, url, headers=None):
        seen.update(headers or {})
        return orig(method, url, headers)

    bili.http.build_request = spy
    _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header="bytes=100-"))
    assert seen.get("Range") == "bytes=100-"
