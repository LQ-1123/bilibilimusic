"""人声活动代理（无 AI）。

启发式：人声能量集中于中频段（300Hz~3kHz）且持续段谱通量平稳，
而纯伴奏/打击乐通量起伏大。输出 0~1 的概率曲线（1s 分辨率），
仅用于判断「这一段适不适合与另一首歌叠加」。
"""

import numpy as np

from app.analysis.features import frames_per_second, moving_average


def vocal_proxy(
    mid_ratio: np.ndarray,
    flux: np.ndarray,
    rms: np.ndarray,
    sr: int = 11025,
    hop: int = 256,
) -> np.ndarray:
    """mid_ratio: 中频能量占比（逐帧）；flux: 谱通量（逐帧）；rms: 逐帧能量。

    返回 1s 分辨率曲线。安静段没有可冲突的内容，能量门控把其人声概率压向 0。
    """
    fps = frames_per_second(sr, hop)
    if not len(mid_ratio):
        return np.zeros(0, dtype=np.float32)
    mid_smooth = moving_average(mid_ratio, 0.5, sr, hop)
    raw = np.clip((mid_smooth - 0.32) / 0.38, 0, 1)

    flux_smooth = moving_average(flux, 1.0, sr, hop)
    peak = flux_smooth.max() + 1e-9
    calm = np.clip(1.0 - flux_smooth / peak, 0, 1)

    p = 0.6 * raw + 0.4 * calm

    # 能量门控：相对本曲 90 分位响度很安静的段，视作无人声
    rms_smooth = moving_average(rms, 0.5, sr, hop)
    ref = float(np.percentile(rms_smooth, 90)) + 1e-9
    gate = np.clip(rms_smooth / ref * 2.0, 0, 1)
    p = p * gate

    # 降到 1s 分辨率（每 fps 帧取均值）
    n_seconds = int(len(p) / fps)
    if n_seconds <= 0:
        return np.zeros(0, dtype=np.float32)
    trimmed = p[: n_seconds * int(fps)]
    curve = trimmed.reshape(n_seconds, int(fps)).mean(axis=1)
    return np.round(curve, 2).astype(np.float32)
