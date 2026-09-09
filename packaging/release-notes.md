## BiliMusic v1.1.0: 分享能力与手机端打磨 / sharing and mobile polish

Desktop v1.1.0 and Android v1.1.0 are a feature release on top of v1.0.2.

v1.1.0 在 v1.0.2 基础上新增分享能力，并集中打磨手机端界面与歌词质量。

### 分享 / Sharing

- **正向分享**：曲库单曲、歌单、专辑/合集、UP 主页、导出弹窗都能一键分享，内容是**真实 B 站链接**（自带 B 站预览卡，不做视觉仿冒）。降级链：Android 原生分享面板 → `navigator.share` → 剪贴板 → `execCommand` → 弹窗展示链接，**任何一环失败都不会静默**。 / Share songs, playlists, albums, UP pages and export links with the real Bilibili URL. Fallback chain: native Android share sheet → `navigator.share` → clipboard → `execCommand` → show the link in a dialog; no step fails silently.
- **反向分享**：在 B 站 App 点分享 → 系统面板里选 BiliMusic → 一步入库（收藏夹 / 合集链接同样识别）。未登录或文本里没有 B 站链接时会直接说清原因。 / Reverse sharing: share from the Bilibili app and pick BiliMusic to import in one step; unreadable text and logged-out states are explained instead of failing silently.
- **修掉系列合集分享链接**：跨视频合集以前会拼出打不开的 `video/sid:…`，现在走 `collectiondetail?sid=…`；拿不到来源 UP 时明确提示，不再发半截链接。 / Fixed broken share links for cross-video collections.

### 手机端 / Mobile

- **底部导航液态玻璃选中块**：可跟手拖动，拖动中水珠形变并溢出导航条，松手过阻尼落位不弹跳。 / Liquid-glass nav pill: follows the finger, deforms like a droplet while dragging, settles without overshoot.
- **播放条精简**：只保留封面、歌名/UP、播放与切歌，去掉进度条与次要按钮。 / Slim player bar: cover, title/artist and transport only.
- **播放页与歌词页改版**：按参考图比例重建（封面 75% 宽、控件与底行对齐），歌名走马灯两端羽化，歌词字号与进度条加粗，收藏与「···」对齐且已收藏为粉色。 / Rebuilt the player and lyrics pages to the reference proportions, with marquee fades and a pink active favourite.
- **PC 歌词页**：去掉与「点封面打开歌词」重复的歌词按钮，左上角关闭钮常显（桌面没有返回手势）。 / Desktop lyrics page: removed the duplicate lyrics button and kept the close button always visible.

### 歌词质量 / Lyrics

- 兜底来源加**置信度校验**：网易云错配不再冒充命中，宁可空着也不显示错歌词。 / Confidence checks on fallback lyric sources: a wrong match no longer counts as a hit.
- 合集子曲目标题收敛为分集名，歌词候选提取不再丢掉真歌名。 / Album child titles collapse to the part title, so lyric candidates keep the real song name.

### 安装 / Installers

- macOS: `BiliMusic-1.1.0-mac-arm64.dmg` / `BiliMusic-1.1.0-mac-x64.dmg`
- Windows: `BiliMusic-1.1.0-win-x64.exe`
- Android: `BiliMusic-1.1.0-android.apk` (arm64-v8a / x86_64)
- `SHA256SUMS.txt` for verification

> 数据目录沿用旧版本；老库启动时自动补 `album.mid` 列。 / Data directories are reused; older databases get the new `album.mid` column on startup.
