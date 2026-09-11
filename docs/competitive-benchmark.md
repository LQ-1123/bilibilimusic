# 竞品对标（2026-09）

> 写作时间：2026-09-11 ｜ 版本基准：v2.0.0 ｜ 方法：在线调研（关键结论带来源链接）
> 与 `docs/product-analysis.md` 的关系：那份是**结构性**对比（四类竞品、取舍分析），本文是**功能级**对标——逐家看它们在做什么、用户抱怨什么、BiliMusic 该抄什么、该躲什么。候选需求统一编号（A=高契合 / B=中契合），供《需求调查表》打分用。

---

## 1. B 站官方 App（最直接的替代品）

**事实**

- 「听模式」存在但入口极隐蔽（视频右上角耳机图标），大量用户靠教程视频才知道怎么开（[B站教程视频](https://www.bilibili.com/video/BV1RRrSYCE3w/)、[隐藏音乐模式](https://www.bilibili.com/video/BV1jA411b7Nt/)）。
- 官方明确：**竖屏视频不支持后台播放**，仅横屏可后台（[官方公告](https://www.bilibili.com/opus/696483832460738584)）——而音乐区内容大多是竖屏。
- 高频抱怨：播放列表挂小窗约每 20 个视频必停、后台播放时点进 UP 主主页断音、与其他 App 音频焦点冲突、开关藏太深（[知乎1](https://www.zhihu.com/question/646529501)、[知乎2](https://www.zhihu.com/question/459488133)、[知乎3](https://www.zhihu.com/question/526430390)）。
- 收藏夹有「播放全部」+自动连播，但本质仍是视频队列（[知乎](https://www.zhihu.com/question/431103638/answer/1585661076)）；用户被逼得自己写第三方播放器（[实例](https://www.bilibili.com/video/BV1cw4m1k7zV/)）。

**对 BiliMusic 的意义**：「B 站当音乐 App 用」的队列稳定性是**被官方验证过的真实痛点**，「收藏夹即歌单」正中要害。
→ 候选需求 **A1 队列稳定性承诺**（收藏夹连播不断、不被打断）。
**警惕**：官方随时可能改进听模式；护城河应押在跨端串流（官方明确没有多设备共享会话）而非播放本身。

## 2. YouTube Music（「视频即音源」的同类逻辑）

**事实**

- 最大痛点是**曲-音源映射不稳定**：explicit/clean 版本被静默互换、元数据正确但音频放错且无处报错（[9to5Google](https://9to5google.com/2023/08/31/youtube-music-changed-videos/)、[Reddit](https://www.reddit.com/r/YoutubeMusic/comments/en3nbu/how_to_report_wrong_songs/)）。
- 设备切换：Cast 常因更新损坏，Web 端长期缺「转移到 Cast」按钮（[Chrome Unboxed](https://chromeunboxed.com/youtube-music-transfer-web-player-cast-button-chromecast-audio/)）；后来补上的**播放进度跨设备同步**被用户视为刚需（[Android Authority](https://www.androidauthority.com/youtube-music-playback-sync-3578668/)）。
- 免费版无后台/无离线是最大抱怨；2025 年连 Premium Lite 都补上了后台+下载（[官方博客](https://blog.youtube/news-and-events/youtube-premium-lite-background-play-downloads/)）。

**对 BiliMusic 的意义**：v2.0.0 已经把「切设备保留队列+进度」做对了（这正是 YTM 用户眼里的刚需）。播放界面已展示 UP 主/来源，天然防错配。
→ 候选需求 **A2 串流细节打磨**（切换即时性、来源可见性）。
**警惕**：静默替换音源是重罪——若做音质档位/CDN 换源，必须保证拿到的是同一版本。

## 3. Spotify Connect（跨端串流的标杆）

**事实**

- 核心设计：**手机只是遥控器**，目标设备直连音源，切换瞬间完成、播放不中断、队列跟随账号走（[开发者文档](https://developer.spotify.com/documentation/commercial-hardware/implementation/guides/connect-basics)）——与 v2.0.0「转移会话状态而非音频数据」同原理。
- 细节：设备列表噪音可过滤「仅显示本地设备」（[支持页](https://support.spotify.com/us/article/spotify-connect/)）；**自动切换设备争议大**，社区大量用户要求能关掉（[社区帖](https://community.spotify.com/t5/Android/Connect-Disable-automatic-switching-between-devices/td-p/5275048)）。

**对 BiliMusic 的意义**：确认 v2.0.0 的方向与业界标杆一致，剩下的是切换即时性打磨。
→ 候选需求 **B1 自动连接开关**（Spotify 的教训：自动接管要给用户退路；默认开，尊重「自动、无感」的原始要求）。

## 4. GitHub 同类 B 站播放器（需求已被验证的领域）

| 项目 | Stars | 活跃度 | 功能集 |
|---|---|---|---|
| [wood3n/biu](https://github.com/wood3n/biu) | 2671 | 2026-09 仍更新 | 收藏夹/稍后再看/历史、优先拉 FLAC/Hi-Res 高码率、批量下载、mini 播放器、托盘、深浅主题 |
| [azusa-player-mobile](https://github.com/lovegaoshi/azusa-player-mobile) | 1361 | 活跃 | 对标 YTM：歌单订阅、下载、歌词搜索、云备份 |
| [BBPlayer](https://github.com/bbplayer-app/BBPlayer) | 916 | 活跃 | 收藏夹变听歌列表、逐字歌词、离线缓存、音频导出 |
| [azusa-player](https://github.com/kenmingwang/azusa-player) | 615 | 2026-04 | 浏览器扩展形态 |

**对 BiliMusic 的意义**：收藏夹即歌单、高音质档、歌词、移动端是**同类项目的共性刚需**；其中高码率档位（大会员解锁）被 biu 证明是最快的体验提升点。
→ 候选需求 **A3 音质档位放开**（320K/Hi-Res 随账号权益，需先修 BUG-006 选档逻辑）、**B2 mini 播放器/托盘遥控**、**B3 稍后再看/历史入口**、**B4 桌面歌词/逐字歌词**。
**警惕**：全家都做下载，但那与本项目「不做离线」定位冲突，不能被带偏（见 §6 分歧）。

## 5. 自建音乐生态（Navidrome / Plexamp）

**事实**

- Navidrome/Subsonic 社区最高频诉求：可靠的移动端离线缓存、客户端质量参差、Android Auto；成熟客户端标配 gapless、crossfade、ReplayGain 音量均衡、EQ、智能歌单、LRCLIB 同步歌词（[社区讨论1](https://www.reddit.com/r/navidrome/comments/1umie0j/app_news_weekly/)、[讨论2](https://www.reddit.com/r/navidrome/comments/1okzfga/whats_missing_from_navidrome_apps/)）。
- Plexamp 被爱的核心是 **Sonic Analysis**：声波相似推荐/自动 Mix，用户称「比我手工排的列表好」（[Plex 官方](https://support.plex.tv/articles/sonic-analysis-music/)、[TechCrunch](https://techcrunch.com/2021/08/12/plexs-new-feature-matches-your-sonically-similar-music-to-make-playlists/)）。

**对 BiliMusic 的意义**：
→ 候选需求 **A4 音量均衡 + gapless**（低成本高感知，B 站各视频响度差异大，此问题比版权平台严重得多）、**A5 漫游电台**（以收藏夹为种子自动补队列——Plexamp Mixes 的模式可以移植到「相关视频搭车采集」上，把现有推荐从被动变主动）。

## 6. 国内大厂（汽水 / 网易云 / QQ 音乐）

**事实**

- 汽水音乐 2025-09 MAU 破 1.2 亿（QuestMobile），主打 AI 推荐+场景电台、无损、桌面歌词（[新浪财经](https://finance.sina.cn/stock/jdts/2026-02-14/detail-inhmuaqn8349440.d.html)）。
- 网易云：AI 灵感歌单（一句话生成）、跨端续播、「导入外部歌单」（链接/二维码）（[知乎专栏](https://zhuanlan.zhihu.com/p/27045334524)）。
- QQ 音乐：鸿蒙跨设备无缝接续+碰一碰、三合一歌单导入（文本/图片/链接）、**弱网自动切音质**；反面教材：2025-04 起会员限制单日播放设备数（[下载页](https://y.qq.com/download/download.html)）。

**对 BiliMusic 的意义**：
→ 候选需求 **A6 弱网自动降档**（QQ 音乐已验证的模式，也缓解 CDN 抽风）、**B5 歌单导入增强**（现在已支持粘贴链接，可增强为粘贴整段文本批量识别）。
大厂**全员押注跨设备**（汽水/网易云/QQ/鸿蒙），印证会话转移方向正确；QQ 音乐的设备数限制则是自建服务最好的招募广告。

---

## 7. 候选需求池汇总（调查表打分用）

| 编号 | 需求 | 来源竞品 | 一句话说明 |
|---|---|---|---|
| **A1** | 队列稳定性承诺 | B站官方痛点 | 收藏夹连播不断、CDN 失败自动换源自愈（部分已有，升格为承诺并回归覆盖） |
| **A2** | 串流细节打磨 | Spotify Connect / YTM | 切换即时性、进度完整性、设备列表噪音过滤 |
| **A3** | 音质档位放开 | biu / B站接口 | 320K/Hi-Res 随大会员权益；前置修复 BUG-006 选档逻辑 |
| **A4** | 音量均衡 + gapless | Navidrome / Plexamp | B站视频间响度差异大，低成本高感知 |
| **A5** | 漫游电台 | Plexamp Mixes / 汽水 | 以收藏夹/当前歌为种子自动补队列，把「搭车采集」从被动变主动 |
| **A6** | 弱网自动降档 | QQ 音乐 | 弱网/切网自动切低码率，恢复后回升 |
| **B1** | 自动连接开关 | Spotify 社区 | 零点击自动连接保留为默认，但给一个「今天别自动接管」的退路 |
| **B2** | mini 播放器 / 托盘遥控 | biu | 桌面端缩小成小窗/托盘控制 |
| **B3** | 稍后再看 / 历史入口 | biu | 曲库的补充入口，不进收藏夹也能听 |
| **B4** | 桌面歌词 / 逐字歌词 | BBPlayer / 汽水 | 桌面悬浮歌词；逐字卡拉OK效果 |
| **B5** | 歌单导入增强 | QQ 三合一 / 网易云 | 粘贴整段分享文本批量识别成歌单 |
| **B6** | 轻量听歌报告 | 网易云 / QQ | 本地数据就能出的「本周听了什么」，零算法依赖 |
| **B7** | UP 更新订阅 / 收藏夹更新提醒 | product-analysis P1 | 内容发现的最小形态 |
| **B8** | 广域网访问引导 | product-analysis P2 | 把 Tailscale 方案做成内置引导页 |
| **B9** | iOS / PWA 增强 | product-analysis P2 | 现状只有浏览器体验 |
| **B10** | 歌词质量看板 | product-analysis P3 | 哪首没歌词、为什么 |
| **B11** | 多用户 / 家庭共享 | product-analysis P2 | 竞品调研认为与定位冲突，仅保留讨论位 |
| **T1** | 离线轻缓存（听过的可离线） | product-analysis P1 ↔ 竞品调研「低契合」 | **两份分析有真分歧**，见调查表取舍题 |

## 8. 与 product-analysis.md 结论的增量

1. **新增了 product-analysis 没有的项**：音量均衡+gapless（A4）、漫游电台（A5）、弱网降档（A6）、自动连接开关（B1）、听歌报告（B6）。
2. **强化了「音质放开」的优先级证据**：biu 2671 star 把高码率作为核心卖点，B站官方竖屏不能后台更凸显独立客户端价值。
3. **暴露一处真分歧**：离线缓存——product-analysis 列为 P1（通勤场景），竞品调研判为低契合（同类全家做下载恰说明它是红海、且与「不存音频」定位冲突）。交由调查表取舍题 T1 裁决。
4. **护城河判断一致**：官方听模式可能进步，但「多设备共享会话」官方明确没有、大厂才刚全员入场——跨端串流是 BiliMusic 唯一别人短期抄不走的资产，后续投入应优先加固而非替换。
