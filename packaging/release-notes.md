## BiliMusic v1.0.0: 首个稳定版 / first stable release

Desktop v1.0.0 and Android v1.0.0 mark the first stable release: a personal Bilibili music player where your Bilibili favourites are the single source of truth.

桌面与 Android v1.0.0 是首个稳定版——一个以 **B 站收藏夹为唯一事实源** 的个人 B 站音乐播放器。

### 核心能力 / Highlights

- **曲库以 B 站收藏夹为准**：登录后自动同步（打开即同步一次 + 15 秒心跳比对 + 5 分钟兜底全账），多设备登录同一账号后计数与内容一致。 / Your library mirrors your Bilibili favourites: auto-sync on launch, a 15-second folder-count heartbeat and a 5-minute full reconcile keep every device consistent.
- **合集 = 歌单式容器**：多分 P 视频与 B 站跨视频「系列」都导入为容器，点开看到全部子作品，用星标逐首收藏；不再「收藏一次全塞进曲库」。 / Multi-part videos and cross-video series both import as playlist-like containers: open one to see every work and star the ones you want — no more dumping everything into the library at once.
- **搜索三分类**：搜索结果分为 UP 主 / 合集 / 歌曲，合集卡带「合集 · N 首」角标，点开即建容器。 / Search results split into uploaders / collections / songs, with a collection badge and one-tap container creation.
- **系统级播放**：Android 通知栏与锁屏媒体卡片（封面、进度、上下曲、点按回 App），耳机拔出自动暂停；桌面空格键播放/暂停。 / System media card on Android (artwork, progress, skip, tap to return), pause on headphone unplug, and spacebar play/pause on desktop.

### 本版修复 / Fixes in this release

- **移动端短信登录**：WebView 之前不渲染极验滑块（UA 被识别为 WebView + 第三方 Cookie 被拦）→ 已伪装为手机 Chrome 并放开第三方 Cookie，短信登录可直接在 App 内完成。 / Mobile SMS login: the Geetest slider now renders inside the WebView (realistic UA + third-party cookies), so login no longer requires the system browser.
- 曲库计数改为「收藏夹视频数」口径（每个合集算 1 条），并让曲库详情同时列出合集容器。 / Library counts now use the favourites-video unit, with containers listed alongside songs.
- 中文输入法在搜索框选词不再被打断；搜索详情页返回、UP 主页底部导航、通知栏信息等一批体验问题一并修复。 / Chinese IME input no longer breaks in the search box; back navigation, the UP page dock and notification metadata were fixed too.
- 桌面壳：去掉多余窗口标题、修复窗口拖动、关窗秒退、最小窗口尺寸限制。 / Desktop shell: window title removed, dragging fixed, instant quit, minimum window size.
- 推荐歌单卡片去掉多余的圆形播放按钮。 / Removed the redundant play button on recommended-playlist cards.

### 安装 / Installers

- macOS: `BiliMusic-1.0.0-mac-arm64.dmg` (Apple Silicon) / `BiliMusic-1.0.0-mac-x64.dmg` (Intel)
- Windows: `BiliMusic-1.0.0-win-x64.exe`
- Android: `BiliMusic-1.0.0-android.apk` (arm64-v8a / x86_64)
- `SHA256SUMS.txt` for verification

> 数据目录沿用旧版本，升级不需要重新导入曲库。 / Data directories are reused; no re-import needed when upgrading.
