"""B 站字幕 JSON → LRC 转换。

B 站字幕文件是 JSON：{"body": [{"from": 1.2, "to": 3.4, "content": "…"}, …]}，
from/to 为秒。这里转成行式 LRC（[mm:ss.xx]内容），与 LRCLIB 的 syncedLyrics
格式一致，前端只需一个解析器。
"""


def format_lrc_time(seconds: float) -> str:
    """秒 → LRC 时间标记 [mm:ss.xx]（百分之一秒精度）。"""
    cs = int(round(max(0.0, seconds) * 100))
    minutes, rem = divmod(cs, 6000)
    sec, centis = divmod(rem, 100)
    return f"{minutes:02d}:{sec:02d}.{centis:02d}"


def subtitle_body_to_lrc(body: list[dict]) -> str:
    """字幕行列表（按 from 升序）→ LRC 文本；空行与缺时间戳的行丢弃。"""
    lines: list[tuple[float, str]] = []
    for item in body:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        try:
            start = float(item.get("from") or 0.0)
        except (TypeError, ValueError):
            continue
        lines.append((start, content))
    lines.sort(key=lambda pair: pair[0])
    return "\n".join(f"[{format_lrc_time(start)}]{content}" for start, content in lines)
