"""BUG-006 音质选档：B 站音质 id 的数字大小 ≠ 音质高低，选档按带宽 + 感知优先级。"""
import time

import httpx
import pytest

from app.bili.client import AudioStream, BiliClient
from app.bili.quality import pick_best_audio
from app.core.cookies import CookieStore


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


def test_tier_cap_192_excludes_hires_and_dolby():
    streams = [_s(30251, 1_000_000), _s(30280, 320_000), _s(30232, 130_000), _s(30216, 60_000)]
    assert pick_best_audio(streams, tier="192").quality_id == 30280


def test_tier_64_picks_lowest():
    streams = [_s(30280, 320_000), _s(30216, 60_000)]
    assert pick_best_audio(streams, tier="64").quality_id == 30216


def test_tier_cap_empty_falls_back_to_all():
    # 帽内无可用档（未知 id 的流）时回退全量：帽只限流，不拦播放
    streams = [_s(99999, 320_000)]
    assert pick_best_audio(streams, tier="64").quality_id == 99999


def test_unknown_tier_treated_as_best():
    streams = [_s(30280, 320_000), _s(30216, 60_000)]
    assert pick_best_audio(streams, tier="bogus").quality_id == 30280


# ---- dash 解析：Hi-Res/杜比在包装层之下，不能丢（v2.1 真机发现） ----

async def test_get_audio_streams_unwraps_flac_and_dolby(tmp_path):
    """dash.flac = {display, audio}、dash.dolby = {type, audio[]}：流在包装层之下。
    旧代码把 flac 包装层直接喂给解析器（顶层无 baseUrl）→ Hi-Res 被静默丢弃，
    恰被「非会员不下发 flac.audio」掩盖，会员过期复充后真机才暴露。"""
    playurl = {
        "code": 0,
        "data": {
            "accept_quality": [116, 112, 80, 64, 32, 16],
            "dash": {
                "duration": 213,
                "audio": [
                    {"id": 30280, "baseUrl": f"https://cdn/30280.m4s", "bandwidth": 320_000},
                    {"id": 30232, "baseUrl": f"https://cdn/30232.m4s", "bandwidth": 130_000},
                    {"id": 30216, "baseUrl": f"https://cdn/30216.m4s", "bandwidth": 60_000},
                ],
                "flac": {
                    "display": True,
                    "audio": {"id": 30251, "baseUrl": "https://cdn/30251.m4s", "bandwidth": 1_100_000},
                },
                "dolby": {"type": 1, "audio": [{"id": 30250, "baseUrl": "https://cdn/30250.m4s", "bandwidth": 760_000}]},
            },
        },
    }

    async def _fake_playurl(request):
        assert "fnval=" in str(request.url.params)  # DASH+Hi-Res+杜比位必须带着请求
        return httpx.Response(200, json=playurl)

    c = BiliClient(CookieStore(tmp_path / "cookies.json"))
    await c.http.aclose()
    c.http = httpx.AsyncClient(transport=httpx.MockTransport(_fake_playurl))
    c._wbi = ("a" * 32, "b" * 32)
    c._wbi_at = time.time()
    try:
        streams = await c.get_audio_streams("BV1dZ4y1Y7bt", 111)
    finally:
        await c.aclose()

    ids = sorted(s.quality_id for s in streams)
    assert ids == [30216, 30232, 30250, 30251, 30280]
    assert pick_best_audio(streams).quality_id == 30251  # best = Hi-Res


async def test_get_audio_streams_no_vip_omits_flac_without_error(tmp_path):
    """非会员：flac.display 仍为 true 但 audio=null——解析不得报错也不得产出假流。"""
    playurl = {
        "code": 0,
        "data": {
            "dash": {
                "audio": [{"id": 30280, "baseUrl": "https://cdn/30280.m4s", "bandwidth": 320_000}],
                "flac": {"display": True, "audio": None},
                "dolby": {"type": 0, "audio": None},
            },
        },
    }

    async def _fake(request):
        return httpx.Response(200, json=playurl)

    c = BiliClient(CookieStore(tmp_path / "cookies.json"))
    await c.http.aclose()
    c.http = httpx.AsyncClient(transport=httpx.MockTransport(_fake))
    c._wbi = ("a" * 32, "b" * 32)
    c._wbi_at = time.time()
    try:
        streams = await c.get_audio_streams("BV1dZ4y1Y7bt", 111)
    finally:
        await c.aclose()

    assert [s.quality_id for s in streams] == [30280]
