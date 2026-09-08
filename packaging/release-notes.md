## BiliMusic v0.3.0: standalone applications / 独立客户端

Desktop v0.3.0 and Android v0.3.0 deliver the largest experience update so far: background playback with a system media card, per-layer back navigation, immersive system bars, a branded startup screen, and multi-part Bilibili videos imported as albums.

桌面与 Android 同步升级 v0.3.0，这是迄今幅度最大的一次体验更新：后台播放与系统媒体卡片、逐层返回、系统栏沉浸、品牌启动页，以及「多分 P 视频导入为专辑」。

### Playback / 播放

- Background playback through a foreground service, with a system media card (artwork, progress, play/pause, skip) plus lock-screen and wired/Bluetooth headset controls. Playback pauses automatically when headphones are unplugged. / 通过前台服务实现后台播放，配套系统媒体卡片（封面、进度、播放/暂停、上下曲）与锁屏、有线/蓝牙耳机控制；拔出耳机自动暂停。
- Audio streams are routed by part id: songs imported from a later part of a multi-part video now play that part instead of the first one. / 音轨按分 P 路由：从多分 P 视频后段导入的歌曲现在播放对应分 P，而不是第一分 P。
- Space toggles playback on desktop; mobile transport buttons follow the standard previous / play / next order. / 桌面空格键播放/暂停；移动端播放键恢复标准「上一首 / 播放 / 下一首」顺序。
- Progress and volume sliders show the pink fill again; very long titles scroll inside the player bar. / 进度与音量滑条恢复粉色填充；超长歌名在播放条内滚动显示。

### Albums / 专辑

- Multi-part Bilibili videos import as albums: track list, per-track streaming and lyrics, album-level favorite and delete semantics, lazy materialization for very large collections, and cleaned part titles. / 多分 P 视频导入为专辑：曲目列表、逐曲播放与歌词、专辑级收藏与删除语义、超大合集懒物化、分 P 标题清洗。

### Lyrics / 歌词

- NetEase Cloud Music joins the lyrics chain as an additional synced source, with retry / switch source in the lyrics view, a source badge, and better contrast for inactive lines. / 网易云音乐作为新增带轴歌词源接入取词链，歌词页支持「重试 / 换源」、显示来源角标，并提升非当前行对比度。

### Shell and navigation / 壳与导航

- Immersive system bars (edge-to-edge) with insets injected into the page; a branded dark splash with the app icon. / 系统栏沉浸（edge-to-edge，insets 注入页面）；品牌深色启动页与图标。
- The back gesture/button unwinds in-app layers (lyrics, queue, dialogs, details) before exiting. / 返回手势/按键逐层关闭应用内层级（歌词、队列、弹窗、详情）后才退出。
- Mobile: the library tab and home sections no longer disappear after visiting a recommended playlist; feed views support pull-to-refresh. / 移动端：经过推荐歌单详情后，曲库 Tab 与主页区段不再丢失；feed 视图支持下拉刷新。
- macOS desktop: native rounded window with system traffic lights (overlay title bar), with drag regions on the top bar and sidebar. / macOS 桌面：原生圆角窗口与系统红绿灯（Overlay 标题栏），顶栏与侧栏可拖动。

### Installers / 安装包

All installers include the Python backend. No separate server or Python installation is required. Internet access to Bilibili is required for streaming.

所有安装包均内置 Python 后端，无需额外安装 Python 或启动服务器；在线播放仍需要联网访问 B 站。

| Platform / 平台 | Download / 文件 |
| --- | --- |
| macOS 14+ Apple Silicon | `*-mac-arm64.dmg` |
| macOS 14+ Intel | `*-mac-x64.dmg` |
| Windows x64 | `*-win-x64.exe` |
| Android 8+ ARM64 / x86_64 | `*-android.apk` |

Desktop builds are not developer-signed or notarized, so macOS and Windows may display security prompts. Android APKs use the project's persistent signing key and are distributed outside Google Play.

桌面版暂未使用开发者证书签名或公证，macOS、Windows 可能显示安全提示。APK 使用项目固定签名，供直接安装，不通过 Google Play 分发。

Android v0.3.0 supports background playback and lock-screen controls. Advanced audio analysis still requires an external audio decoder on desktop and is not bundled on Android.

Android v0.3.0 已支持后台播放与锁屏控制；高级音频分析仍需桌面端外部解码器，Android 未内置。

See `SHA256SUMS.txt` for download checksums. Account data and cookies stay in each application's private data directory.

校验和见 `SHA256SUMS.txt`；账号数据与 Cookie 均保存在各应用的私有数据目录。
