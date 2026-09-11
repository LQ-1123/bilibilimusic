"""BUG-006 音质选档：B 站音质 id 的数字大小 ≠ 音质高低，选档按带宽 + 感知优先级。"""
import pytest

from app.bili.client import AudioStream
from app.bili.quality import pick_best_audio


def _s(qid: int, bw: int) -> AudioStream:
    return AudioStream(quality_id=qid, base_url=f"https://cdn/{qid}.m4s", bandwidth=bw)


def test_hires_beats_192k_even_though_id_is_smaller():
    # 30280(192K) 数值上大于 30251(Hi-Res)：旧的 max(id) 会选到 192K
    streams = [_s(30280, 320_000), _s(30251, 1_000_000)]
    assert pick_best_audio(streams).quality_id == 30251


def test_higher_bandwidth_wins():
    streams = [_s(30216, 60_000), _s(30232, 130_000), _s(30280, 320_000)]
    assert pick_best_audio(streams).quality_id == 30280


def test_same_bandwidth_tie_breaks_by_perceptual_order():
    streams = [_s(30280, 320_000), _s(30251, 320_000)]
    assert pick_best_audio(streams).quality_id == 30251


def test_unknown_id_falls_back_to_bandwidth():
    streams = [_s(99999, 320_000), _s(30232, 130_000)]
    assert pick_best_audio(streams).quality_id == 99999


def test_empty_raises():
    with pytest.raises(ValueError):
        pick_best_audio([])
