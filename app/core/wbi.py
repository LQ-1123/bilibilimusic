"""B 站 WBI 签名。

算法与测试向量来自 bilibili-API-collect（docs/misc/sign/wbi.md）：
1. img_key + sub_key 按混淆表重排，取前 32 位得 mixin_key；
2. 参数追加 wts → 按 key 升序排序 → 过滤值中 "!'()*" → urlencode；
3. w_rid = md5(query + mixin_key)。

黄金测试向量：img_key=7cd084941338484aae1ad9425b84077c、
sub_key=4932caff0ff746eab6f01bf08b70ac45 时 mixin_key
应为 ea1db124af3c7062474693fa704f4ff8（tests/test_wbi.py 校验）。
"""

import hashlib
import time
from urllib.parse import urlencode

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]

# 需要从参数值中过滤的字符
_FILTER_CHARS = "!'()*"


def get_mixin_key(raw_wbi_key: str) -> str:
    return "".join(raw_wbi_key[i] for i in MIXIN_KEY_ENC_TAB)[:32]


def sign_params(
    params: dict,
    img_key: str,
    sub_key: str,
    *,
    now: int | None = None,
) -> dict:
    """返回追加了 wts 与 w_rid 的参数副本。"""
    mixin_key = get_mixin_key(img_key + sub_key)
    signed = dict(params)
    signed["wts"] = now if now is not None else int(time.time())
    signed = dict(sorted(signed.items()))
    signed = {
        k: "".join(ch for ch in str(v) if ch not in _FILTER_CHARS)
        for k, v in signed.items()
    }
    query = urlencode(signed)
    signed["w_rid"] = hashlib.md5((query + mixin_key).encode()).hexdigest()
    return signed


def extract_wbi_keys(nav_data: dict) -> tuple[str, str]:
    """从 nav 接口 data 中提取 img_key / sub_key（取 URL 文件名去掉扩展名）。"""
    wbi_img = nav_data["wbi_img"]

    def key_of(url: str) -> str:
        return url.rsplit("/", 1)[1].split(".")[0]

    return key_of(wbi_img["img_url"]), key_of(wbi_img["sub_url"])
