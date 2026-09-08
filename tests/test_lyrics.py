"""歌词功能：B站字幕→LRC 转换、标题清洗、LRCLIB 匹配、字幕接口客户端与取词优先级。"""

import time

import httpx
import pytest

from app.bili.client import BiliClient
from app.bili.subtitle import format_lrc_time, subtitle_body_to_lrc
from app.core import url_guard
from app.db.models import Song
from app.services.lyrics import LyricsService, pick_lrclib_result, title_candidates


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


def _lrclib_http(calls: list, results: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json=[{
            "duration": 299.0,
            "syncedLyrics": "[00:29.36]故事的小黄花\n[00:33.10]从出生那年就飘着",
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
        "duration": 299, "plainLyrics": "只有纯文本",
    }]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        assert await svc.fetch_for_song(_song()) == ("[00:01.00]故事的小黄花", "ai")


async def test_fetch_lrclib_plain_text_when_no_ai_subtitle():
    async with _lrclib_http([], results=[{
        "duration": 299, "plainLyrics": "只有纯文本",
    }]) as http:
        svc = LyricsService(FakeBili([], []), http=http)
        assert await svc.fetch_for_song(_song()) == ("只有纯文本", "lrclib")


async def test_fetch_lrclib_synced_beats_ai():
    async with _lrclib_http([]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        result = await svc.fetch_for_song(_song())
        assert result == (
            "[00:29.36]故事的小黄花\n[00:33.10]从出生那年就飘着", "lrclib",
        )


async def test_fetch_instrumental_marker_beats_ai():
    async with _lrclib_http([], results=[{
        "duration": 299, "instrumental": True,
    }]) as http:
        svc = LyricsService(FakeBili([_AI_TRACK], _BODY), http=http)
        assert await svc.fetch_for_song(_song()) == ("纯音乐，请欣赏", "lrclib")
