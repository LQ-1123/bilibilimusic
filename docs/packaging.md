# Standalone Builds / 独立打包

The Tauri desktop shell launches a bundled Python process on an ephemeral loopback port. macOS uses WKWebView and Windows uses WebView2. Android retains the existing Java WebView and Chaquopy backend. Application data is kept outside the installation directory.

桌面版使用 Tauri / Rust 启动内置 Python 可执行程序；Android 保持原生 WebView 和 Chaquopy。服务仅监听本机随机端口，数据保存在应用数据目录。前端没有重写，也不向网页开放 Tauri 原生权限。

## Desktop / 桌面

Requires Python 3.11, Node.js 22, stable Rust and the target OS. macOS requires Xcode command-line tools; Windows requires the Visual Studio C++ build tools. Build on macOS for DMG, Windows for EXE.

macOS installers require macOS 14 or newer, matching the bundled NumPy ARM64 wheel's deployment target. The system WebView alone supports older versions, but the complete application must meet all bundled dependencies' requirements.

```bash
python -m pip install -r packaging/requirements.txt pyinstaller==6.19.0
python packaging/build-backend.py
cd desktop
npm ci
npm run dist
```

Outputs: `desktop/src-tauri/target/release/bundle/`. CI copies installers with normalized filenames into `desktop/dist/`. Backend logs: `backend.log` in the application-data root; account data: its `data/` subdirectory.

- macOS: `~/Library/Application Support/bilimusic/`.
- Windows: `%APPDATA%/bilimusic/`.
- Android: private app files directory; uninstalling removes local data.

Existing Electron data directories are reused, including the alternative capitalized `BiliMusic` directory. A Windows migration may leave the older Electron installation listed separately; the new application does not uninstall it automatically. Back up your data before removing an old installation.

Browser-local preferences (theme, local playback history, and playback position) are not migrated from Electron's browser profile to the system WebView. Account cookies stored by Python and the SQLite music library are preserved. Close the old client before opening the new one.

沿用旧 Electron 的数据目录，不需要重新导入曲库。Windows 的旧 Electron 安装项可能仍单独存在，不会自动卸载。新 Windows 安装包内含 WebView2 离线安装器，缺少系统运行时时可安装；这也意味着 EXE 体积未必小于 Electron 版本。仍未进行整组进程内存基准测试，不承诺节省比例。

主题、本机播放历史和播放位置等浏览器本地偏好不会从 Electron 自动迁移；Python 保存的登录凭据和 SQLite 曲库会保留。升级时请先关闭旧客户端。

## Android

Requires JDK 17, Gradle 8.11.1, Android SDK 35 and Python 3.11. Dependencies use Pydantic 1's Python implementation to avoid unsupported Android Rust extensions.

```bash
mkdir -p android/app/src/main/res/drawable
cp app/web/static/icon-192.png android/app/src/main/res/drawable/icon.png
gradle -p android assembleDebug
```

For release builds, set `ANDROID_KEYSTORE` and `ANDROID_KEYSTORE_PASSWORD`; the key alias must be `bilimusic`. Then run `gradle -p android assembleRelease`.

发布版必须配置固定签名，不能每次生成新签名，否则已安装用户无法覆盖升级。当前项目签名保存在 GitHub Actions Secrets；不要将密钥提交到源码。

## GitHub Actions

Run **Build and Release** from the Actions tab, or push a `v*` tag. Keep desktop versions aligned in `desktop/package.json`, `desktop/src-tauri/Cargo.toml`, and `desktop/src-tauri/tauri.conf.json`. Android keeps its own version when unchanged; increase `versionCode` for Android updates.

Repository secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore and key password.

The workflow builds Windows x64, macOS ARM64/x64, and an Android ARM64/x64 APK. Each desktop backend is started and its page/assets tested; the actual Tauri WebView must load the local page and terminate its backend on exit. Android must launch its backend and WebView in an emulator. Only after all jobs succeed is a Release created with installers and `SHA256SUMS.txt`.

所有任务通过后才发布 Release，并附带 SHA-256 校验文件。桌面开发者证书签名、公证和 Android 后台播放服务不属于首版实现。
