"""Smart Transition 分析单测：合成信号 + 真实文件冒烟。"""

import os
from pathlib import Path

import numpy as np
import pytest

from app.analysis.analyzer import analyze_samples
from app.analysis.decode import decode_mono

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SR = 11025


def _click_track(duration: float, bpm: float, sr: int = SR) -> np.ndarray:
    """合成节拍脉冲序列：每拍一个短促低音脉冲。"""
    x = np.zeros(int(duration * sr), dtype=np.float32)
    period = 60.0 / bpm
    t_beat = 0.0
    while t_beat < duration:
        start = int(t_beat * sr)
        n = int(0.05 * sr)
        if start + n < len(x):
            t = np.arange(n, dtype=np.float32) / sr
            x[start : start + n] += np.sin(2 * np.pi * 70 * t) * np.exp(-t * 40)
        t_beat += period
    return x


def test_bpm_detection_synthetic_120():
    x = _click_track(16.0, 120.0)
    a = analyze_samples(x)
    assert a["bpm"] != 0
    assert abs(a["bpm"] - 120.0) <= 3.0, f"detected {a['bpm']}"


def test_bpm_detection_synthetic_90():
    x = _click_track(16.0, 90.0)
    a = analyze_samples(x)
    assert a["bpm"] != 0
    # 允许倍频/半频混淆（节拍检测固有歧义），但应落在 ±3 或恰好 2 倍关系
    bpm = a["bpm"]
    ok = abs(bpm - 90) <= 3 or abs(bpm - 180) <= 6 or abs(bpm - 45) <= 3
    assert ok, f"detected {bpm}"


def test_entry_points_prefer_quiet_intro():
    """前 4 秒安静、之后响 → 切入点应集中在开头安静区。"""
    sr = SR
    quiet = 0.05 * np.random.default_rng(7).standard_normal(4 * sr).astype(np.float32)
    loud = 0.6 * np.random.default_rng(8).standard_normal(12 * sr).astype(np.float32)
    x = np.concatenate([quiet, loud])
    a = analyze_samples(x)
    assert a["entryPoints"], "应至少产出一个切入点"
    top = a["entryPoints"][0]
    assert top["t"] <= 6.0, f"最佳切入点应在安静段内，实际 {top['t']}"


def test_exit_points_prefer_energy_drop():
    """响段之后接 3 秒衰减尾 → 切出点应偏向尾部。"""
    sr = SR
    rng = np.random.default_rng(9)
    loud = 0.6 * rng.standard_normal(10 * sr).astype(np.float32)
    tail = np.concatenate([
        np.linspace(0.6, 0.05, 3 * sr, dtype=np.float32)
    ]) * rng.standard_normal(3 * sr).astype(np.float32)
    x = np.concatenate([loud, tail])
    a = analyze_samples(x)
    assert a["exitPoints"], "应至少产出一个切出点"
    durations = [p["t"] for p in a["exitPoints"]]
    assert max(durations) >= 8.0, f"切出点应靠近尾部，实际 {durations}"


def test_analysis_payload_shape():
    x = _click_track(10.0, 120.0)
    a = analyze_samples(x)
    for key in (
        "version", "duration", "bpm", "bpmConfidence", "beats",
        "energyCurve", "vocalCurve", "centroidCurve", "entryPoints", "exitPoints",
    ):
        assert key in a, f"缺少字段 {key}"
    assert a["duration"] == pytest.approx(10.0, abs=0.2)
    for p in a["entryPoints"] + a["exitPoints"]:
        assert set(p) >= {"t", "score", "beatAligned", "phraseAligned", "type"}
        assert 0 <= p["score"] <= 1


def test_decode_real_file_smoke():
    music_dir = PROJECT_ROOT / "data" / "music"
    files = sorted(music_dir.glob("*.m4a")) if music_dir.exists() else []
    if not files:
        pytest.skip("data/music 下没有真实文件")
    x = decode_mono(str(files[0]))
    assert len(x) > SR * 10, "解码样本过短"
    # 真实母带存在带内峰值（inter-sample peak），解码可略超 1.0；只做有限值 + 粗界校验
    assert np.isfinite(x).all()
    assert np.abs(x).max() <= 4.0


def test_analyze_real_file_smoke():
    music_dir = PROJECT_ROOT / "data" / "music"
    files = sorted(music_dir.glob("*.m4a")) if music_dir.exists() else []
    if not files:
        pytest.skip("data/music 下没有真实文件")
    a = analyze_samples(decode_mono(str(files[0])))
    assert a["duration"] > 30
    assert a["entryPoints"] and a["exitPoints"]
    assert 0 <= a["bpmConfidence"] <= 1
