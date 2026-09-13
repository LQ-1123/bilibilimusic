"""T1 轻缓存：只缓存听过的音频流（播放时穿写落盘），池上限 500MB，可一键清空。

定位是「防打断兜底」而非下载器（2026-09-11 T1 裁决）：无管理界面、容量封顶、
越界即淘汰。键 = (bvid, cid, tier)：同一首不同档位帽各存一份（弱网降档的
64K 同样值得兜底）。所有写失败都静默降级——缓存永远不能弄断播放。
"""

import json
import logging
import os
import time
import uuid
from pathlib import Path

from app.config import settings

log = logging.getLogger(__name__)

MAX_BYTES = 500 * 1024 * 1024  # 缓存池上限：500MB，超出按最久未听淘汰


def _cache_dir() -> Path:
    return settings.data_dir / "audio-cache"


def cache_key(bvid: str, cid: int | None, tier: str | None) -> str:
    return f"{bvid}_{int(cid or 0)}_{tier or 'best'}"


def _meta_path(key: str) -> Path:
    return _cache_dir() / f"{key}.json"


def _read_meta(key: str) -> dict | None:
    try:
        meta = json.loads(_meta_path(key).read_text(encoding="utf-8"))
        return meta if isinstance(meta, dict) else None
    except (OSError, ValueError):
        return None


def _touch(key: str, meta: dict) -> None:
    """命中即刷新 LRU 时间戳。"""
    meta["at"] = time.time()
    try:
        _meta_path(key).write_text(json.dumps(meta), encoding="utf-8")
    except OSError:
        pass


class Writer:
    """穿写句柄：代理 CDN 流的同时落盘；收尾时按实收字节数定完整/部分。"""

    def __init__(self, key: str) -> None:
        self.key = key
        d = _cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        self.tmp = d / f"{key}.{uuid.uuid4().hex}.part"
        self.final_path = d / f"{key}.m4a"
        self.bytes = 0
        self._dead = False
        self._fh = open(self.tmp, "wb")

    def write(self, chunk: bytes) -> None:
        if self._dead:
            return
        try:
            self._fh.write(chunk)
            self.bytes += len(chunk)
        except OSError as exc:  # 磁盘满等：弃缓存，播放继续
            log.warning("cache 写入失败，本曲放弃缓存：%s", exc)
            self.discard()

    def finish(self, total: int | None) -> None:
        """total 是上游声明的全长；实收不足即部分缓存（听过的部分仍可兜底回放）。"""
        if self._dead:
            return
        if self.bytes == 0:  # 一个块都没落上：不算「听过」，直接丢弃
            self.discard()
            return
        try:
            self._fh.close()
            os.replace(self.tmp, self.final_path)
            complete = total is not None and total > 0 and self.bytes >= total
            meta = {
                "key": self.key,
                "bytes": self.bytes,
                "complete": complete,
                "at": time.time(),
            }
            _meta_path(self.key).write_text(json.dumps(meta), encoding="utf-8")
        except OSError as exc:
            log.warning("cache 收尾失败：%s", exc)
            self.discard()
            return
        evict_if_over()

    def discard(self) -> None:
        if self._dead:
            return
        self._dead = True
        try:
            self._fh.close()
        except OSError:
            pass
        try:
            self.tmp.unlink()
        except OSError:
            pass


def get(key: str) -> Path | None:
    """完整缓存文件路径；命中刷新 LRU。"""
    p = _cache_dir() / f"{key}.m4a"
    meta = _read_meta(key)
    if not meta or not meta.get("complete") or not p.exists():
        return None
    _touch(key, meta)
    return p


def get_partial(key: str) -> tuple[Path, int] | None:
    """部分缓存（听到一半断了）：返回 (文件, 已落盘字节数) 供兜底响应。"""
    p = _cache_dir() / f"{key}.m4a"
    meta = _read_meta(key)
    if not meta or not p.exists() or int(meta.get("bytes", 0)) <= 0:
        return None
    _touch(key, meta)
    return p, int(meta["bytes"])


def evict_if_over() -> None:
    """池子超 500MB 就从最久未听的开始删，删到回到上限以内。"""
    d = _cache_dir()
    if not d.exists():
        return
    entries = []  # (at, stem, bytes)
    for p in d.glob("*.json"):
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(m, dict):
                entries.append((float(m.get("at", 0)), p.stem, int(m.get("bytes", 0))))
        except (OSError, ValueError):
            continue
    total = sum(e[2] for e in entries)
    if total <= MAX_BYTES:
        return
    entries.sort()
    for _, stem, size in entries:
        if total <= MAX_BYTES:
            break
        for p in (d / f"{stem}.m4a", d / f"{stem}.json"):
            try:
                p.unlink()
            except OSError:
                pass
        total -= size


def stats() -> dict:
    d = _cache_dir()
    if not d.exists():
        return {"count": 0, "bytes": 0}
    total = 0
    count = 0
    for p in d.glob("*.m4a"):
        meta = _read_meta(p.stem)
        total += int(meta.get("bytes", 0)) if meta else p.stat().st_size
        count += 1
    return {"count": count, "bytes": total}


def clear() -> dict:
    d = _cache_dir()
    removed = 0
    if d.exists():
        for p in d.iterdir():
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return {"cleared": removed}
