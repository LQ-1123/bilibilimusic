"""B 站搜索结果解析：标题高亮标签清理 + 时长文本转秒。"""

from app.bili.client import parse_duration_text, strip_highlight


def test_strip_highlight_removes_em_tags():
    raw = '<em class="keyword">寄明月</em>官方MV'
    assert strip_highlight(raw) == "寄明月官方MV"


def test_strip_highlight_multiple_and_attrs():
    raw = '<em class="keyword">洛</em>天依<em class="keyword">新歌</em>'
    assert strip_highlight(raw) == "洛天依新歌"


def test_strip_highlight_plain_title_untouched():
    assert strip_highlight("普通标题") == "普通标题"


def test_duration_minutes_seconds():
    assert parse_duration_text("4:12") == 252


def test_duration_hours():
    assert parse_duration_text("1:02:33") == 3753


def test_duration_invalid_returns_zero():
    assert parse_duration_text("") == 0
    assert parse_duration_text(None) == 0
    assert parse_duration_text("--:--") == 0
    assert parse_duration_text("4:1a") == 0
