"""音质档位定义与选择。

fnval=16|1024|256（DASH + Hi-Res + 杜比位，v2.1 起启用）：登录大会员可拿到
30251(Hi-Res/FLAC) 与 30250(杜比)；普通账号/无权益时 B 站只是不下发这些字段。
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

# 档位帽（v2.1 弱网降档/流量策略）：tier → 允许的 id 集合；best = 不限。
# 集合为空命中时回退全量（帽只限流，不拦播放）。
TIER_ALLOWED = {
    "best": None,
    "192": {30280, 30232, 30216},
    "132": {30232, 30216},
    "64": {30216},
}

DEFAULT_LABEL = "未知"


def quality_label(quality_id: int) -> str:
    return AUDIO_QUALITY_LABELS.get(quality_id, DEFAULT_LABEL)


def pick_best_audio(streams, tier: str = "best"):
    """带宽最高者胜出；同带宽再用感知优先级决胜（BUG-006：id 数字大小 ≠ 音质高低）。

    tier 是档位帽（TIER_ALLOWED）：弱网降档/流量场景由前端请求 64/132/192，
    后端只在帽内选最高；帽内为空时回退全量，保证有声音。
    """
    if not streams:
        raise ValueError("没有可选音频流")
    allowed = TIER_ALLOWED.get(tier)
    pool = [s for s in streams if allowed is None or s.quality_id in allowed] or list(streams)
    return max(pool, key=lambda s: (s.bandwidth, _QUALITY_ORDER.get(s.quality_id, -1)))
