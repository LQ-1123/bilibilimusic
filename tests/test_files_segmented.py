"""分段并发下载单测：MockTransport 模拟 CDN（支持/不支持 Range）。"""

import httpx
import pytest

from app.core import url_guard
from app.storage.files import FileStore

BLOCK = bytes(range(256)) * 256  # 64KB 伪随机图案
PAYLOAD = BLOCK * 24  # 1.5MB


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: ("1.2.3.4",))


def _handler(support_range: bool):
    total = len(PAYLOAD)

    def handler(request: httpx.Request) -> httpx.Response:
        rng = request.headers.get("range")
        if support_range and rng:
            unit = rng.split("=", 1)[1]
            start_s, _, end_s = unit.partition("-")
            start = int(start_s)
            end = min(int(end_s), total - 1) if end_s else total - 1
            return httpx.Response(
                206,
                headers={"content-range": f"bytes {start}-{end}/{total}"},
                content=PAYLOAD[start : end + 1],
            )
        return httpx.Response(200, content=PAYLOAD)

    return handler


async def _download(tmp_path, support_range: bool):
    store = FileStore(tmp_path / "music", tmp_path / "covers")
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_handler(support_range)), follow_redirects=False
    )
    dest = store.music_dir / "BV1xx411c7mD.m4a"
    progresses: list[tuple[int, int]] = []
    await store.download(
        client,
        ["https://upos-sz-mirror.bilivideo.com/x.m4a"],
        dest,
        on_progress=lambda d, t: progresses.append((d, t)),
    )
    await client.aclose()
    return dest, progresses


async def test_segmented_download_assembles_exact_bytes(tmp_path):
    dest, progresses = await _download(tmp_path, support_range=True)
    assert dest.read_bytes() == PAYLOAD
    assert progresses[-1][0] == len(PAYLOAD)
    assert not list(dest.parent.glob("*.part"))  # 临时文件已清理/改名


async def test_fallback_when_range_unsupported(tmp_path):
    # 服务端忽略 Range 恒回 200：分段失败后应自动回退单流并完整落盘
    dest, _ = await _download(tmp_path, support_range=False)
    assert dest.read_bytes() == PAYLOAD
