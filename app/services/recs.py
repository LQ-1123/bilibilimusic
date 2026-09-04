"""推荐池：滚动的链接组（只存元数据，不下载音频，过期即删）。

设计约束（用户定）：
- 采集搭车在听歌上：播放器起播 → 以当前歌为种子拉一次 B 站相关视频；
  频控三重闸（同种子未过期不重复、全局最小间隔 10 分钟、每日上限 20 次），
  没有任何定时任务或后台爬取
- 池子只是链接组：bvid + 元数据，播放走 /api/stream/{bvid} 实时流代理
- 过期即删：每条默认 7 天，读取时懒清理，无清理任务
- 风格分类：种子视频标签 + 候选标题关键词 → 摇滚/R&B/流行/民谣/说唱/电子/古风/爵士
- 今日推荐：按「日期 + bvid」确定性挑选，同一天刷新不变，隔天自动换
"""

import hashlib
import time
from datetime import datetime, timedelta

from sqlmodel import select

from app.bili.client import BiliClient
from app.db.models import RecPool, Song
from app.db.session import new_session

RECORD_TTL_DAYS = 7
MIN_COLLECT_INTERVAL = 600  # 两次采集最小间隔（秒）
DAILY_CAP = 20  # 每日采集次数上限
MIN_DURATION = 90  # “像一首歌”的时长过滤（秒）
MAX_DURATION = 480

GENRE_KEYWORDS = {
    "摇滚": ("摇滚", "rock", "metal", "金属", "朋克", "punk"),
    "R&B": ("r&b", "rnb", "节奏布鲁斯", "soul", "灵魂", "福音", "gospel", "blues", "布鲁斯"),
    "流行": ("流行", "pop", "金曲", "华语流行", "hot"),
    "民谣": ("民谣", "folk", "乡村", "弹唱"),
    "说唱": ("说唱", "rap", "hip hop", "hip-hop", "嘻哈", "freestyle"),
    "电子": ("电子", "edm", "house", "techno", "电音", "remix"),
    "古风": ("古风", "国风", "民乐", "戏腔", "古筝", "琵琶"),
    "爵士": ("爵士", "jazz", "bossa", "蓝调"),
}

# 进程内频控状态（重启即重置，无伤大雅）
_state = {"last": 0.0, "day": "", "count": 0}


def classify(title: str, tag_names) -> str:
    """标题 + 标签关键词 → 风格分类；无法归类返回空串。"""
    text = (title + " " + " ".join(tag_names)).lower()
    best, hits = "", 0
    for genre, keywords in GENRE_KEYWORDS.items():
        n = sum(1 for k in keywords if k in text)
        if n > hits:
            best, hits = genre, n
    return best


def is_song_like(duration: int) -> bool:
    return MIN_DURATION <= duration <= MAX_DURATION


def daily_pick(items: list, n: int = 12, day: str | None = None) -> list:
    """今日推荐：同一天确定性一致（sha256(日期:bvid) 排序），隔天自动轮换。"""
    day = day or datetime.utcnow().strftime("%Y%m%d")
    return sorted(items, key=lambda i: hashlib.sha256(f"{day}:{i.bvid}".encode()).hexdigest())[:n]


def _rate_ok() -> tuple[bool, str]:
    today = time.strftime("%Y%m%d")
    if _state["day"] != today:
        _state["day"], _state["count"] = today, 0
    if time.time() - _state["last"] < MIN_COLLECT_INTERVAL:
        return False, "距上次采集间隔不足"
    if _state["count"] >= DAILY_CAP:
        return False, "今日采集已达上限"
    return True, ""


def purge_expired() -> int:
    """懒清理：删除过期推荐，返回删除行数。读取路径上顺手调用。"""
    with new_session() as session:
        rows = session.exec(
            select(RecPool).where(RecPool.expires_at < datetime.utcnow())  # type: ignore[attr-defined]
        ).all()
        for row in rows:
            session.delete(row)
        session.commit()
        return len(rows)


def list_items(genre: str = "", limit: int = 500) -> list[RecPool]:
    purge_expired()
    with new_session() as session:
        stmt = select(RecPool).order_by(RecPool.added_at.desc()).limit(limit)
        if genre:
            stmt = stmt.where(RecPool.genre == genre)  # type: ignore[attr-defined]
        return list(session.exec(stmt).all())


def daily_items(n: int = 12) -> list[RecPool]:
    purge_expired()
    return daily_pick(list_items(), n=n)


def dismiss(bvid: str) -> bool:
    """不感兴趣 / 已转正：立即出池。"""
    with new_session() as session:
        row = session.exec(select(RecPool).where(RecPool.bvid == bvid)).first()  # type: ignore[attr-defined]
        if row is None:
            return False
        session.delete(row)
        session.commit()
        return True


def dismiss_for_text(text: str) -> bool:
    """收藏转正：分享文本/链接里带 BV 号且在池中时出池（收藏后不再受 TTL 管辖）。"""
    from app.core.link_parser import BV_RE

    m = BV_RE.search(text or "")
    if not m:
        return False
    return dismiss(m.group(0))


async def collect_for_song(bili: BiliClient, song: Song) -> dict:
    """以指定歌为种子采集相关推荐入池（供播放起播时搭车调用）。"""
    ok, reason = _rate_ok()
    if not ok:
        return {"collected": 0, "reason": reason}
    seed_bvid = song.bvid
    with new_session() as session:
        dup = session.exec(
            select(RecPool).where(RecPool.seed_bvid == seed_bvid)  # type: ignore[attr-defined]
        ).first()
    if dup:
        return {"collected": 0, "reason": "该种子已采集过"}

    aid = song.aid or (await bili.bvid_to_aid(seed_bvid) or 0)
    if not aid:
        return {"collected": 0, "reason": "缺少 av 号，无法获取相关推荐"}

    # 种子标签既做风格画像，也整批继承给候选（实测 related 结果高度同质，
    # 一次标签请求即可完成整批分类，无需逐条查询）
    tags = await bili.video_tags(seed_bvid)
    seed_genre = classify("", tags)
    related = await bili.related_videos(aid)

    with new_session() as session:
        known = {s.bvid for s in session.exec(select(Song)).all()}
        in_pool = {r.bvid for r in session.exec(select(RecPool)).all()}

    expires = datetime.utcnow() + timedelta(days=RECORD_TTL_DAYS)
    rows: list[RecPool] = []
    for v in related:
        bvid = str(v.get("bvid") or "")
        duration = int(v.get("duration") or 0)
        if not bvid or bvid in known or bvid in in_pool or not is_song_like(duration):
            continue
        title = str(v.get("title") or "").strip()
        rows.append(
            RecPool(
                bvid=bvid,
                title=title,
                artist=str((v.get("owner") or {}).get("name") or "").strip(),
                duration=duration,
                cover_url=str(v.get("pic") or ""),
                seed_bvid=seed_bvid,
                genre=classify(title, tags) or seed_genre,
                expires_at=expires,
            )
        )
        in_pool.add(bvid)

    with new_session() as session:
        for row in rows:
            session.add(row)
        session.commit()

    _state["last"] = time.time()
    _state["count"] += 1
    purge_expired()
    return {"collected": len(rows), "genre": seed_genre}
