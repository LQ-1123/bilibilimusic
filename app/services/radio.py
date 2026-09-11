"""漫游电台（v2.1 A5）：以当前歌/容器为种子，从推荐池自动续队列。

设计约束（沿用推荐池的纪律，用户定）：
- 只消费 recs 池（元数据，不落盘）；补给靠起播搭车采集（collect_for_song 自带
  同种子去重 + 全局 10 分钟间隔 + 每日 20 次频控），电台自己不新增任何后台任务
- 池薄时尽力触发一次种子采集（频控内），仍不够就返回现有量——宁缺勿滥
- 跳过（negative feedback）由前端调既有 DELETE /api/recs/{bvid} 出池
"""

import random

from sqlmodel import select

from app.db.models import Song
from app.db.session import new_session
from app.services import recs


def _seed_genre(seed_bvid: str) -> str:
    """种子的风格标签：种过池就沿用，没种过现场按标题分类（无网络请求）。"""
    with new_session() as session:
        row = session.exec(
            select(recs.RecPool).where(recs.RecPool.bvid == seed_bvid)  # type: ignore[attr-defined]
        ).first()
        if row is not None:
            return row.genre
        song = session.exec(select(Song).where(Song.bvid == seed_bvid)).first()  # type: ignore[attr-defined]
    if song is not None:
        return recs.classify(song.title, [])
    return ""


def next_batch(seed_bvid: str, exclude: list[str] | None = None, n: int = 3) -> list:
    """取下一批电台歌：优先同风格 → 池内随机；排除当前歌/已放过的。"""
    recs.purge_expired()
    exclude = {b for b in (exclude or []) if b} | {seed_bvid}
    with new_session() as session:
        known = {s.bvid for s in session.exec(select(Song)).all()}

    def _eligible(items):
        return [
            i for i in items
            if i.bvid not in exclude and i.bvid not in known and recs.is_song_like(i.duration)
        ]

    genre = _seed_genre(seed_bvid)
    pool = _eligible(recs.list_items())
    same = [i for i in pool if genre and i.genre == genre]
    picked = random.sample(same, min(n, len(same))) if same else []
    if len(picked) < n:
        rest = [i for i in pool if i not in picked]
        random.shuffle(rest)
        picked += rest[: n - len(picked)]
    return picked
