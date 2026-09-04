# Smart Transition Engine 实现任务

你现在需要为我的音乐播放器实现一个「Smart Transition Engine（智能切歌过渡引擎）」。

## 一、项目背景

我的音乐文件格式主要是：

- `.m4a`
- AAC 音轨封装
- 本地音乐文件
- 不使用 AI 模型
- 不调用云端 API
- 不依赖 LLM
- 不进行耗时的机器学习推理

目标是：

> 当用户点击“下一首”时，不是简单地停止当前歌曲然后播放下一首，而是通过传统音频信号处理算法，在当前歌曲和下一首歌曲之间寻找一个听感自然的衔接点。

同时，如果用户没有主动点击切歌，那么在当前歌曲自然播放到末尾时，也自动寻找最佳过渡点。

---

# 二、核心设计思想

不要把这个功能简单实现成：

```text
crossfade(3 seconds)
```

而应该实现：

```text
当前歌曲
    ↓
分析当前歌曲的可切出位置
    ↓
分析下一首歌曲的可切入位置
    ↓
候选点匹配
    ↓
计算 Transition Score
    ↓
选择最佳切点
    ↓
执行 Transition
```

核心目标：

> 找到“当前歌曲的结束片段”和“下一首歌曲的开始片段”之间最自然的衔接方式。

---

# 三、必须区分两种情况

## 情况 A：用户主动点击切歌

例如：

```text
Song A 正在播放

用户点击：
Next
```

此时不要等待 Song A 播放结束。

立即进入：

```text
Transition Planner
```

在当前播放位置之后寻找适合的切出点。

例如：

```text
当前播放位置
       ↓
───────●────────────────────────
       │
       │ 搜索未来 m 秒
       ↓

candidate exit points:
E1
E2
E3
E4
```

同时分析下一首歌：

```text
Song B

前 n 秒
│
├── B1
├── B2
├── B3
├── B4
└── B5
```

然后进行：

```text
E1 × B1
E1 × B2
E1 × B3
...

E2 × B1
E2 × B2
...

E4 × B5
```

计算每一组组合的 Transition Score。

选择：

```text
argmax(score)
```

然后执行过渡。

---

# 四、情况 B：用户没有主动切歌

如果用户一直听当前歌曲，那么不要等到歌曲完全结束之后才开始计算。

例如：

```text
Song A

───────────────────────────────┐
                               │
                               │
                         当前播放位置
                               ↓
───────────────────────────────●───────
                                      │
                                      │
                                  剩余 m 秒
                                      │
                                      ↓
                                   Song End
```

在歌曲剩余 `m` 秒的时候：

```text
分析：

Song A:
最后 m 秒

Song B:
前 n 秒
```

寻找最佳匹配。

如果找到：

```text
A exit point
+
B entry point
```

那么在 A 结束之前自动开始 Transition。

如果没有找到足够好的匹配：

```text
fallback → normal crossfade
```

绝对不能因为算法失败导致播放中断。

---

# 五、不要在播放过程中进行重型分析

这是非常重要的性能要求。

不要在：

```text
用户点击 Next
```

之后才开始完整分析歌曲。

应该采用：

```text
歌曲加载
   ↓
后台轻量分析
   ↓
缓存 TrackAnalysis
   ↓
播放
```

例如：

```text
Song A
TrackAnalysis A

Song B
TrackAnalysis B
```

缓存到内存或者本地数据库。

因此用户点击 Next 时只需要：

```text
读取 Analysis
+
寻找候选点
+
计算 Score
+
开始 Transition
```

整个过程应该尽可能控制在：

```text
< 50 ms
```

理想情况下：

```text
< 10 ms
```

---

# 六、不要使用 AI

明确禁止：

- LLM
- GPT
- DeepSeek
- Gemini
- Claude
- Whisper
- 音乐大模型
- 云端音乐分析 API
- 在线 Genre API
- 深度学习推理

必须使用传统算法完成。

允许使用成熟的 DSP / 音频分析库。

例如根据项目语言选择：

```text
FFmpeg
FFTW
KissFFT
aubio
Essentia
librosa
libebur128
Web Audio API
```

但优先选择：

> 轻量、CPU 开销低、可以离线预分析的方案。

不要为了实现一个简单的切歌功能引入大型机器学习模型。

---

# 七、TrackAnalysis 数据结构

请设计一个合理的数据结构，例如：

```ts
interface TrackAnalysis {
    duration: number;

    bpm?: number;
    bpmConfidence?: number;

    beats: number[];
    downbeats: number[];

    energyCurve: EnergyPoint[];

    rmsCurve: EnergyPoint[];

    spectralFlux?: number[];

    spectralCentroid?: number[];

    lowFrequencyEnergy?: number[];

    vocalProbability?: number[];

    sections?: Section[];

    intro?: TimeRange;
    outro?: TimeRange;

    transitionInPoints: TransitionPoint[];
    transitionOutPoints: TransitionPoint[];
}
```

如果项目不是 TypeScript，请根据项目语言转换。

不要机械照搬上述结构。

根据现有项目架构设计。

---

# 八、核心音频分析

只实现真正有价值的分析。

## 1. BPM

使用传统 beat tracking：

```text
PCM
 ↓
Onset Detection
 ↓
Tempo Estimation
 ↓
BPM
```

要求：

```text
BPM
BPM confidence
beat timestamps
```

不要追求音乐识别领域级别的完美准确率。

播放器场景中：

```text
±1~2 BPM
```

通常已经可以工作。

---

# 九、Beat Detection

检测：

```text
beat
```

以及：

```text
downbeat / bar start
```

如果无法可靠检测 downbeat，则使用 beat sequence 推测 4/4 phrase。

例如：

```text
beat:
● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ●

bar:
|-------|-------|-------|-------|
```

生成：

```text
phrase boundaries
```

优先使用：

```text
4 bar
8 bar
16 bar
```

作为候选切点。

---

# 十、Energy Analysis

使用传统 RMS / Short-Time Energy。

例如：

```text
PCM
 ↓
Frame
 ↓
RMS
 ↓
Energy Curve
```

得到：

```text
time → energy
```

例如：

```text
0s      30s      60s      90s

▂▃▄▅▆▇██████▇▆▄▃▂
```

利用它判断：

- 高潮
- 平静段
- break
- outro
- intro

不要要求做到音乐学意义上的完美分类。

只需要为 transition 提供依据。

---

# 十一、Spectral Analysis

使用 FFT。

计算：

```text
Spectral Centroid
Spectral Flux
Low Frequency Energy
Mid Frequency Energy
High Frequency Energy
```

特别关注：

```text
20 ~ 150 Hz
```

作为低频能量。

原因：

> 两首歌曲混合时，低频冲突比高频冲突更容易导致听感浑浊。

---

# 十二、Vocal Detection

不要使用 AI。

实现一个轻量级的：

```text
Vocal Activity Estimator
```

可以使用：

- spectral features
- mid-frequency energy
- spectral flux
- harmonic characteristics
- center-channel energy（如果音频允许）

输出：

```text
vocalProbability
```

例如：

```text
0.0 = 大概率纯音乐
1.0 = 大概率存在人声
```

这不是为了识别歌词。

只是为了判断：

> 这一段是否适合与另一首歌重叠。

---

# 十三、Transition Point

为歌曲提前计算：

```text
TransitionInPoint
TransitionOutPoint
```

例如：

```ts
interface TransitionPoint {
    time: number;

    score: number;

    energy: number;

    vocalProbability: number;

    beatAligned: boolean;

    phraseAligned: boolean;

    type:
        | "intro"
        | "outro"
        | "phrase"
        | "break"
        | "instrumental"
        | "energy_drop";
}
```

---

# 十四、切出点寻找

当前歌曲寻找：

```text
ExitPoint
```

优先级：

```text
1. phrase boundary
2. bar boundary
3. beat boundary
4. energy drop
5. instrumental section
6. outro
```

例如：

```text
Song A

Verse
██████████

Chorus
████████████████

Outro
████████

              ↑
          最佳 Exit
```

不要在：

```text
歌词中间
鼓点中间
明显音符中间
```

进行切换。

---

# 十五、切入点寻找

下一首歌寻找：

```text
EntryPoint
```

优先考虑：

```text
Intro
Instrumental
Downbeat
Phrase Start
低能量开始
```

例如：

```text
Song B

Intro
░░░░░░░░░░

Verse
██████████

Chorus
████████████

      ↑
    Entry
```

---

# 十六、候选点匹配

这是整个系统的核心。

假设：

```text
A Exit Candidates:

E1 = 80.0s
E2 = 84.0s
E3 = 88.0s
E4 = 92.0s
```

下一首：

```text
B Entry Candidates:

I1 = 0.0s
I2 = 4.0s
I3 = 8.0s
I4 = 12.0s
```

计算：

```text
E1-I1
E1-I2
...

E4-I4
```

每一对计算：

```text
TransitionScore
```

---

# 十七、Transition Score

设计一个可调参数的评分模型。

建议初始：

```text
Score =
    0.25 * PhraseScore
  + 0.20 * BeatScore
  + 0.15 * BPMScore
  + 0.15 * VocalScore
  + 0.10 * EnergyScore
  + 0.10 * SpectralScore
  + 0.05 * BoundaryScore
```

所有 Score：

```text
0 ~ 1
```

最终：

```text
0 ~ 1
```

---

# 十八、PhraseScore

如果：

```text
A Exit
```

和：

```text
B Entry
```

都位于 phrase boundary：

```text
Score = 1
```

bar boundary：

```text
Score = 0.8
```

beat：

```text
Score = 0.5
```

非 beat：

```text
Score = 0.1
```

---

# 十九、BeatScore

如果两个歌曲 BPM 接近：

```text
abs(A.BPM - B.BPM)
```

越小分数越高。

可以使用：

```text
BPMScore =
max(0, 1 - abs(A.BPM - B.BPM) / threshold)
```

其中 threshold 可以设置为：

```text
10 BPM
```

---

# 二十、VocalScore

如果：

```text
A exit vocalProbability = 0.2
B entry vocalProbability = 0.1
```

非常好。

如果：

```text
A = 0.9
B = 0.9
```

严重惩罚。

例如：

```text
VocalScore =
1 - (A_vocal * B_vocal)
```

可以从这个简单版本开始。

---

# 二十一、EnergyScore

不要让：

```text
A = 极高能量
B = 极低能量
```

直接长时间叠加。

计算：

```text
energyDifference =
abs(A_energy - B_energy)
```

差距越小：

```text
Score 越高
```

但是允许一定程度的：

```text
High → Low
Low → High
```

不要把 EnergyScore 设计得过于绝对。

---

# 二十二、Transition Duration

不要固定：

```text
3 seconds
```

根据情况动态决定。

建议：

```text
Excellent match:
8 ~ 16 seconds

Good match:
4 ~ 8 seconds

Normal:
2 ~ 4 seconds

Poor:
0.5 ~ 2 seconds
```

如果完全不适合：

```text
Hard Cut
```

或者：

```text
Very Short Crossfade
```

---

# 二十三、Transition Type 自动选择

根据歌曲特征自动选择策略。

实现：

```text
TransitionStrategy
```

至少包括：

```text
BEAT_MATCH
PHRASE_CROSSFADE
VOCAL_SAFE
ENERGY_FADE
SHORT_CROSSFADE
HARD_CUT
LONG_CROSSFADE
```

例如：

### BPM 接近 + Beat confidence 高

使用：

```text
BEAT_MATCH
```

### 人声密集

使用：

```text
VOCAL_SAFE
```

### BPM 差异很大

不要强行 Beat Match。

使用：

```text
PHRASE_CROSSFADE
```

### Rock / 音乐非常密集

优先：

```text
SHORT_CROSSFADE
```

### Ambient / Lo-fi

可以：

```text
LONG_CROSSFADE
```

---

# 二十四、EQ Transition

不要简单把两首歌音量同时提高。

Transition 时对低频进行处理。

例如：

```text
Song A Low Frequency
100% → 0%

Song B Low Frequency
0% → 100%
```

可以实现一个简单的 Low Shelf / Low Pass 过渡。

核心目标：

> 防止两首歌的 Kick + Bass 同时叠加导致低频浑浊。

如果 EQ 实现复杂，可以第一版只做：

```text
gain crossfade
```

但架构必须允许未来加入 EQ transition。

---

# 二十五、Crossfade 曲线

不要使用：

```text
linear fade
```

使用 Equal Power：

```text
A_gain = cos(π * x / 2)

B_gain = sin(π * x / 2)
```

其中：

```text
x = elapsed / duration
```

范围：

```text
0 ~ 1
```

这样两首歌重叠时整体响度更加稳定。

---

# 二十六、主动切歌时的特殊处理

这是非常重要的 UX。

如果用户在：

```text
歌曲 A 进行到 20%
```

点击下一首。

不要突然：

```text
跳到 A 的最后 10 秒
```

这会非常奇怪。

应该：

```text
当前播放位置
       ↓
─────────────────────●──────────────
                     ↓
             寻找最近的合理 Exit
                     ↓
              2~8 秒以内优先
```

如果最近的 phrase boundary 太远：

```text
不要等待太久
```

应该使用：

```text
short transition
```

原则：

> 用户主动切歌时，响应速度优先于完美音乐匹配。

---

# 二十七、自然播放结束时

如果用户没有点击 Next：

优先追求：

> 音乐连续性。

所以可以提前：

```text
20~30 秒
```

寻找最佳 transition。

如果找到：

```text
A → B
```

就自动执行。

如果找不到：

```text
普通 crossfade
```

绝不能出现：

```text
歌曲结束
↓
等待算法
↓
播放器卡住
```

---

# 二十八、后台分析策略

为了不影响用户体验：

当播放：

```text
Song A
```

后台立即分析：

```text
Song B
Song C
```

但不要分析整个歌曲的高分辨率 PCM。

采用：

```text
低采样率
mono
低分辨率
```

进行特征分析。

例如可以：

```text
44.1kHz
↓
8kHz / 11.025kHz
↓
mono
↓
analysis
```

对于 BPM / energy / spectral features 通常已经足够。

原始 AAC 音频仍然保持原质量播放。

---

# 二十九、缓存

Analysis 必须缓存。

例如：

```text
~/.musicapp/analysis/
```

或者：

```text
SQLite
```

结构：

```text
track_id
file_hash
duration
bpm
beats
energy
spectral_features
transition_points
analysis_version
```

通过：

```text
file hash
+
analysis_version
```

判断是否需要重新分析。

歌曲没有变化：

```text
不重新分析
```

---

# 三十、性能要求

这是硬性要求。

Smart Transition 不得：

- 阻塞 UI
- 阻塞音频线程
- 导致播放卡顿
- 等待完整音频分析
- 下载网络资源
- 调用 AI
- 调用外部 API

架构必须：

```text
Audio Thread
    │
    ├── Playback
    └── Transition DSP

Background Worker
    │
    └── Track Analysis

UI Thread
    │
    └── Controls
```

音频线程绝对不要执行：

```text
FFT entire song
BPM analysis
file IO
database query
```

所有这些应该提前完成。

---

# 三十一、Fallback 机制

任何算法失败都必须安全降级：

```text
Smart Transition
       ↓
No suitable transition
       ↓
Equal Power Crossfade
       ↓
If crossfade unavailable
       ↓
Normal track switch
```

不能因为：

```text
BPM detection failed
```

导致：

```text
音乐无法播放
```

---

# 三十二、最终用户体验

用户不会看到：

```text
BPM
FFT
RMS
Spectral Flux
```

这些全部隐藏。

用户只会感觉：

### 舞曲 → 舞曲

```text
Beat
● ● ● ● ● ● ● ●

下一首
● ● ● ● ● ● ● ●
```

自然融合。

### 流行 → 流行

```text
A Vocal
██████████
          ↓
       Instrumental
          ↓
             B Vocal
             █████████
```

避免两个歌手同时唱。

### Rock → Rock

```text
A ███████████████ 💥
                     ↓
                     B ███████████████
```

短而有力。

### Ambient → Ambient

```text
A ███████████████████
             ╲
              ╲
               ╲
                █████████████████ B
```

长时间平滑融合。

---

# 三十三、工程实现要求

在开始修改代码之前：

1. 阅读整个现有音频播放架构。
2. 找到当前 M4A/AAC 解码流程。
3. 找到当前 Next / Previous / End-of-track 逻辑。
4. 找到当前 Audio Buffer / PCM 数据处理位置。
5. 找到当前 crossfade 实现，如果存在。
6. 判断项目使用的语言和音频库。
7. 不要重写已有的播放系统。
8. Smart Transition 应作为独立模块加入。

建议模块结构：

```text
audio/
├── decoder
├── player
├── mixer
├── dsp
│   ├── gain
│   ├── eq
│   ├── filter
│   └── resampler
│
└── transition/
    ├── analyzer
    ├── beat_detector
    ├── energy_analyzer
    ├── spectral_analyzer
    ├── vocal_estimator
    ├── transition_points
    ├── transition_scorer
    ├── strategy_selector
    ├── transition_planner
    └── transition_executor
```

根据现有项目结构调整，不要强行创建完全不同的架构。

---

# 三十四、第一版不要过度设计

V1 优先实现：

```text
M4A/AAC
 ↓
轻量 PCM Analysis
 ↓
BPM
Beat
RMS Energy
Spectral Features
 ↓
Transition Points
 ↓
Candidate Matching
 ↓
Transition Score
 ↓
Strategy Selection
 ↓
Equal-Power Crossfade
```

暂时不要实现：

```text
AI
Deep Learning
复杂人声分离
完整音乐结构识别
复杂 Key Detection
实时复杂 DSP
```

确保 V1：

> 稳定、快速、低 CPU、不会卡顿。

---

# 三十五、测试

至少建立以下测试：

```text
1. Dance → Dance
2. Pop → Pop
3. Pop → Rock
4. Rock → Rock
5. Ambient → Ambient
6. 不同 BPM
7. 人声密集歌曲
8. Instrumental
9. 极短歌曲
10. BPM 无法检测
11. 分析失败
12. 用户主动快速切歌
13. 自然播放到结尾
14. 连续播放 10+ 首
```

测试重点不是“算法分数多高”，而是：

```text
有没有卡顿？
有没有突然变响？
有没有突然变小？
有没有两个低频叠在一起？
有没有两个歌手同时唱得很乱？
切歌响应是否及时？
有没有出现空白？
有没有爆音 / click / pop？
```

---

# 三十六、最终验收标准

完成后，我希望播放器实现：

```text
用户点击 Next
       ↓
立即响应
       ↓
后台已经有 TrackAnalysis
       ↓
< 50ms 内完成 Transition Planning
       ↓
找到最佳 Exit / Entry
       ↓
自动选择 Transition Strategy
       ↓
执行平滑过渡
       ↓
下一首开始
```

整个过程：

> 不使用 AI，不联网，不等待模型，不阻塞 UI，不阻塞音频线程。

最终用户的感知应该是：

> “我点了下一首，但是音乐没有生硬地断掉，而是自然地流到了下一首。”

---

# 三十七、重要原则

请牢记：

**第一优先级：播放稳定性**

**第二优先级：用户响应速度**

**第三优先级：音乐连续性**

**第四优先级：Transition 音乐质量**

不要为了追求理论上的最佳 transition，而让用户点击 Next 后等待。

宁可：

```text
80 分的 transition
立即执行
```

也不要：

```text
100 分的 transition
等待 2 秒
```

Smart Transition 应该是：

```text
Fast
+
Deterministic
+
Offline
+
Lightweight
+
Graceful Fallback
```

完成后请向我说明：

1. 你检查到了现有播放器的哪些音频处理流程；
2. 选择了哪些分析算法以及为什么；
3. TrackAnalysis 如何缓存；
4. 用户主动切歌和自然结束分别如何处理；
5. Transition Score 如何计算；
6. 最终选择了什么 Transition Strategy；
7. CPU / 内存开销；
8. 如何保证不影响正常播放；
9. 修改了哪些文件；
10. 如何测试。