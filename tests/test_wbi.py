"""WBI 签名单测：测试向量来自 bilibili-API-collect docs/misc/sign/wbi.md。"""

from app.core.wbi import extract_wbi_keys, get_mixin_key, sign_params

IMG_KEY = "7cd084941338484aae1ad9425b84077c"
SUB_KEY = "4932caff0ff746eab6f01bf08b70ac45"


def test_mixin_key_golden_vector():
    # 文档示例：两把 key 混淆后得到固定 mixin_key
    assert get_mixin_key(IMG_KEY + SUB_KEY) == "ea1db124af3c7062474693fa704f4ff8"


def test_sign_params_golden_vector():
    # 文档示例：固定 wts 下 w_rid 可复现
    signed = sign_params(
        {"foo": "114", "bar": "514", "zab": 1919810},
        IMG_KEY,
        SUB_KEY,
        now=1702204169,
    )
    # 文档行为：签名后所有参数值统一转字符串（文档示例输出亦如此）
    assert signed["wts"] == "1702204169"
    assert signed["w_rid"] == "8f6f2b5b3d485fe1886cec6a0be8c5d4"


def test_sign_filters_special_chars():
    signed = sign_params({"foo": "a!'()*b"}, IMG_KEY, SUB_KEY, now=1702204169)
    assert signed["foo"] == "ab"


def test_extract_keys_from_nav():
    nav_data = {
        "wbi_img": {
            "img_url": f"https://i0.hdslb.com/bfs/wbi/{IMG_KEY}.png",
            "sub_url": f"https://i0.hdslb.com/bfs/wbi/{SUB_KEY}.png",
        }
    }
    assert extract_wbi_keys(nav_data) == (IMG_KEY, SUB_KEY)
