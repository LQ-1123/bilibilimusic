"""音质档位定义与选择。

fnval=16（DASH）下只会拿到 AAC 档位：30216(64K) / 30232(132K) / 30280(192K，需登录)；
杜比(30250) 与 Hi-Res(30251) 需要额外 fnval 位与大会员，本服务不启用。
"""

AUDIO_QUALITY_LABELS = {
    30216: "64K",
    30232: "132K",
    30280: "192K",
    30250: "杜比",
    30251: "Hi-Res",
}

DEFAULT_LABEL = "未知"


def quality_label(quality_id: int) -> str:
    return AUDIO_QUALITY_LABELS.get(quality_id, DEFAULT_LABEL)


def pick_best_audio(streams):
    """取 id 最大的流（id 越大音质越高）。"""
    if not streams:
        raise ValueError("没有可选音频流")
    return max(streams, key=lambda s: s.quality_id)
