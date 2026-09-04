"""切入/切出候选点提取。

规范依据：优先 phrase（4 bar）> bar > beat 边界；避开人声密集段；
Exit 偏好能量下降段，Entry 偏好低能量起始与真开头。
"""

import numpy as np

from app.analysis.features import frames_per_second

ENTRY_WINDOW = 30.0     # 只在下一首开头 30s 内找切入点
EXIT_TAIL = 35.0        # 自然结束时只在本曲结尾 35s 内找切出点
TOP_N = 8


def _curve_at(curve: np.ndarray, t: float) -> float:
    """1s 分辨率曲线按秒取值。"""
    if not len(curve):
        return 0.0
    idx = min(len(curve) - 1, max(0, int(t)))
    return float(curve[idx])


def _alignment(beats_t: np.ndarray, downbeat_offset: int, t: float):
    """返回 (beatAligned, barAligned, phraseAligned)。节拍容差 60ms。"""
    if not len(beats_t):
        return False, False, False
    idx = int(np.argmin(np.abs(beats_t - t)))
    if abs(beats_t[idx] - t) > 0.06:
        return False, False, False
    rel = (idx - downbeat_offset) % 4
    bar = rel == 0
    phrase = (idx - downbeat_offset) % 16 == 0
    return True, bar, phrase


def _type_for(t: float, duration: float, phrase: bool, vocal: float, energy_drop: float) -> str:
    if t <= 3.0:
        return "intro"
    if t >= duration - 8.0:
        return "outro"
    if energy_drop > 0.12:
        return "energy_drop"
    if vocal < 0.3:
        return "instrumental"
    if phrase:
        return "phrase"
    return "break"


def entry_points(
    beats_t: np.ndarray,
    downbeat_offset: int,
    vocal_1s: np.ndarray,
    energy_norm: np.ndarray,
    duration: float,
) -> list[dict]:
    candidates = [0.0] + [float(t) for t in beats_t if 0.3 < t <= min(ENTRY_WINDOW, duration * 0.3)]
    out = []
    for t in candidates:
        beat_ok, bar_ok, phrase_ok = _alignment(beats_t, downbeat_offset, t)
        vocal = _curve_at(vocal_1s, t)
        energy = _curve_at(energy_norm, t)
        next_energy = _curve_at(energy_norm, t + 2.0)
        rising = float(np.clip(next_energy - energy + 0.3, 0, 1))  # 能量上升/低起点更适切入
        score = (
            0.30 * (1 - vocal)
            + 0.20 * (1.0 if phrase_ok else (0.5 if bar_ok else 0))
            + 0.20 * (1 - energy)
            + 0.10 * rising
            + 0.20 * (1.0 if t == 0 else 0.5 if beat_ok else 0)
        )
        out.append(
            {
                "t": round(t, 3),
                "score": round(float(np.clip(score, 0, 1)), 3),
                "energy": round(energy, 3),
                "vocalProbability": round(vocal, 2),
                "beatAligned": beat_ok,
                "barAligned": bar_ok,
                "phraseAligned": phrase_ok,
                "type": _type_for(t, duration, phrase_ok, vocal, 0.0),
            }
        )
    out.sort(key=lambda p: -p["score"])
    return out[:TOP_N]


def exit_points(
    beats_t: np.ndarray,
    downbeat_offset: int,
    vocal_1s: np.ndarray,
    energy_norm: np.ndarray,
    duration: float,
) -> list[dict]:
    tail_start = max(duration * 0.4, duration - EXIT_TAIL)
    candidates = [float(t) for t in beats_t if tail_start <= t <= duration - 1.0]
    candidates.append(round(max(duration - 0.15, 0.0), 3))  # 真实结尾兜底
    out = []
    for t in candidates:
        beat_ok, bar_ok, phrase_ok = _alignment(beats_t, downbeat_offset, t)
        vocal = _curve_at(vocal_1s, t)
        energy = _curve_at(energy_norm, t)
        later = _curve_at(energy_norm, t + 1.5)
        energy_drop = float(np.clip((energy - later) * 2.0, 0, 1))  # 之后能量下降更适合切出
        near_end = t >= duration - 6.0
        score = (
            0.30 * (1.0 if phrase_ok else (0.5 if bar_ok else 0))
            + 0.25 * (1 - vocal)
            + 0.20 * energy_drop
            + 0.15 * (1.0 if near_end else 0.4)
            + 0.10 * (1 - abs(energy - 0.5) * 0.5)
        )
        out.append(
            {
                "t": round(t, 3),
                "score": round(float(np.clip(score, 0, 1)), 3),
                "energy": round(energy, 3),
                "vocalProbability": round(vocal, 2),
                "beatAligned": beat_ok,
                "barAligned": bar_ok,
                "phraseAligned": phrase_ok,
                "type": _type_for(t, duration, phrase_ok, vocal, energy_drop),
            }
        )
    out.sort(key=lambda p: -p["score"])
    return out[:TOP_N]
