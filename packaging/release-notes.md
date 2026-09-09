## BiliMusic v1.0.2: 启动页与移动端细节 / splash and mobile polish

Desktop v1.0.2 and Android v1.0.2 are a small polish release on top of v1.0.1.

v1.0.2 是在 v1.0.1 基础上的体验修补版。

### 启动页 / Splash

- 启动页改为**等比缩放整图显示，不裁切**；四周留白与图片底色同为白色，因此看不出接缝（实测边缘色差 2）。桌面用 `loading_pc.png`、手机用 `loading_mobile.png`。 / The splash now scales the whole artwork without cropping; the surrounding padding matches the artwork's white background so the seam is invisible (measured colour delta: 2).

### 移动端 / Mobile

- **修复手机端无法新建歌单**：新建入口原来只在侧栏，而侧栏在窄屏下是隐藏的。现在「资料库」顶部有「＋ 新建歌单」按钮，走同一个后端接口（同步创建 B 站收藏夹）。 / Fixed playlist creation on mobile: the entry lived in the sidebar, which is hidden on narrow screens. A “＋ 新建歌单” button now sits at the top of the Library tab.
- **账号页下移**：账号卡片原来贴着状态栏/刘海，现在顶部叠加了安全区高度并增加留白。 / The account page no longer hugs the status bar.

### 安装 / Installers

- macOS: `BiliMusic-1.0.2-mac-arm64.dmg` / `BiliMusic-1.0.2-mac-x64.dmg`
- Windows: `BiliMusic-1.0.2-win-x64.exe`
- Android: `BiliMusic-1.0.2-android.apk` (arm64-v8a / x86_64)
- `SHA256SUMS.txt` for verification

> 数据目录沿用旧版本。 / Data directories are reused.
