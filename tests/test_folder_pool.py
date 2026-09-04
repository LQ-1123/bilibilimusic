"""收藏夹命名：歌单夹名生成/解析、默认池排序与溢出建夹编号。"""

from app.bili.client import (
    folder_sort_key,
    next_folder_title,
    playlist_folder_title,
    playlist_name_from_title,
)
from app.services.playlists import playlist_folder_titles, next_title_maker, DEFAULT_NAME


def test_playlist_folder_title_format():
    # 用户约定的命名：bilimusic- <歌单名>
    assert playlist_folder_title("Rock&roll") == "bilimusic- Rock&roll"
    assert playlist_folder_title(" 轻音乐 ") == "bilimusic- 轻音乐"


def test_playlist_name_roundtrip():
    assert playlist_name_from_title("bilimusic- Rock&roll") == "Rock&roll"
    assert playlist_name_from_title("bilimusic- 轻音乐") == "轻音乐"
    # 主夹与编号溢出夹不属于任何命名歌单
    assert playlist_name_from_title("bilimusic") is None
    assert playlist_name_from_title("bilimusic2") is None
    assert playlist_name_from_title("我的收藏") is None


def test_playlist_folder_titles_overflow_numbering():
    # 首夹用歌单名，溢出夹追加编号（2 起）
    assert playlist_folder_titles("Rock", 1) == ["bilimusic- Rock"]
    assert playlist_folder_titles("Rock", 3) == [
        "bilimusic- Rock",
        "bilimusic- Rock2",
        "bilimusic- Rock3",
    ]


def test_next_title_maker_default_uses_numbered_pool():
    # 默认歌单走主夹 + 纯编号溢出（bilimusic2/bilimusic3…）
    make = next_title_maker(DEFAULT_NAME)
    assert make(["bilimusic"]) == "bilimusic2"
    assert make(["bilimusic", "bilimusic2"]) == "bilimusic3"


def test_next_title_maker_named_avoids_taken():
    make = next_title_maker("Rock")
    assert make(["bilimusic- Rock"]) == "bilimusic- Rock2"
    assert make(["bilimusic- Rock", "bilimusic- Rock2"]) == "bilimusic- Rock3"


def test_folder_sort_key_named_and_numbered():
    # 主夹最前、编号夹次之（升序）、歌单命名夹再次、非夹池最后
    titles = ["bilimusic- Rock", "bilimusic10", "bilimusic", "bilimusic2", "我的收藏"]
    ordered = sorted(titles, key=folder_sort_key)
    assert ordered == ["bilimusic", "bilimusic2", "bilimusic10", "bilimusic- Rock", "我的收藏"]


def test_next_folder_title_default_pool():
    assert next_folder_title(["bilimusic"]) == "bilimusic2"
    assert next_folder_title(["bilimusic", "bilimusic2"]) == "bilimusic3"
    assert next_folder_title(["bilimusic5"]) == "bilimusic6"
