"""分析组装：PCM → TrackAnalysis JSON。"""

import numpy as np

from app.analysis import features, points, tempo, vocal
from app.analysis.decode import TARGET_SR, decode_mono

ANALYSIS_VERSION = 1


def _downsample_curve(curve: np.ndarray, fps: float, per_second: float) -> list:
    """帧曲线 → 每秒 per_second 个点的 [t, v] 列表。"""
    if not len(curve):
        return []
    step = max(1, int(round(fps / per_second)))
    idx = np.arange(0, len(curve), step)
    return [
        [round(float(i) / fps, 2), round(float(curve[i]), 3)] for i in idx
    ]


def analyze_samples(x: np.ndarray, sr: int = TARGET_SR) -> dict:
    """对已解码的单声道样本做完整分析（可独立测试）。"""
    duration = round(len(x) / sr, 3)
    fps = features.frames_per_second(sr)

    rms = features.rms_curve(x)
    mag = features.stft_magnitude(x)
    onset = features.spectral_flux(mag)
    centroid = features.spectral_centroid(mag, sr)
    low, mid, high = features.band_energies(mag, sr)

    bpm, bpm_confidence = tempo.estimate_tempo(onset, sr)
    beats_t, beat_period, first_beat = tempo.beat_grid(onset, bpm, sr)
    downbeat = tempo.downbeat_offset(beats_t, onset, sr)

    vocal_1s = vocal.vocal_proxy(mid, onset, rms, sr)

    # 能量归一化（dB 域 min-max）
    db = 20.0 * np.log10(rms.astype(np.float64) + 1e-8)
    if float(db.max() - db.min()) > 1e-6:
        energy_norm = np.clip((db - db.min()) / (db.max() - db.min()), 0, 1)
    else:
        energy_norm = np.zeros_like(rms)
    energy_norm = features.moving_average(energy_norm, 0.3, sr)
    energy_2s = np.round(energy_norm[:: max(1, int(fps / 2))], 3)
    energy_curve = [[round(i / (fps / max(1, int(fps / 2))), 2), float(v)] for i, v in enumerate(energy_2s)]
    vocal_curve = [[float(i), float(v)] for i, v in enumerate(vocal_1s)]

    # 谱心距归一化到 0~1（供 SpectralScore 用，取 2/s）
    cen = centroid.copy()
    if len(cen) and float(cen.max()) > 1e-6:
        cen = cen / cen.max()
    centroid_2s = _downsample_curve(cen, fps, 2.0)

    entries = points.entry_points(beats_t, downbeat, vocal_1s, energy_norm, duration)
    exits = points.exit_points(beats_t, downbeat, vocal_1s, energy_norm, duration)

    return {
        "version": ANALYSIS_VERSION,
        "duration": duration,
        "bpm": bpm,
        "bpmConfidence": round(bpm_confidence, 3),
        "beatPeriod": beat_period,
        "firstBeat": first_beat,
        "downbeatOffset": downbeat,
        "beats": [float(b) for b in beats_t],
        "energyCurve": energy_curve,
        "vocalCurve": vocal_curve,
        "centroidCurve": centroid_2s,
        "lowFrequencyEnergy": [[t, round(float(low[min(int(t * fps), len(low) - 1)]), 3)] for t, _ in energy_curve],
        "entryPoints": entries,
        "exitPoints": exits,
    }


def analyze_file(path: str) -> dict:
    return analyze_samples(decode_mono(path))
