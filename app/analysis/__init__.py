"""Smart Transition Engine 的音频分析（服务端）。

规范要点：传统 DSP、无 AI、无联网；低采样率 mono 分析（原始 AAC 原质量播放）；
结果缓存于 SQLite（version + duration 失效）；分析全程后台线程，绝不阻塞播放。
"""
