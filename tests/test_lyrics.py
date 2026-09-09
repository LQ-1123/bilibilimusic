"""歌词功能：B站字幕→LRC 转换、标题清洗、LRCLIB 匹配、字幕接口客户端与取词优先级。"""

import time

import httpx
import pytest

from app.bili.client import BiliClient
from app.bili.subtitle import format_lrc_time, subtitle_body_to_lrc
from app.config import settings
from app.core import url_guard
from app.db.models import Song
from app.services.lyrics import (
    LyricsService,
    looks_synced,
    match_confidence,
    normalize_text,
    pick_lrclib_result,
    strip_meta_lines,
    title_candidates,
)


# ---- LRC 转换 ----

def test_format_lrc_time():
    assert format_lrc_time(0) == "00:00.00"
    assert format_lrc_time(65.36) == "01:05.36"
    assert format_lrc_time(3.996) == "00:04.00"  # 四舍五入进位
    assert format_lrc_time(-1) == "00:00.00"  # 负数兜底为 0


def test_subtitle_body_to_lrc():
    body = [
        {"from": 3.5, "to": 5.0, "content": "第二句"},
        {"from": 1.0, "to": 2.0, "content": "第一句"},
        {"from": 6.0, "to": 7.0, "content": "  "},  # 空内容丢弃
        {"from": 2.0, "to": 3.0, "content": "乱序行"},
        "not-a-dict",
    ]
    assert subtitle_body_to_lrc(body) == (
        "[00:01.00]第一句\n[00:02.00]乱序行\n[00:03.50]第二句"
    )


# ---- 标题清洗 ----

def test_title_candidates_strips_noise_tags():
    cands = title_candidates("【4K修复】晴天-周杰伦【官方MV】")
    assert "晴天 周杰伦" in cands
    assert "晴天" in cands and "周杰伦" in cands


def test_title_candidates_book_marks_become_separator():
    # 「歌手《歌名》」结构：书名号转分隔，歌名成为独立候选
    cands = title_candidates("周杰伦《晴天》")
    assert "晴天" in cands


def test_title_candidates_falls_back_to_bracket_inner():
    assert title_candidates("【晴天】") == ["晴天"]


def test_title_candidates_keeps_raw_fallback():
    assert title_candidates("晴天") == ["晴天"]


def test_title_candidates_drops_noise_only_segments():
    # 「翻唱」段是纯噪声应从清洗候选中丢弃（原始标题兜底候选除外）
    cands = title_candidates("翻唱｜晴天 - 周杰伦（AI修复版）")
    assert "晴天 周杰伦" in cands
    assert "晴天" in cands


def test_title_candidates_part_title_comes_first():
    # BUG-008：多P合集「主标题 · 分P标题」时，分P标题才是歌名，必须排在候选最前
    title = "【周杰伦】50首精选合集/后台播放/无损音质/HIFI音质/华语流行音乐才是最叼的 · 周杰伦-兰亭序"
    cands = title_candidates(title)
    assert "兰亭序" in cands[:3], cands
    assert "周杰伦 兰亭序" in cands[:2], cands


def test_title_candidates_keeps_part_song_for_english_titles():
    cands = title_candidates("【Rammstein】德国战车 MV精选（DVD） · Feuer frei!")
    assert "Feuer frei!" in cands[:2], cands


# ---- 置信度校验（BUG-007） ----

def test_normalize_text_strips_punctuation_and_case():
    assert normalize_text("No Strings Attached") == "nostringsattached"
    assert normalize_text("《晴天》-周杰伦") == "晴天周杰伦"


def test_strip_meta_lines_drops_credit_lines():
    lrc = (
        "[00:00.00] 作词 : Chieh-lun Chou\n"
        "[00:00.00] 作曲 : Chieh-lun Chou\n"
        "[00:02.25]词：周杰伦\n"
        "[00:29.36]故事的小黄花\n"
        "[00:33.10]从出生那年就飘着"
    )
    assert strip_meta_lines(lrc) == "[00:29.36]故事的小黄花\n[00:33.10]从出生那年就飘着"


def test_strip_meta_lines_keeps_lyric_containing_colon():
    lrc = "[00:10.00]我说：你好\n[00:12.00]他说：再见"
    assert strip_meta_lines(lrc) == lrc


def test_looks_synced_rejects_all_zero_timestamps():
    # 网易云「沈幼楚」那条：12 行全是 [00:00.000]，旧判定会被骗过
    lrc = "\n".join(f"[00:00.000]·第{i}句" for i in range(12))
    assert looks_synced(lrc, 60) is False


def test_looks_synced_rejects_short_timeline():
    lrc = "[00:01.00]只有两句\n[00:02.00]还是两句"
    assert looks_synced(lrc, 300) is False


def test_looks_synced_accepts_real_timeline():
    lrc = "[00:29.36]故事的小黄花\n[00:33.10]从出生那年就飘着\n[00:36.50]童年的荡秋千\n[02:01.00]随记忆一直晃到现在"
    assert looks_synced(lrc, 299) is True


def test_match_confidence_rejects_wrong_song_name():
    # 网易云把 Rammstein《Ich tu dir weh》配成 Jaymes Young《Infinity》
    score = match_confidence(
        candidate="德国战车 MV精选 Ich tu dir weh", name="Infinity",
        item_artist="Jaymes Young", song_title="【Rammstein】德国战车 MV精选（DVD） · Ich tu dir weh",
        song_artist="david_-young", duration=237, item_duration=237.0, synced=True,
    )
    assert score == 0


def test_match_confidence_rejects_out_of_tolerance_duration():
    score = match_confidence(
        candidate="晴天", name="晴天", item_artist="周杰伦", song_title="晴天",
        song_artist="某UP主", duration=299, item_duration=180.0, synced=True,
    )
    assert score == 0


def test_match_confidence_nsync_collision_stays_below_strict_threshold():
    # 同名 + 时长接近但歌手对不上：严格模式必须挡掉
    score = match_confidence(
        candidate="No Strings Attached", name="No Strings Attached",
        item_artist="'N Sync", song_title="【step.jad依加】巡演 · No Strings Attached",
        song_artist="舒心音乐驿站", duration=248, item_duration=250.3, synced=True,
    )
    assert 0 < score < 7


def test_match_confidence_accepts_jay_chou_lyric():
    # 修正候选后 LRCLIB 的《兰亭序》命中：歌名包含 + 歌手在标题里 + 时长完全吻合
    score = match_confidence(
        candidate="周杰伦 兰亭序", name="兰亭序", item_artist="周杰伦",
        song_title="【周杰伦】50首精选合集 · 周杰伦-兰亭序", song_artist="超级爱下雨天",
        duration=254, item_duration=254.0, synced=True,
    )
    assert score >= 7


# ---- LRCLIB 结果选择 ----

def test_pick_lrclib_prefers_duration_match_and_synced():
    items = [
        {"duration": 299.0, "syncedLyrics": "[00:29.36]故事的小黄花", "plainLyrics": "故事的小黄花"},
        {"duration": 180.0, "syncedLyrics": "[00:10.00]别的歌", "plainLyrics": ""},
        {"duration": 30.0, "syncedLyrics": "[00:01.00]试听片段", "plainLyrics": ""},
    ]
    hit = pick_lrclib_result(items, 298)
    assert hit is not None and hit[1] is True
    assert "[00:29.36]故事的小黄花" in hit[0]


def test_pick_lrclib_rejects_duration_out_of_tolerance():
    items = [{"duration": 400.0, "syncedLyrics": "[00:01.00]x", "plainLyrics": "x"}]
    assert pick_lrclib_result(items, 250) is None


def test_pick_lrclib_plain_fallback():
    items = [{"duration": 250.0, "syncedLyrics": "", "plainLyrics": "纯文本歌词"}]
    assert pick_lrclib_result(items, 250) == ("纯文本歌词", False)


def test_pick_lrclib_instrumental():
    items = [{"duration": 250.0, "syncedLyrics": "", "plainLyrics": "", "instrumental": True}]
    assert pick_lrclib_result(items, 250) == ("纯音乐，请欣赏", False)


# ---- BiliClient 字幕接口（MockTransport 离线覆盖） ----

def _bili_client_with(handler) -> BiliClient:
    client = BiliClient.__new__(BiliClient)  # 跳过 CookieStore 初始化，注入 wbi 与 http
    client._wbi = ("a" * 32, "b" * 32)  # wbi key 为 32 位十六进制样式的假 key
    client._wbi_at = time.time()
    client.http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    )
    return client


_SUBTITLES_PAYLOAD = {
    "code": 0,
    "data": {
        "subtitle": {
            "subtitles": [
                {"id": 2, "lan": "ai-zh", "ai_type": 1,
                 "subtitle_url": "//aisubtitle.hdslb.com/bfs/ai/sub2.json"},
                {"id": 1, "lan": "zh-CN", "ai_type": 0,
                 "subtitle_url": "//aisubtitle.hdslb.com/bfs/cc/sub1.json"},
                {"id": 3, "lan": "en", "ai_type": 0, "subtitle_url": ""},  # 无地址应过滤
            ]
        }
    },
}


async def test_get_subtitle_tracks_and_download(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        if request.url.path == "/x/player/wbi/v2":
            return httpx.Response(200, json=_SUBTITLES_PAYLOAD)
        if request.url.host == "aisubtitle.hdslb.com":
            return httpx.Response(200, json={"body": [
                {"from": 1.0, "to": 2.0, "content": "故事的小黄花"},
            ]})
        return httpx.Response(404)

    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: ("1.2.3.4",))
    client = _bili_client_with(handler)
    tracks = await client.get_subtitle_tracks("BV1xx", 123, 456)
    assert seen["path"] == "/x/player/wbi/v2"
    assert seen["params"]["bvid"] == "BV1xx" and seen["params"]["cid"] == "456"
    assert "w_rid" in seen["params"]  # 走了 WBI 签名
    assert [t["lan"] for t in tracks] == ["ai-zh", "zh-CN"]  # 无地址的已过滤

    body = await client.download_subtitle_body(tracks[1]["subtitle_url"])
    assert body[0]["content"] == "故事的小黄花"


# ---- 取词优先级 ----

class FakeBili:
    def __init__(self, tracks, body):
        self.tracks = tracks
        self.body = body

    async def get_subtitle_tracks(self, bvid, aid, cid):
        return self.tracks

    async def download_subtitle_body(self, url):
        return self.body


_CC_TRACK = {"lan": "zh-CN", "ai_type": 0, "subtitle_url": "//aisubtitle.hdslb.com/cc.json"}
_AI_TRACK = {"lan": "ai-zh", "ai_type": 1, "subtitle_url": "//aisubtitle.hdslb.com/ai.json"}
_BODY = [{"from": 1.0, "to": 2.0, "content": "故事的小黄花"}]


def _song(**kw) -> Song:
    defaults = dict(bvid="BV1xx", aid=1, cid=2, title="晴天", artist="某UP主", duration=299)
    defaults.update(kw)
    return Song(**defaults)


_LRCLIB_SYNCED = (
    "[00:29.36]故事的小黄花\n[00:33.10]从出生那年就飘着\n"
    "[00:36.50]童年的荡秋千\n[02:01.00]随记忆一直晃到现在"
)


def _lrclib_http(calls: list, results: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json=[{
            "trackName": "晴天",
            "artistName": "某UP主",
            "duration": 299.0,
            "syncedLyrics": _LRCLIB_SYNCED,
            "plainLyrics": "故事的小黄花",
        }] if results is None else results)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_fetch_priority_cc_beats_lrclib():
    calls: list = []
    svc = LyricsService(FakeBili([_CC_TRACK], _BODY), http=_lrclib_http(calls))
    result = await svc.fetch_for_song(_song())
    assert result == ("[00:01.00]故事的小黄花", "cc")
    assert calls == []  # CC 字幕命中即短路，不应请求 LRCLIB


async def test_fetch_ai_fallback_when_lrclib_empty():
    calls: list = []
    svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=_lrclib_http(calls, results=[]))
    result = await svc.fetch_for_song(_song())
    assert result == ("[00:01.00]故事的小黄花", "ai")
    assert calls  # AI 兜底前先试过 LRCLIB


async def test_fetch_lrclib_when_no_subtitle():
    svc = LyricsService(FakeBili([], []), http=_lrclib_http([]))
    result = await svc.fetch_for_song(_song())
    assert result is not None
    lyrics, source = result
    assert source == "lrclib"
    assert "[00:29.36]故事的小黄花" in lyrics


async def test_fetch_returns_none_when_all_sources_empty():
    def empty_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    svc = LyricsService(
        FakeBili([], []), http=httpx.AsyncClient(transport=httpx.MockTransport(empty_handler))
    )
    assert await svc.fetch_for_song(_song()) is None


async def test_fetch_ai_beats_lrclib_plain_text():
    async with _lrclib_http([], results=[{
        "trackName": "晴天", "artistName": "某UP主", "duration": 299, "plainLyrics": "只有纯文本",
    }]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        assert await svc.fetch_for_song(_song()) == ("[00:01.00]故事的小黄花", "ai")


async def test_fetch_lrclib_plain_text_when_no_ai_subtitle():
    async with _lrclib_http([], results=[{
        "trackName": "晴天", "artistName": "某UP主", "duration": 299, "plainLyrics": "只有纯文本",
    }]) as http:
        svc = LyricsService(FakeBili([], []), http=http)
        assert await svc.fetch_for_song(_song()) == ("只有纯文本", "lrclib")


async def test_fetch_lrclib_synced_beats_ai():
    async with _lrclib_http([]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        result = await svc.fetch_for_song(_song())
        assert result == (_LRCLIB_SYNCED, "lrclib")


async def test_fetch_instrumental_marker_beats_ai():
    async with _lrclib_http([], results=[{
        "trackName": "晴天", "artistName": "某UP主", "duration": 299, "instrumental": True,
    }]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        assert await svc.fetch_for_song(_song()) == ("纯音乐，请欣赏", "lrclib")


async def test_fetch_lrclib_low_confidence_falls_through_to_ai():
    """BUG-007 核心：LRCLIB 命中的是别的歌时必须继续降级，而不是把错配显示出来。"""
    async with _lrclib_http([], results=[{
        "trackName": "Infinity", "artistName": "Jaymes Young",
        "duration": 299, "syncedLyrics": _LRCLIB_SYNCED,
    }]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        assert await svc.fetch_for_song(_song()) == ("[00:01.00]故事的小黄花", "ai")


async def test_fetch_lrclib_fake_timeline_downgrades_to_plain():
    """全零时间戳的「带轴」歌词不算带轴，只能作为纯文本兜底。"""
    zero = "\n".join(f"[00:00.000]第{i}句歌词" for i in range(8))
    async with _lrclib_http([], results=[{
        "trackName": "晴天", "artistName": "某UP主",
        "duration": 299, "syncedLyrics": zero, "plainLyrics": "第0句歌词",
    }]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        assert await svc.fetch_for_song(_song()) == ("[00:01.00]故事的小黄花", "ai")


# ---- 网易云源（#10；默认关闭，需 BM_LYRICS_NETEASE=1）----

def _ncm_http(calls: list, *, songs: list | None = None, lyric: str = "", fail: bool = False):
    """网易云接口桩：search 返回 songs，lyric 返回歌词；fail=True 模拟网络故障。"""
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(url)
        if fail:
            raise httpx.ConnectError("ncm down", request=request)
        if "/api/search/get/web" in url:
            return httpx.Response(200, json={"result": {"songs": songs or []}, "code": 200})
        if "/api/song/lyric" in url:
            return httpx.Response(200, json={"lrc": {"lyric": lyric}, "code": 200})
        return httpx.Response(404)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _no_netcdf_guard(monkeypatch):
    """关掉网易云限频与冷却，让单元测试即时完成；同时打开网易云源。"""
    import app.services.lyrics as mod
    monkeypatch.setattr(mod, "_NETEASE_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(mod, "_ncm_state", {"last": 0.0, "cooldown_until": 0.0})
    monkeypatch.setattr(settings, "lyrics_netease", True)
    monkeypatch.setattr(settings, "lyrics_strict", True)


_NCM_SYNCED = (
    "[00:01.00]故事的小黄花\n[00:33.10]从出生那年就飘着\n"
    "[00:36.50]童年的荡秋千\n[02:01.00]随记忆一直晃到现在"
)


async def test_fetch_netease_disabled_by_default(monkeypatch):
    """默认不碰网易云（BM_LYRICS_NETEASE 未开）。"""
    import app.services.lyrics as mod
    monkeypatch.setattr(mod, "_NETEASE_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(settings, "lyrics_netease", False)
    calls: list = []
    async with _ncm_http(calls, songs=[{"id": 9, "name": "晴天", "duration": 299000}],
                        lyric=_NCM_SYNCED) as http:
        svc = LyricsService(FakeBili([], []), http=http)
        assert await svc.fetch_for_song(_song()) is None
    assert not any("music.163.com" in c for c in calls)


async def test_fetch_netease_synced_beats_ai(monkeypatch):
    _no_netcdf_guard(monkeypatch)
    calls: list = []
    async with _ncm_http(calls, songs=[{
        "id": 9, "name": "晴天", "duration": 299000,
    }], lyric=_NCM_SYNCED) as http:
        svc = LyricsService(FakeBili([], []), http=http)
        result = await svc.fetch_for_song(_song())
    assert result == (_NCM_SYNCED, "ncm")
    assert any("music.163.com" in c for c in calls)


async def test_fetch_netease_skips_wrong_duration(monkeypatch):
    _no_netcdf_guard(monkeypatch)
    calls: list = []
    async with _ncm_http(calls, songs=[{
        "id": 9, "name": "别的歌", "duration": 120000,
    }], lyric="[00:01.00]不是这首") as http:
        svc = LyricsService(FakeBili([], []), http=http)
        result = await svc.fetch_for_song(_song())
    assert result is None  # 时长差太远不采纳，也不落 AI 字幕（无字幕）


async def test_fetch_netease_rejects_zero_timeline(monkeypatch):
    """BUG-007 实测的「沈幼楚」式全零时间戳歌词：必须拒绝，继续降级。"""
    _no_netcdf_guard(monkeypatch)
    zero = "\n".join(f"[00:00.000]·第{i}句" for i in range(12))
    async with _ncm_http([], songs=[{
        "id": 9, "name": "晴天", "duration": 299000,
    }], lyric=zero) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        assert await svc.fetch_for_song(_song()) == ("[00:01.00]故事的小黄花", "ai")


async def test_fetch_netease_failure_silent(monkeypatch):
    _no_netcdf_guard(monkeypatch)
    calls: list = []
    async with _ncm_http(calls, fail=True) as http:
        svc = LyricsService(FakeBili([], []), http=http)
        result = await svc.fetch_for_song(_song())
    assert result is None  # 网易云故障静默降级，不抛错
