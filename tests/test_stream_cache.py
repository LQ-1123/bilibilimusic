"""T1 轻缓存路由行为：命中直出不碰 CDN、播放穿写落盘、在线全挂时兜底回放。"""

import asyncio
import types

import httpx
import pytest

from app.api.routes import stream_bvid
from app.bili.client import AudioStream
from app.config import settings
from app.storage import cache


class _Resp:
    """模拟上游：返回 200 全量（或可指定 content-range 的 206），按块吐字节。"""

    def __init__(self, payload: bytes, status=200, total=None):
        self.status_code = status
        self.payload = payload
        self.headers = {"content-length": str(len(payload)), "accept-ranges": "bytes"}
        if status == 206:
            cr = f"bytes 0-{len(payload) - 1}/{total if total else len(payload)}"
            self.headers["content-range"] = cr

    async def aiter_bytes(self, n):
        for i in range(0, len(self.payload), n):
            yield self.payload[i : i + n]
        self.exhausted = True

    async def aclose(self):
        pass


class _StreamCtx:
    """async 上下文：中继预取走 http.stream，直接吐同一个 mock 响应。"""

    def __init__(self, resp):
        self.resp = resp

    async def __aenter__(self):
        return self.resp

    async def __aexit__(self, *exc):
        return False


class _HTTP:
    def __init__(self, resp):
        self.resp = resp
        self.calls = 0

    def build_request(self, method, url, headers=None):
        return {"method": method, "url": url, "headers": headers}

    async def send(self, request, stream=False):
        self.calls += 1
        if self.resp is None:
            raise httpx.ConnectError("down")
        return self.resp

    def stream(self, method, url, headers=None):
        self.calls += 1
        if self.resp is None:
            raise httpx.ConnectError("down")
        return _StreamCtx(self.resp)


class _Bili:
    def __init__(self, http):
        self.http = http

    async def video_page_cids(self, bvid):
        return [111]

    async def get_audio_streams(self, bvid, cid):
        return [STREAM]

    def candidate_urls(self, stream):
        return [stream.base_url]


STREAM = AudioStream(
    quality_id=30280,
    base_url="https://upos-sz-mirrorcos.bilivideo.com/a.m4s",
    backup_urls=[],
    bandwidth=192000,
)
PAYLOAD = b"fake-audio-" * 100


def _request(bili, range_header=None):
    return types.SimpleNamespace(
        state=types.SimpleNamespace(bili=bili),
        headers={} if range_header is None else {"range": range_header},
    )


def _run(coro):
    return asyncio.run(coro)


async def _drain(resp):
    if hasattr(resp, "body_iterator"):  # StreamingResponse（在线代理）
        chunks = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk)
        return b"".join(chunks)
    return resp.body  # Response（缓存直出/兜底）


@pytest.fixture(autouse=True)
def cache_env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)


def test_first_request_populates_cache_second_serves_local():
    bili = _Bili(_HTTP(_Resp(PAYLOAD)))
    key = cache.cache_key("BV1xx411c7mD", 111, "best")

    resp1 = _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))
    body1 = _run(_drain(resp1))
    assert body1 == PAYLOAD
    assert cache.get(key) is not None  # 穿写落盘完成

    bili2 = _Bili(_HTTP(None))  # 第二次：CDN 全挂也不该被碰到
    resp2 = _run(stream_bvid("BV1xx411c7mD", _request(bili2), cid=111, range_header=None))
    body2 = _run(_drain(resp2))
    assert body2 == PAYLOAD
    assert bili2.http.calls == 0


def test_range_hit_serves_206_from_file():
    bili = _Bili(_HTTP(_Resp(PAYLOAD)))
    _run(_drain(_run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))))

    resp = _run(
        stream_bvid("BV1xx411c7mD", _request(bili, "bytes=5-14"), cid=111, range_header="bytes=5-14")
    )
    assert resp.status_code == 206
    body = _run(_drain(resp))
    assert body == PAYLOAD[5:15]


def test_midstream_seek_does_not_pollute_cache():
    # seek 请求（start>0）不写缓存：残段拼不回完整文件
    bili = _Bili(_HTTP(_Resp(PAYLOAD[100:], status=206, total=len(PAYLOAD))))
    _run(_drain(_run(stream_bvid("BV1xx411c7mD", _request(bili, "bytes=100-"), cid=111, range_header="bytes=100-"))))
    assert cache.get(cache.cache_key("BV1xx411c7mD", 111, "best")) is None


def test_cdn_dead_serves_cache_fallback():
    key = cache.cache_key("BV1xx411c7mD", 111, "best")
    w = cache.Writer(key)
    w.write(PAYLOAD)
    w.finish(len(PAYLOAD))

    bili = _Bili(_HTTP(None))  # playurl 能给，但 CDN 全连不上
    resp = _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))
    assert resp.status_code == 200
    assert _run(_drain(resp)) == PAYLOAD


def test_no_cache_no_cdn_returns_502():
    bili = _Bili(_HTTP(None))
    with pytest.raises(Exception) as err:
        _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))
    assert "镜像" in str(err.value.detail if hasattr(err.value, "detail") else err.value)


def test_partial_cache_serves_heard_part_when_offline():
    key = cache.cache_key("BV1xx411c7mD", 111, "best")
    w = cache.Writer(key)
    w.write(PAYLOAD[:50])
    w.finish(len(PAYLOAD))  # 听了一半断网

    bili = _Bili(_HTTP(None))
    resp = _run(stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None))
    assert resp.status_code == 200
    assert _run(_drain(resp)) == PAYLOAD[:50]


def test_relay_engages_for_large_streams_and_replay_hits_disk():
    # 大于 64KB 的流进中继模式：起播即后台整曲预取，播完落完整缓存
    big = b"relay-chunk-" * 6200  # ≈ 74KB
    bili = _Bili(_HTTP(_Resp(big)))
    key = cache.cache_key("BV1xx411c7mD", 111, "best")

    async def scenario():
        resp1 = await stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None)
        body = await _drain(resp1)
        await asyncio.sleep(0.2)  # 留出预取任务收尾（最后一块落盘 + meta 写入）
        return body

    assert _run(scenario()) == big
    assert cache.get(key) is not None  # 整曲预取完成

    bili2 = _Bili(_HTTP(None))  # 重放：CDN 全挂也整曲直出（播放只吃本地磁盘）
    resp2 = _run(stream_bvid("BV1xx411c7mD", _request(bili2), cid=111, range_header=None))
    assert _run(_drain(resp2)) == big
    assert bili2.http.calls == 0


def test_relay_serves_range_from_disk_while_prefetching():
    big = b"0123456789" * 9000  # 90KB
    bili = _Bili(_HTTP(_Resp(big)))
    key = cache.cache_key("BV1xx411c7mD", 111, "best")

    async def scenario():
        resp = await stream_bvid("BV1xx411c7mD", _request(bili), cid=111, range_header=None)
        body = await _drain(resp)
        await asyncio.sleep(0.2)
        return body

    assert _run(scenario()) == big  # 先整曲放一遍，落完整缓存
    # 中段 Range：从磁盘直出对应片段，不碰 CDN
    bili2 = _Bili(_HTTP(None))
    resp = _run(stream_bvid("BV1xx411c7mD", _request(bili2, "bytes=100-199"), cid=111, range_header="bytes=100-199"))
    assert resp.status_code == 206
    assert _run(_drain(resp)) == big[100:200]
    assert bili2.http.calls == 0
