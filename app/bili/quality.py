"""音质档位定义与选择。

fnval=16（DASH）下只会拿到 AAC 档位：30216(64K) / 30232(132K) / 30280(192K，需登录)；
杜比(30250) 与 Hi-Res(30251) 需要额外 fnval 位与大会员，本服务暂不启用（v2.1 放开）。
注意 B 站音质 id 的数字大小 ≠ 音质高低：30280(192K) 在数值上大于 30251(Hi-Res)、
30250(杜比)，选档不能 max(id)，否则放开高音质后恰好选错（BUG-006）。
"""

AUDIO_QUALITY_LABELS = {
    30216: "64K",
    30232: "132K",
    30280: "192K",
    30250: "杜比",
    30251: "Hi-Res",
}

# 感知音质优先级（高 → 低）。id 不在此表时视为最低，仅靠带宽决胜。
_QUALITY_ORDER = {30251: 4, 30250: 3, 30280: 2, 30232: 1, 30216: 0}

DEFAULT_LABEL = "未知"


def quality_label(quality_id: int) -> str:
    return AUDIO_QUALITY_LABELS.get(quality_id, DEFAULT_LABEL)


def pick_best_audio(streams):
    """带宽最高者胜出；同带宽再用感知优先级决胜（BUG-006：id 数字大小 ≠ 音质高低）。"""
    if not streams:
        raise ValueError("没有可选音频流")
    return max(streams, key=lambda s: (s.bandwidth, _QUALITY_ORDER.get(s.quality_id, -1)))
