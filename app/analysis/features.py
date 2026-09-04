"""帧级特征：RMS 能量、STFT 频谱（谱心距 / 谱通量 / 分频段能量）。

帧 512 / hop 256 @11025Hz ≈ 23ms 帧移。低频段取 20~150Hz——
两首歌叠加时 Kick+Bass 的低频冲突最容易被听出来。
"""

import numpy as np

FRAME = 512
HOP = 256


def frame_count(n_samples: int) -> int:
    if n_samples < FRAME:
        return 0
    return (n_samples - FRAME) // HOP + 1


def _frames(x: np.ndarray) -> np.ndarray:
    n = frame_count(len(x))
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(n)[:, None]
    return x[idx]


def rms_curve(x: np.ndarray) -> np.ndarray:
    frames = _frames(x)
    if not len(frames):
        return np.zeros(0, dtype=np.float32)
    return np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)).astype(np.float32)


def stft_magnitude(x: np.ndarray) -> np.ndarray:
    frames = _frames(x)
    if not len(frames):
        return np.zeros((0, FRAME // 2 + 1), dtype=np.float32)
    hann = np.hanning(FRAME).astype(np.float32)
    return np.abs(np.fft.rfft(frames * hann, axis=1)).astype(np.float32)


def freqs(sr: int = 11025) -> np.ndarray:
    return np.fft.rfftfreq(FRAME, 1.0 / sr)


def spectral_centroid(mag: np.ndarray, sr: int = 11025) -> np.ndarray:
    """逐帧谱心距（Hz），无帧时返回空数组。"""
    if not len(mag):
        return np.zeros(0, dtype=np.float32)
    f = freqs(sr)
    total = mag.sum(axis=1) + 1e-9
    return (mag @ f / total).astype(np.float32)


def spectral_flux(mag: np.ndarray) -> np.ndarray:
    """谱通量（半波整流的对数谱差分求和）→ onset 强度包络。"""
    if len(mag) < 2:
        return np.zeros(max(len(mag), 0), dtype=np.float32)
    log_mag = np.log1p(mag)
    diff = np.diff(log_mag, axis=0)
    flux = np.clip(diff, 0, None).sum(axis=1)
    flux = np.concatenate([[0.0], flux]).astype(np.float32)
    # 归一化：去均值后按均值缩放，让自相关 tempo 不受响度影响
    m = flux.mean()
    if m > 1e-9:
        flux = (flux - m) / m
    return np.clip(flux, 0, None).astype(np.float32)


def band_energies(mag: np.ndarray, sr: int = 11025):
    """返回 (low, mid, high) 逐帧能量占比，low 为 20~150Hz。"""
    f = freqs(sr)
    total = mag.sum(axis=1) + 1e-9
    low = mag[:, (f >= 20) & (f <= 150)].sum(axis=1) / total
    mid = mag[:, (f >= 300) & (f <= 3000)].sum(axis=1) / total
    high = mag[:, (f > 3000)].sum(axis=1) / total
    return low.astype(np.float32), mid.astype(np.float32), high.astype(np.float32)


def moving_average(x: np.ndarray, seconds: float, sr: int = 11025, hop: int = HOP) -> np.ndarray:
    win = max(1, int(seconds * sr / hop))
    kernel = np.ones(win, dtype=np.float64) / win
    padded = np.concatenate([np.zeros(win - 1, dtype=np.float64), x.astype(np.float64)])
    return np.convolve(padded, kernel, mode="valid").astype(np.float32)


def frames_per_second(sr: int = 11025, hop: int = HOP) -> float:
    return sr / hop
