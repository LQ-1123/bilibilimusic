"""音质档位探测：用项目自身的 BiliClient + 已登录账号 cookie，
对候选 BV 号调用 playurl（fnval 含 Hi-Res/杜比位），报告实际下发的音频档位。

用法：.venv/Scripts/python.exe scripts/probe_quality.py BV1xxx BV1yyy ...
不传参数时使用内置候选列表。
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.bili.client import BiliClient
from app.bili.quality import pick_best_audio, quality_label
from app.core.cookies import CookieStore
from app.db import session as dbs

CANDIDATES = [
    "BV1dBpRzsEis",  # 【Hi-Res】HiFi高品质无损音乐欣赏 金曲精选八首
    "BV1AG4y1b7YG",  # Hi-Res无损音质视频指南
    "BV1dJ411A75P",  # 耳机、音响测试音乐 - 黄金六角
]


async def probe(bili: BiliClient, bvid: str) -> None:
    try:
        cids = await bili.video_page_cids(bvid)
    except Exception as exc:  # noqa: BLE001
        print(f"{bvid}: 拿 cid 失败 → {exc}")
        return
    if not cids:
        print(f"{bvid}: 无分 P（视频可能失效）")
        return
    try:
        streams = await bili.get_audio_streams(bvid, cids[0])
    except Exception as exc:  # noqa: BLE001
        print(f"{bvid}: playurl 失败 → {exc}")
        return
    ids = sorted({s.quality_id for s in streams}, reverse=True)
    labels = " / ".join(f"{quality_label(i)}({i})" for i in ids)
    best = pick_best_audio(streams, "best")
    print(f"{bvid}  分P数={len(cids)}")
    print(f"  可选档位: {labels}")
    print(f"  best 实选: {quality_label(best.quality_id)}  带宽={best.bandwidth // 8}KB/s")


async def main() -> None:
    bvids = sys.argv[1:] or CANDIDATES
    dbs.init_db()
    mid = dbs.load_active_account()
    cookie_path = dbs.account_cookie_path(mid) if mid else dbs.settings.cookie_path
    store = CookieStore(cookie_path)
    vip = "是" if (store.get("vipStatus") or store.get("vipType")) else "未知（按 cookie 缺失标记判断）"
    print(f"账号 cookie: {cookie_path}  大会员标记: {vip}")
    bili = BiliClient(store)
    await bili.ensure_fingerprint()
    for bvid in bvids:
        await probe(bili, bvid)
    await bili.aclose()


if __name__ == "__main__":
    asyncio.run(main())
