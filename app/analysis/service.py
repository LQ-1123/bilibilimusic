"""分析缓存与后台调度：内存 → SQLite → 后台线程分析。

规范硬性要求：分析绝不阻塞 API 与播放。get_or_schedule 只查缓存 +
投递后台线程，未就绪立即返回 None（前端降级）。
"""

import json
import threading
import time

from sqlmodel import select

from app.analysis.analyzer import ANALYSIS_VERSION, analyze_file
from app.db.models import TrackAnalysisRow
from app.db.session import new_session

_FAIL_RETRY_SECONDS = 600


class AnalysisService:
    def __init__(self) -> None:
        self._mem: dict[int, dict] = {}
        self._inflight: set[int] = set()
        self._failed_until: dict[int, float] = {}
        self._lock = threading.Lock()

    # ---- 查询 ----

    def get_or_schedule(self, song) -> dict | None:
        """命中缓存返回分析；否则投递后台分析并返回 None（前端降级/稍后再取）。"""
        sid = song.id
        if sid is None:
            return None
        cached = self._get_cached(song)
        if cached is not None:
            return cached
        self.schedule_for_song(song)
        return None

    def get_cached(self, song) -> dict | None:
        return self._get_cached(song)

    def _get_cached(self, song) -> dict | None:
        sid = song.id
        if sid in self._mem:
            return self._mem[sid]
        with new_session() as session:
            row = session.get(TrackAnalysisRow, sid)
        if (
            row is not None
            and row.version == ANALYSIS_VERSION
            and abs(row.duration - song.duration) < 2.0
        ):
            data = json.loads(row.data)
            self._mem[sid] = data
            return data
        return None

    def invalidate(self, song_id: int) -> None:
        self._mem.pop(song_id, None)
        with new_session() as session:
            row = session.get(TrackAnalysisRow, song_id)
            if row is not None:
                session.delete(row)
                session.commit()

    # ---- 后台调度 ----

    def schedule_for_song(self, song) -> bool:
        """投递后台分析；已在队列/已就绪/近期失败时跳过。返回是否真正投递。"""
        sid = song.id
        if sid is None:
            return False
        with self._lock:
            if (
                sid in self._inflight
                or sid in self._mem
                or time.time() < self._failed_until.get(sid, 0)
            ):
                return False
            self._inflight.add(sid)

        audio_path = song.audio_path

        def work() -> None:
            try:
                data = analyze_file(audio_path)
                self._save(song.id, song.bvid, data)
                self._mem[song.id] = data
                self._failed_until.pop(song.id, None)
            except Exception:  # noqa: BLE001  分析失败静默降级，10 分钟内不重试
                self._failed_until[song.id] = time.time() + _FAIL_RETRY_SECONDS
            finally:
                with self._lock:
                    self._inflight.discard(sid)

        threading.Thread(target=work, daemon=True, name=f"analyze-{sid}").start()
        return True

    def _save(self, song_id: int, bvid: str, data: dict) -> None:
        with new_session() as session:
            row = session.get(TrackAnalysisRow, song_id)
            if row is None:
                row = TrackAnalysisRow(song_id=song_id)
            row.bvid = bvid
            row.duration = data.get("duration", 0)
            row.version = ANALYSIS_VERSION
            row.data = json.dumps(data, ensure_ascii=False)
            session.add(row)
            session.commit()
