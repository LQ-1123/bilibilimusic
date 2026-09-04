"""BPM / 节拍网格 / 强拍与乐句相位（传统自相关方法，±1~2 BPM 精度足够）。"""

import numpy as np

from app.analysis.features import frames_per_second

MIN_BPM = 60
MAX_BPM = 190


def estimate_tempo(onset_env: np.ndarray, sr: int = 11025, hop: int = 256):
    """梳状滤波测速：对每个候选 BPM 在精确的分数周期位置插值取 onset 能量。

    相比整数 lag 自相关，避免长信号相位漂移导致的倍周期误判。
    同一信号在 BPM 与 BPM/2 处得分往往接近，按「从快到慢取第一个
    显著峰（≥0.9×全局最大）」偏向快拍解释。返回 (bpm, confidence)。
    """
    fps = frames_per_second(sr, hop)
    n = len(onset_env)
    if n < fps * 4:  # 少于 4 秒无法估拍
        return 0.0, 0.0
    env = onset_env.astype(np.float64) - onset_env.mean()
    peak = env.max() + 1e-9
    if np.abs(env).sum() < 1e-9:
        return 0.0, 0.0

    bpms = np.arange(MIN_BPM, MAX_BPM + 0.25, 0.25)
    scores = np.zeros(len(bpms))
    for i, bpm in enumerate(bpms):
        period = 60.0 * fps / bpm
        pos = np.arange(0.0, n, period)
        hit = np.interp(pos, np.arange(n), env)
        # 归一化成“网格命中率”：平均每次命中强度 / 信号峰值
        scores[i] = float(hit.mean()) / peak

    gmax = float(scores.max())
    if gmax <= 1e-9:
        return 0.0, 0.0
    pick = None
    for i in range(1, len(scores) - 1):
        if scores[i] >= scores[i - 1] and scores[i] >= scores[i + 1] and scores[i] >= 0.9 * gmax:
            pick = i
            break
    if pick is None:
        pick = int(np.argmax(scores))
    bpm = float(bpms[pick])
    confidence = float(np.clip(scores[pick] / gmax, 0, 1))
    return round(bpm, 1), round(confidence, 3)


def _interp(env: np.ndarray, frame_pos: np.ndarray) -> np.ndarray:
    pos = np.clip(frame_pos, 0, len(env) - 1)
    return np.interp(pos, np.arange(len(env)), env)


def beat_grid(onset_env: np.ndarray, bpm: float, sr: int = 11025, hop: int = 256):
    """在 [0, beat_period) 内搜索 16 个相位，取 onset 能量最大的网格。

    返回 (beats_t 秒序列, beat_period 秒, first_beat 秒)。
    """
    fps = frames_per_second(sr, hop)
    if bpm <= 0 or len(onset_env) < fps:
        return np.zeros(0), 0.0, 0.0
    period = 60.0 * fps / bpm
    n = len(onset_env)
    best_phase, best_score = 0.0, -1.0
    for k in range(16):
        phase = k * period / 16.0
        pos = np.arange(phase, n, period)
        if not len(pos):
            continue
        score = float(_interp(onset_env, pos).sum())
        if score > best_score:
            best_score, best_phase = score, phase
    beat_frames = np.arange(best_phase, n, period)
    beats_t = beat_frames / fps
    return (
        np.round(beats_t, 3),
        round(60.0 / bpm, 4),
        round(float(beats_t[0]) if len(beats_t) else 0.0, 3),
    )


def downbeat_offset(beats_t: np.ndarray, onset_env: np.ndarray, sr: int = 11025, hop: int = 256) -> int:
    """4/4 假设：在 0..3 中选出强拍（bar 起点）相位，返回 beats 数组的偏移量。"""
    fps = frames_per_second(sr, hop)
    if len(beats_t) < 4:
        return 0
    best_phase, best_score = 0, -1.0
    for phase in range(4):
        pos = beats_t[phase::4] * fps
        score = float(_interp(onset_env.astype(np.float32), pos).sum())
        if score > best_score:
            best_score, best_phase = score, phase
    return best_phase
