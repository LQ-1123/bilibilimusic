## BiliMusic: standalone applications / 独立客户端

Desktop v0.2.0 replaces Electron with Tauri 2 (WKWebView on macOS, WebView2 on Windows). Frontend and Python backend are retained, including existing account data directories. Android remains on its native WebView/Chaquopy architecture and version 0.1.0.

桌面 v0.2.0 将 Electron 替换为 Tauri 2，保留网页、Python 后端和旧数据目录。Android 继续使用原生 WebView / Chaquopy，版本仍为 0.1.0。尚未完成内存基准测试，不承诺具体降低比例。

All installers include the Python backend. No separate server or Python installation is required. Internet access to Bilibili is required for streaming.

所有安装包均内置 Python 后端，无需额外安装 Python 或启动服务器；在线播放仍需要联网访问 B 站。

| Platform / 平台 | Download / 文件 |
| --- | --- |
| macOS Apple Silicon | `*-mac-arm64.dmg` |
| macOS Intel | `*-mac-x64.dmg` |
| Windows x64 | `*-win-x64.exe` |
| Android 8+ ARM64 / x86_64 | `*-android.apk` |

Desktop builds are not developer-signed or notarized, so macOS and Windows may display security prompts. Android APKs use the project's persistent signing key and are distributed outside Google Play.

桌面版暂未使用开发者证书签名或公证，macOS、Windows 可能显示安全提示。APK 使用项目固定签名，供直接安装，不通过 Google Play 分发。

Android playback is supported while the app is open. Background playback and lock-screen controls are not guaranteed in this initial release. Advanced analysis requires an external audio decoder on desktop and is not bundled on Android.

首版 Android 支持应用内播放，暂不保证后台播放和锁屏控制；高级音频分析需要外部解码器，Android 未内置此功能。

See `SHA256SUMS.txt` for download checksums. Account data and cookies stay in each application's private data directory.
