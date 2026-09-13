"""T1 轻缓存存储层：穿写落盘、完整/部分判定、LRU 淘汰、一键清空。"""

import pytest

from app.config import settings
from app.storage import cache


@pytest.fixture(autouse=True)
def cache_env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)


def test_finish_with_full_bytes_marks_complete():
    w = cache.Writer(cache.cache_key("BV1xx411c7mD", 111, "best"))
    w.write(b"abcdefgh")
    w.finish(8)
    path = cache.get(cache.cache_key("BV1xx411c7mD", 111, "best"))
    assert path is not None and path.read_bytes() == b"abcdefgh"
    # 无 tmp 残留
    assert not list(path.parent.glob("*.part"))


def test_finish_with_missing_bytes_keeps_partial():
    w = cache.Writer(cache.cache_key("BV1xx411c7mD", 111, "best"))
    w.write(b"abc")  # 说好 8 字节只到了 3：听了一半就断
    w.finish(8)
    assert cache.get(cache.cache_key("BV1xx411c7mD", 111, "best")) is None
    hit = cache.get_partial(cache.cache_key("BV1xx411c7mD", 111, "best"))
    assert hit is not None
    path, size = hit
    assert size == 3 and path.read_bytes() == b"abc"


def test_client_abort_partial_is_fallback_not_full():
    w = cache.Writer(cache.cache_key("BV1xx411c7mD", 0, "64"))
    w.write(b"xyz")
    w.finish(None)  # 上游没声明全长（异常路径）
    assert cache.get(cache.cache_key("BV1xx411c7mD", 0, "64")) is None
    assert cache.get_partial(cache.cache_key("BV1xx411c7mD", 0, "64")) is not None


def test_discard_leaves_nothing():
    w = cache.Writer(cache.cache_key("BV1dead", 1, "best"))
    w.write(b"zzz")
    w.discard()
    assert cache.get(cache.cache_key("BV1dead", 1, "best")) is None
    assert cache.get_partial(cache.cache_key("BV1dead", 1, "best")) is None
    assert not list((settings.data_dir / "audio-cache").glob("*.part"))


def test_size_evicts_oldest_over_cap(monkeypatch):
    monkeypatch.setattr(cache, "MAX_BYTES", 100)
    for i in range(4):
        w = cache.Writer(cache.cache_key(f"BV{i:010d}", 0, "best"))
        w.write(bytes([i]) * 40)
        w.finish(40)
    keys = [cache.cache_key(f"BV{i:010d}", 0, "best") for i in range(4)]
    assert cache.get(keys[0]) is None  # 最早的被挤出去
    assert cache.get(keys[1]) is None
    assert cache.get(keys[2]) is not None  # 剩下的在 100 字节以内
    assert cache.get(keys[3]) is not None


def test_get_touch_refreshes_lru(monkeypatch):
    monkeypatch.setattr(cache, "MAX_BYTES", 120)
    for i in range(3):
        w = cache.Writer(cache.cache_key(f"BV{i:010d}", 0, "best"))
        w.write(bytes([i]) * 40)
        w.finish(40)
    first = cache.cache_key("BV0000000000", 0, "best")
    assert cache.get(first) is not None  # 摸一下最老的 → 变新
    w = cache.Writer(cache.cache_key("BV9999999999", 0, "best"))
    w.write(b"y" * 40)
    w.finish(40)  # 池子超了，淘汰最老的 → 是 BV1 而不是刚摸过的 BV0
    assert cache.get(first) is not None
    assert cache.get(cache.cache_key("BV0000000001", 0, "best")) is None


def test_clear_wipes_everything():
    w = cache.Writer(cache.cache_key("BV1xx411c7mD", 5, "192"))
    w.write(b"music")
    w.finish(5)
    assert cache.stats()["count"] == 1
    cache.clear()
    assert cache.stats() == {"count": 0, "bytes": 0}
    assert cache.get(cache.cache_key("BV1xx411c7mD", 5, "192")) is None


def test_write_failure_degrades_silently(tmp_path, monkeypatch):
    w = cache.Writer(cache.cache_key("BV1xx411c7mD", 7, "best"))
    monkeypatch.setattr(w, "_fh", FailingFH())
    w.write(b"data")  # 磁盘满等：不抛异常，标记弃缓存
    w.finish(4)
    assert cache.get(cache.cache_key("BV1xx411c7mD", 7, "best")) is None


class FailingFH:
    def write(self, data):
        raise OSError("disk full")

    def close(self):
        pass
