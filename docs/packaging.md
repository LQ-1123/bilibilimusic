# Standalone Builds / 独立打包

The desktop shell launches a bundled Python process on an ephemeral loopback port. Android starts the same backend using Chaquopy inside the application process. Application data is kept outside the installation directory.

桌面版使用 Electron 启动内置 Python 可执行程序；Android 使用 Chaquopy 在应用内运行后端。服务仅监听本机随机端口，数据保存在应用数据目录。

## Desktop / 桌面

Requires Python 3.11, Node.js 22 and the target OS. Build on macOS for DMG, Windows for EXE.

```bash
python -m pip install -r packaging/requirements.txt pyinstaller==6.19.0
python packaging/build-backend.py
cd desktop
npm ci
npm run dist
```

Outputs: `desktop/dist/`. Backend logs: `backend.log` in Electron's `userData` directory. Account data: its `data/` subdirectory.

- macOS: `~/Library/Application Support/BiliMusic/` (Electron may use package name `bilimusic` in development).
- Windows: `%APPDATA%/BiliMusic/`.
- Android: private app files directory; uninstalling removes local data.

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

Run **Build and Release** from the Actions tab, or push a `v*` tag. Application versions in `desktop/package.json` and `android/app/build.gradle` must match the release tag; Android `versionCode` must increase for upgrades.

Repository secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore and key password.

The workflow builds Windows x64, macOS ARM64/x64, and an Android ARM64/x64 APK. Each desktop backend is started and its page/assets tested; the Android APK must launch its backend and WebView in an emulator. Only after all jobs succeed is a Release created with installers and `SHA256SUMS.txt`.

所有任务通过后才发布 Release，并附带 SHA-256 校验文件。桌面开发者证书签名、公证和 Android 后台播放服务不属于首版实现。
