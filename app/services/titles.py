"""曲目标题清洗：多P/合集子曲目只保留分P名（歌名），不再拼接主标题。

历史行为是把子曲目标题存成「主标题 · 分P标题」，结果专辑页每一行都重复一长串
合集名（例：`【周杰伦】50首精选合集/后台播放/无损音质/HIFI音质/… · 001.周杰伦-晴天`），
既占宽度又难读。现在：
- 新导入：子曲目标题 = 分P名（去掉「01.」「第3集」等序号噪声）；
- 存量数据：`app/db/session.py` 的一次性迁移按同样的规则收敛。
合集名仍然在专辑页标题、专辑卡和面包屑里，没有丢。
"""

import re

# 分P名里的序号噪声：「01.」「第3集」「12、」…
_PART_NOISE_RE = re.compile(
    r"^\s*(?:第?\s*\d{1,4}\s*[集话回期部]\s*[·.:：、_-]*\s*|\d{1,3}\s*[.·、_-]\s*)"
)
# 没有信息量的分P占位名（这类才回退到主标题）
_PART_PLACEHOLDER_RE = re.compile(r"^(?:[Pp]?\d{1,3}|正片|片段|完整版|其他|无)$")

PART_SEP = " · "


def clean_part_title(part: str) -> str:
    """去掉分P名里的序号噪声；清空后回退原始值。"""
    part = (part or "").strip()
    return _PART_NOISE_RE.sub("", part).strip() or part


def is_meaningful_part(part: str) -> bool:
    """分P名是否含有效信息（P1 / 正片 / 空 这类占位名不算）。

    注意单字中文歌名（枫、稻、月…）是有效歌名，不能按长度一刀切。
    """
    part = (part or "").strip()
    return bool(part) and not _PART_PLACEHOLDER_RE.match(part)


def part_display_title(main: str, part: str) -> str:
    """分P曲目的展示标题：优先分P名（即歌名），占位名才回退主标题。"""
    cleaned = clean_part_title(part)
    return cleaned if is_meaningful_part(cleaned) else (main or cleaned)


def short_title(title: str, main: str) -> str:
    """把「主标题 · 分P标题」收敛为分P标题；不是该结构则原样返回。

    仅用于确实知道主标题（album.title）的场合，避免误伤标题里本来就有 ` · ` 的曲目。
    """
    if main and title.startswith(main + PART_SEP):
        rest = clean_part_title(title[len(main) + len(PART_SEP):])
        if is_meaningful_part(rest):
            return rest
    return title
