## BiliMusic: standalone applications / 独立客户端

Desktop v0.2.1 fixes covers and avatars not rendering in packaged apps: Bilibili CDN images were served as plain `http://` and blocked by macOS App Transport Security and Android cleartext policy. All media URLs are now upgraded to `https://`, and existing libraries are migrated automatically on first launch. Android v0.1.2 ships the same fix.

桌面 v0.2.1 修复打包版封面/头像不显示：B 站 CDN 图片此前以 `http://` 明文下发，被 macOS ATS 与 Android 明文流量策略拦截。现所有媒体 URL 统一升级 `https://`，旧曲库首次启动自动迁移。Android v0.1.2 同步修复。

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

Android playback is supported while the app is open. Background playback and lock-screen controls are not guaranteed in this initial release. Advanced analysis requires an external audio decoder on desktop and is not bundled on Android.

首版 Android 支持应用内播放，暂不保证后台播放和锁屏控制；高级音频分析需要外部解码器，Android 未内置此功能。

See `SHA256SUMS.txt` for download checksums. Account data and cookies stay in each application's private data directory.
