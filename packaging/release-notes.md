## BiliMusic v1.0.1: 收藏夹全量同步 + 扫码登录 / full favourites sync + QR login

Desktop v1.0.1 and Android v1.0.1 fix the biggest real-world bug since v1.0.0 and replace SMS login with a single-tap QR flow. Full detail: `docs/bugs.md`.

桌面与 Android v1.0.1 修复了 v1.0.0 以来最严重的实测问题，并把短信登录换成「点二维码」流程。详见 `docs/bugs.md`。

### 收藏夹同步（P0）/ Favourites sync

- **修复「只同步前 20 条」**：收藏夹分页接口把 `media_count` 放在 `info` 里，旧代码取顶层字段恒为 0，导致每个收藏夹只拉第一页（20 条）；多设备各自停在不同的前 20 条，看起来就是子集。改用 `has_more` 翻页后全量拉取。 / The favourites folder list was only ever paginated once (20 items) because `media_count` lives under `info`, not at the top level; the loop terminated immediately. Now driven by `has_more`.
- 实测：`bilimusic` 收藏夹 20 → **30** 全量；收藏夹链接批量导入走同一函数，一并修复。 / Verified against the real account: 20 → 30 items; batch import from a favourites link shares the same fix.

### 登录 / Login

- **短信登录下线**：极验滑块在 WebView 里不稳定（且依赖跨境 CDN），整体移除手机号/验证码/滑块流程。 / SMS login removed — the Geetest slider was unreliable inside the WebView.
- **点二维码即可**：Android 上点登录二维码 → 自动存入系统相册 + 拉起 B 站 App，用「扫一扫 → 相册」选中即可完成登录；浏览器/桌面回退为直接下载。 / Tap the login QR on Android: it is saved to the gallery and the Bilibili app is opened, so you can scan it from the album; browsers fall back to a direct download.
- 验证参数接口增加重试（网络抖动时不再直接失败），并把真实错误显示出来。 / The captcha endpoint now retries on network hiccups and surfaces the real error.

### 曲库计数 / Library counts

- 计数改为 **B 站收藏夹视频数** 口径（每个多 P 合集算 1 条），曲库详情同时列出合集容器，侧栏计数在收藏后立即刷新。 / Counts now follow the favourites-video unit; containers are listed alongside songs and the sidebar refreshes immediately.

### 其他 / Misc

- 推荐歌单卡片去掉多余的圆形播放按钮。 / Removed the redundant play button on recommended-playlist cards.

### 安装 / Installers

- macOS: `BiliMusic-1.0.1-mac-arm64.dmg` / `BiliMusic-1.0.1-mac-x64.dmg`
- Windows: `BiliMusic-1.0.1-win-x64.exe`
- Android: `BiliMusic-1.0.1-android.apk` (arm64-v8a / x86_64)
- `SHA256SUMS.txt` for verification

> 数据目录沿用旧版本；升级后打开 App 会自动重新同步一次收藏夹（现在是全量）。 / Data directories are reused; the app re-syncs the full favourites folder on first launch after upgrading.
