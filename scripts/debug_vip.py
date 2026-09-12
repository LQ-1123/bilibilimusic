"""诊断：1) nav 接口看账号 VIP 状态；2) 原始 playurl 响应里 dash 有没有 flac/dolby 字段。"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.bili.client import BiliClient
from app.core.cookies import CookieStore
from app.db import session as dbs


async def main() -> None:
    bvid = sys.argv[1] if len(sys.argv) > 1 else "BV1dZ4y1Y7bt"
    dbs.init_db()
    mid = dbs.load_active_account()
    cookie_path = dbs.account_cookie_path(mid) if mid else dbs.settings.cookie_path
    print(f"mid={mid}  cookie 文件={cookie_path}")
    store = CookieStore(cookie_path)
    bili = BiliClient(store)

    # 1) 账号与会员状态
    nav = await bili._get_json("/x/web-interface/nav", {})
    print(f"nav 原始 code={nav.get('code')} message={nav.get('message')}")
    wbi = nav.get("data") or {}
    print(f"登录: {wbi.get('isLogin')}  用户: {wbi.get('uname')}")
    vip = wbi.get("vipStatus"), wbi.get("vipType"), wbi.get("vip_due_date")
    print(f"vipStatus={vip[0]} (1=有效)  vipType={vip[1]} (2=年度大会员)  到期时间戳={vip[2]}")

    # 2) 原始 playurl
    cid = (await bili.video_page_cids(bvid) or [0])[0]
    params = {"bvid": bvid, "cid": cid, "qn": 64, "fnval": 16 | 1024 | 256, "fourk": 1}
    data = await bili._get_json_signed("/x/player/wbi/playurl", params)
    dash = data.get("dash") or {}
    print(f"\n{bvid}  accept_quality={data.get('accept_quality')}")
    print(f"  accept_description={data.get('accept_description')}")
    print(f"  dash 顶层字段: {sorted(dash.keys())}")
    print(f"  dash.audio id 列表: {[a.get('id') for a in dash.get('audio') or []]}")
    flac = dash.get("flac")
    dolby = dash.get("dolby")
    print(f"  dash.flac: {json.dumps(flac, ensure_ascii=False)[:200] if flac else '无（未下发）'}")
    print(f"  dash.dolby: {json.dumps(dolby, ensure_ascii=False)[:200] if dolby else '无（未下发）'}")
    await bili.aclose()


if __name__ == "__main__":
    asyncio.run(main())
