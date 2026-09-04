"""推荐池纯逻辑：风格分类、时长过滤、今日推荐确定性。"""

from app.services.recs import (
    MAX_DURATION,
    MIN_DURATION,
    classify,
    daily_pick,
    is_song_like,
)


class Item:
    def __init__(self, bvid):
        self.bvid = bvid


def test_classify_rock():
    assert classify("新专辑《摇滚之心》", []) == "摇滚"
    assert classify("cover", ["rock", "band"]) == "摇滚"


def test_classify_rnb_gospel():
    # 实测种子场景：黑人福音翻唱
    assert classify("", ["孙燕姿", "SUNO", "黑人福音"]) == "R&B"


def test_classify_pop_folk_rap():
    assert classify("年度流行金曲合集", []) == "流行"
    assert classify("翻唱一首经典民谣", []) == "民谣"
    assert classify("地下说唱现场", []) == "说唱"


def test_classify_guzheng_and_unknown():
    assert classify("古筝演奏", []) == "古风"
    assert classify("一个毫无特征的视频", ["生活", "日常"]) == ""


def test_classify_priority_most_hits():
    # 同时命中多个风格时取命中关键词最多的（民谣命中 2 词 > 摇滚 1 词）
    assert classify("摇滚", ["民谣", "弹唱"]) == "民谣"


def test_is_song_like_bounds():
    assert is_song_like(MIN_DURATION)
    assert is_song_like(MAX_DURATION)
    assert not is_song_like(MIN_DURATION - 1)
    assert not is_song_like(MAX_DURATION + 1)
    assert not is_song_like(0)


def test_daily_pick_deterministic_per_day():
    items = [Item(f"BV{i:012d}") for i in range(50)]
    today = daily_pick(items, n=12, day="20260904")
    again = daily_pick(items, n=12, day="20260904")
    assert [i.bvid for i in today] == [i.bvid for i in again]
    assert len(today) == 12
    tomorrow = daily_pick(items, n=12, day="20260905")
    assert [i.bvid for i in today] != [i.bvid for i in tomorrow]
