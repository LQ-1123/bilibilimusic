## BiliMusic v0.4.0: 合集与体验精修 / collections and polish

Desktop v0.4.0 and Android v0.4.0 refine the desktop shell and fix a stack of interaction bugs reported on the v0.3.0 release.

桌面与 Android v0.4.0 修整桌面壳，并修复一批用户实测问题。

### Shell / 桌面壳

- Removed the window title text and restored window dragging via the native `data-tauri-drag-region` (the old Chromium-only `-webkit-app-region` had no effect in WKWebView). / 去掉窗口标题文字，改用 Tauri 原生拖拽区（旧的 `-webkit-app-region` 在 WKWebView 里无效）。
- Window now closes almost instantly instead of a multi-second wait; the minimum window size is raised so the desktop layout never collapses into the mobile one. / 关窗改为秒退；最小窗口尺寸抬到 1260×410，桌面布局不再塌成手机版。
- Chinese IME input in the search box no longer breaks: the dropdown no longer re-renders mid-composition, and the field is a plain text input (keeps the mobile "search" key). / 搜索框中文输入不再被打断：组合期间不再重渲染下拉，输入框改为文本类型（保留手机「搜索」键）。

### Search / 搜索

- Search results now split into three sections — UP 主 / 合集 / 歌曲 — and multi-part "collections" are detected by probing the top matches. / 搜索结果分三区——UP主 / 合集 / 歌曲，并对命中的多分 P「合集」做预探测。
- A collection behaves like a playlist container: clicking it opens all child works, and each child is collected with a star toggle (hollow → filled) instead of the whole playlist being dumped into your library. / 合集=歌单式容器：点开列全部子作品，子作品用星标逐个收藏（空心→实心），不再把整串一次性塞进曲库。

### Library / 曲库

- Collecting a song now lands it in your default playlist ("我的曲库") and the sidebar counts refresh immediately. / 收藏的歌曲落入默认歌单「我的曲库」，侧栏计数立即刷新。
- The mobile "曲库" tab became "资料库": it lists every playlist and the collections, each opening its own track list / container page. / 手机「曲库」Tab 改名「资料库」，列出所有歌单与合集，点开各自曲目/容器页。
- Removed the per-row "专辑" badge that collided with the row actions. / 移除每行与操作按钮打架的「专辑」角标。

### Player / 播放器

- The Android notification / lock-screen media card shows the full song title, artist and artwork, and taps back into the app. / Android 通知栏/锁屏媒体卡片显示完整歌名、歌手与封面，点按可回到应用。
- Desktop player-bar favorite is now the same size as the neighbouring transport buttons; the mobile full-screen player has a favorite star next to the title. / 桌面播放条收藏钮与右侧按钮等大；手机全屏播放页歌名旁有收藏星。

### Navigation / 导航

- Fixes around search-detail back navigation, the UP page dock disappearing and oversized search covers on mobile. / 修复搜索详情页返回、UP 主页底部导航栏消失、手机搜索封面过大。

### Installers / 安装包

Same distribution channels as v0.3.0 — dmgs / android apks via the GitHub release workflow. / 分发渠道同 v0.3.0——通过 GitHub release 工作流产出 dmg 与 apk。
