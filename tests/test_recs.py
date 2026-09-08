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
    assert classify("新专辑《摇滚之心》", []) == "摇滚金属"
    assert classify("cover", ["ROCK", "band"]) == "摇滚金属"


def test_classify_rnb_gospel():
    # 实测种子场景：黑人福音翻唱
    assert classify("", ["孙燕姿", "SUNO", "黑人福音"]) == "R&B"


def test_classify_pop_rap():
    assert classify("年度流行金曲合集", []) == "华语流行"
    assert classify("地下说唱现场", []) == "hiphop"


def test_classify_guzheng_and_unknown():
    assert classify("古筝演奏", []) == "古风"
    assert classify("一个毫无特征的视频", ["生活", "日常"]) == ""


def test_classify_priority_most_hits():
    # 后出现的风格命中更多关键词时，应覆盖先出现的风格。
    assert classify("摇滚", ["蓝调", "爵士"]) == "蓝调"
    assert classify("蓝调", ["摇滚", "金属"]) == "摇滚金属"


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
