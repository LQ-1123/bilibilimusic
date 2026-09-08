# BiliMusic 体验问题台账与修复方案

> 维护日期：2026-09-09（新增 §I 用户实测批 #23–#35） ｜ 定位：对标 YouTube Music 的「最好用的 B 站音乐播放器」（移动优先）
> 用途：本文件由会话讨论沉淀而来，供开发者逐条自修。每条含：现象 → 根因（代码定位）→ 建议修法 → 涉及文件 → 验证方式。
> 状态图例：`[待修] [修中] [已修] [搁置]`；§I 另用 `[已修·工作区]`（未提交改动已覆盖）/`[部分修·工作区]`/`[待确认]` 区分。
> ⚠️ **版本号（2026-09-09）**：本轮所有改动已提交并定版 **v0.4.0**（桌面 `package.json`/`Cargo.toml`/`tauri.conf.json`、Android `versionCode 5`/`versionName 0.4.0`、release 脚本产物名同步）。B6 批 + #37 合集交互全部包含在 v0.4.0。静态资源缓存号：`style.css?v=160` / `app.js?v=63` / `v3.js?v=63` / `back-stack.js?v=4`。

---

## 0. 架构快照（修前必读）

- **后端**：FastAPI 单进程（`app/`），SQLite+SQLModel，Jinja2 服务端渲染 + htmx 局部刷新，无前端构建。静态资源 `app/web/static/`（app.js / v3.js / style.css / sw.js）。
- **播放**：HTML5 `<audio id="audio">` + `<audio id="audio2">`（Smart Transition 双缓冲）、试听流 `recAudio`（动态创建）；全部走 `/api/stream/{bvid}` 本地代理。
- **Android 壳**（`android/`）：单 Activity + WebView + Chaquopy 内嵌 Python；无前台服务/无媒体会话/无音频焦点；minSdk 26 / targetSdk 35（Android 15 强制 edge-to-edge）。
- **桌面壳**（`desktop/`）：Tauri 2，`main.rs` 用 `WebviewWindowBuilder` 动态建窗（无 decorations 设置、无 capabilities 文件、无托盘/快捷键/媒体键）。
- **PWA**：manifest + service worker（仅缓存静态资源），`viewport-fit=cover` 已声明。

---

## A. 系统壳与导航（先做，影响整体质感）

### #1 返回手势直接退桌面 ｜ `[已修·Web层]` ｜ P0
- **现象**：Android 上按返回（手势/物理键）直接退出 App；期望先关掉应用内打开的面板/详情页。
- **根因**：`MainActivity.onBackPressed()` 只判断 `web.canGoBack()`，而全站**零 `history.pushState`**，SPA 状态只存在于 `#app.dataset.view` / CSS class / 各面板 hidden——`canGoBack()` 恒 false。
- **修法**：新增统一「UI 层注册栈」（建议 `app/web/static/back-stack.js`，在 v3.js 之后加载）：
  1. 可被返回关闭的层注册 `{id, open(), close(), restore?}`：登录弹窗、mini-modal、搜索面板、歌词页（半屏→全屏两段）、UP 面板、队列抽屉、详情页、播放页展开态；
  2. `open()` 统一 `history.pushState({bm:"layer", id}, "")`；全局 `popstate` → 按 LIFO 调 `close()`；
  3. 与现有 closers 收编同一份：`collapseOverlays()`、`__hidePanel()`、各 ✕ 按钮回调——UI 按钮与系统返回必须走同一条路径，状态不分叉；
  4. 弹窗永远栈顶；底部 Tab 切换**不压栈**且清空已压栈（`history.replaceState` 回根）；
  5. 记录打开前主滚动位置，关闭时恢复。
- **落地（2026-09-08）**：back-stack.js v3 已实现——MutationObserver 统一对账各层 DOM 状态（UI 关→`history.back()`；popstate 关→silent 不回退），`open[]` 记账只归 sync 所有，关闭动画期（hidden 延迟 300~420ms）不重复压栈；init 时把刷新残留的 layer 状态归一化回根。清单第 5 点（滚动位置恢复）未做。
- **壳层修正（2026-09-08 模拟器实测发现）**：原假设「pushState 后 canGoBack() 自动为真」**不成立**——Chromium WebView 把 pushState 的同文档历史条目标记为 skippable，`canGoBack()` 返回 false、`goBack()` 会跳过它们（实测 entries=2 但 canGoBack=false，返回键直接退 App）。修正：back-stack.js 暴露 `__backStackDepth()`，壳 `onBackPressed` 先 `evaluateJavascript` 问页面——depth>0 走 `history.back()` 关层，=0 才走默认退出。
- **收益**：Android 返回、桌面浏览器后退键、iOS 侧滑返回三端同语义。
- **验证**：浏览器全过（UI 开关历史零漂移 / popstate 关层 / 队列→歌词 LIFO）；**Android 15 模拟器（BM35 AVD，三键导航）全过**：返回键关歌词层不退 App、队列+歌词双层严格 LIFO、根态返回=退出；桌面 Chrome 后退键待人工复点；实体真机待抽查。

### #2 状态栏/导航栏「白色矩形」盖住系统栏 ｜ `[已修]` ｜ P0
- **方案 A 快修（2026-09-08，随 #9 启动页）**：Manifest 主题从 `Theme.Material.Light.NoActionBar` 换为自定义 `Theme.BiliMusic`（深色）→ 白矩形消失。
- **方案 B 正解（2026-09-08 当天落地）**：
  1. `setupEdgeToEdge()`：API 30+ `setDecorFitsSystemWindows(false)`，API 26–29 走 `SYSTEM_UI_FLAG_LAYOUT_*`；删除旧的 insets 垫底监听；
  2. insets 监听把 systemBars 值实时 `evaluateJavascript` 注入页面根元素 CSS 变量 `--inset-top/bottom/left/right`（存字段，onPageFinished 页面导航后补推一次）；
  3. `themes.xml` 状态栏/导航栏改透明；style v151 全部固定/交互元素 inset 化：.topbar、.dt-top、#m-dock、#player-bar、#queue-panel、.search-drop、.topbar.searching、.l-left、.l-bottom、#btn-lyrics-close、#up-close、.ly-volhost（`var(--inset-*, env(safe-area-inset-*))` 双回退，iOS PWA 走 env，桌面为 0）；
  4. 原生桥 `BiliMusicNative.setTheme()`（@JavascriptInterface，runOnUiThread 应用 APPEARANCE_LIGHT_STATUS/NAVIGATION_BARS，API<30 用 SYSTEM_UI_FLAG_LIGHT_*），v3.js setTheme 每次切换调用。
- **验证**：Android 15 模拟器实测全过——深色主题浅色图标、浅色主题深色图标（截图）；滚动内容滑入透明系统栏之下、Dock/播放条/顶栏正确内缩；insets 注入值 top=63px/bottom=126px；横屏刘海与实体真机留抽查。

- **单位修正（2026-09-08 用户实测复现）**：注入的 insets 是物理像素、CSS 变量按 CSS px 消费（density 2.625），底部多垫 ~2.6 倍 → Tab 胶囊离系统导航栏过远。修复：pushInsets 除以 `displayMetrics.density` 后注入（实测 top 24 / bottom 48 CSS px，Dock 紧贴导航栏上方，截图确认）。
- **现象**：打开应用后顶部状态栏区域发白、看不到状态栏内容；底部导航栏一条白边框，非沉浸。
- **根因**（截图+代码确认）：
  - `AndroidManifest` 用系统浅色主题 `@android:style/Theme.Material.Light.NoActionBar` → 窗口背景白；
  - `MainActivity` 用 `setOnApplyWindowInsetsListener` 把整页 padding 下推，深色 WebView 内容永远不画到系统栏之下 → 系统栏区域露出窗口的白；
  - 全工程无 `statusBarColor` / `systemUiVisibility` 控制，页面深浅主题切换（`v3.js setTheme` 只改 meta theme-color，WebView 不认）原生层无感知；
  - Android 15（targetSdk 35）强制 edge-to-edge，旧写法在新旧系统行为不一致。
- **修法**：两级方案。
  - **A 快修（半小时止血）**：换深色主题 `Theme.Material.NoActionBar`（或自定义 dark windowBackground）→ 白矩形消失。`AndroidManifest` theme 一行 + 确认 `res/values` 存在。
  - **B 正解（edge-to-edge，1~2 天）**：
    1. 新增 `android/app/src/main/res/values/{styles,colors}.xml`：`Theme.BiliMusic`（深色 `windowBackground=#0b0b10`、状态/导航栏透明、图标浅色），Manifest 引用；
    2. `MainActivity`：删整页 padding 监听；API 30+ `window.setDecorFitsSystemWindows(false)` + `WindowInsetsController.setSystemBarsAppearance(...)`；API 26–29 用 `SYSTEM_UI_FLAG_LAYOUT_*` 分支；把 insets 经 `evaluateJavascript` 注入页面 CSS 变量 `--inset-top/bottom/left/right`（px）；
    3. `style.css`：现有唯一 `env(safe-area-inset-bottom)` 处（.l-bottom）升级为 `var(--inset-bottom, env(...))` 双回退；按清单适配移动端顶栏/底 Tab/播放条/歌词面板/弹层（滚动内容可滑到透明栏下，交互控件内缩）；
    4. 主题跟随：加极简原生桥 `@JavascriptInterface setTheme("dark"|"light")`（本地可信内容、接口最小），`v3.js setTheme()` 调用之 → 原生切换图标明暗（30+ 用 setSystemBarsAppearance；旧版 LIGHT_STATUS_BAR 位）。此桥是未来原生播放内核 JS Bridge 的雏形。
- **验证矩阵**：Android 15 手势导航（深/浅主题）、14/13 手势与三键、横屏刘海左右、键盘弹起、启动页→界面衔接。

### #17 移动端「曲库」Tab 到不了、回主页丢推荐歌单 ｜ `[已修]` ｜ P0
- **现象**：主页点进推荐歌单（详情态）后，点底部「曲库」无反应；再点「主页」，主页不再显示推荐歌单。
- **根因**：三套状态各自为政——`body[data-mtab]`（mTab 只改标记）、`#app[data-view]`（home/recommend/up/detail 容器显隐，CSS 717–721）、detail 是覆盖全屏第五态。`mTab('library')` 不清 detail、不还原内容；`goHome()` 还原 view 但不重拉被 htmx 依赖的区段（genre-shelves / rec-playlists 等），于是「内容消失」。
- **落地（2026-09-08）**：v3.js 新增 `closeDetail()` + `rehydrateHome()`（幂等：仅容器空时 `htmx.ajax` 重拉 recpl-rack / recent-rack / genre-shelves）；`mTab()` 统一出口 = 清返回栈 + `closeDetail()` + `rehydrateHome()`；`goHome()` 同样兜底重拉（保持无条件回 home 语义，搜索页 ✕ 依赖它）。
- **补充（2026-09-08 用户实测）**：手机端 Tab 的旧 CSS 映射（`body[data-mtab="home"]` 隐藏推荐歌单/最近收藏）导致「主页→曲库→主页后推荐歌单消失」，与验收标准「主页完整显示、与首次进入一致」矛盾——已删除该隐藏规则（style v150），现在主页始终完整，曲库 Tab 仅隐藏发现区（hero/流派货架）。
- **验证**：浏览器（手机视口）全过：详情→曲库正确退出详情、主页推荐区/最近收藏/流派货架完整；真机路径 主页→推荐歌单→曲库→主页→推荐歌单 待截图对比。

### #20 macOS 顶部白色系统标题栏 ｜ `[已修·Overlay 原生方案]` ｜ P1
- **现象**：桌面端顶部一条白系统标题栏 + 原生红黄绿；用户最终要求：仿苹果原生（圆角窗口 + 左上角红绿灯）。
- **迭代过程（2026-09-08，三版收敛）**：
  1. **自绘方案**：`decorations(false)` + capabilities（`core:default` + minimize/toggleMaximize/close/start-dragging + **remote urls `http://127.0.0.1:*`**——页面落在后端 http origin，无 remote 授权 `__TAURI__` 不注入，即原预警 spike 点，已验证可行）+ 顶栏/侧栏自绘三键与拖拽。可用但按钮是网页模拟的。
  2. **透明圆角方案（弃用）**：`transparent(true)` + Cargo `macos-private-api` 特性 + conf `app.macOSPrivateApi: true` + `html.tauri .app` 12px CSS 圆角。**用户实测否决**：WKWebView 透明区域渲染成黑色（右侧黑边）、侧栏玻璃 backdrop-filter 在透明窗上成黑块（左侧方角）——WKWebView 透明窗口的固有缺陷。
  3. **Overlay 原生方案（定稿 ✅）**：`title_bar_style(TitleBarStyle::Overlay)` 替代 decorations+transparent——**窗口圆角与红绿灯全部由 macOS 系统绘制**（原生圆角/投影/真·交通灯），内容延伸到标题栏下；侧栏顶部让位 40px（CSS `html.tauri .sidebar`）且该区可拖动；顶栏空白拖动/双击最大化（v3.js v59）；自绘三键与 macos-private-api 全部移除（构建更干净）。
- **验证**：cargo build ✅；截图确认系统级红黄绿三钮在左上、原生窗框圆角；拖拽/双击/三键手感待用户确认。
- **构建注意**：后端二进制用 `python packaging/build-backend.py`（PyInstaller）生成到 `desktop/backend/bilimusic-backend/`（不入库，debug 构建直接引用）。**改动 Web 模板/静态资源后必须重跑该脚本再启动桌面端**，否则 bundle 里是旧资源（本日多次踩到）。

---

## B. 原生音乐能力（P1，方向性）

### #3 后台播放不稳、无系统媒体条/锁屏控制 ｜ `[修中·一段+升级已落地]` ｜ P1（分水岭）
- **本轮推进（2026-09-08）**：Android Manifest 已加入媒体前台服务、通知权限与 `mediaPlayback` service；新增 `MediaPlaybackService` 通知渠道/持久在线通知，WebView 起播经 `BiliMusicNative.playbackStarted()` 启动服务。尚未接入原生音频引擎、媒体按钮和进度同步。Android Gradle 编译受本机 wrapper 锁文件权限阻塞；Python 回归 114 通过、2 跳过，前端脚本语法检查通过。
- **现象**：切后台/锁屏后播放不稳定；通知栏没有媒体卡片；锁屏不可控；蓝牙耳机/线控无效。根因：Android 是裸 WebView——WebView **不支持** `navigator.mediaSession`，前端 mediaSession 代码（app.js:253 起）只在桌面浏览器生效。
- **第一段落地（2026-09-08）**：`MediaPlaybackService`（foreground，mediaPlayback 类型）+ 播放通知（标题/艺人/ongoing）；页面桥 `BiliMusicNative.playbackStarted/stopped` 起停服务；Manifest 声明服务与 FOREGROUND_SERVICE_MEDIA_PLAYBACK/POST_NOTIFICATIONS 权限；androidx.core 依赖已加。已升级为**系统媒体卡片**并实测 ✅：MediaSessionCompat + MediaStyle（封面大图、播放/暂停大钮、上一首/下一首、进度状态）；按钮与锁屏/耳机线控经 Session 回调 → evaluateJavascript 回控 WebView 播放器（暂停/切歌实测生效，图标随 `playbackPaused` 桥同步）；运行时申请 POST_NOTIFICATIONS。封面缓存 + 进度经 `playbackProgress` 桥（1s 节流）上报。Media3 迁移可后续再做（现 androidx.media 方案已满足锁屏/通知/线控）。**修法**（路线 B 渐进，四段式，总估 4–8 周）：
  1. **前台服务**：`MediaPlaybackService`（foreground，Android 14+ 声明 `android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK`；13+ 运行时申请 `POST_NOTIFICATIONS`）；MediaStyle 通知带封面/进度/收藏按钮；点击通知回对应页（需 #1 寻址）；
  2. **Media3 Session**：播放引擎迁原生，直接拉本地后端流（`/api/stream` 已支持 Range；务必先修 cid bug，见 §F0）；锁屏/蓝牙 AVRCP/线控/音频焦点全由 Session 提供；
  3. **JS Bridge**：接口先行设计（播放/暂停/切歌/进度/音量/封面歌词元数据双向同步），Web UI 保留现状，播放命令改走桥；
  4. **Smart Transition 策略**：v1 原生单轨 + 前端给过渡计划，或原生双 ExoPlayer crossfade；TrackAnalysis 数据在 SQLite，完整复刻后置。
- 配套：#4 音频焦点与耳机拔出（becoming noisy）在此一并实现（来电/他 App 播放→暂停；拔出→暂停）；进程被杀冷启→恢复播放（见 #1 寻址 + 播放状态持久化）。
- **#4 落地（2026-09-08）**：耳机拔出——`MediaPlaybackService` 注册 `ACTION_AUDIO_BECOMING_NOISY` 接收器（起播注册/销毁反注册），收到即 `evalInPage` 直接 `audio.pause()`（pause 事件自动同步 UI 与通知图标），并置 MediaSession 暂停态。音频焦点（来电/他 App 抢占）由 Chromium AudioFocusDelegate 原生处理（WebView 内建），无需自管。
- **#4 验证（2026-09-08，Android 15 模拟器）**：接收器注册 ✓（dumpsys broadcasts 确认 filter 在列）；evalInPage 通路 ✓（通知栏暂停键实测生效，同构代码）；**shell 模拟广播卡 ordered 队列无法投递（模拟器限制）→ 真实拔耳机触发留真机抽查**。
- **验证**：锁屏播放 10 分钟；来电打断/恢复；蓝牙切歌；通知栏操作同步 UI。

### #18 登录验证页唤起失败 → 浏览器登录兜底 ｜ `[已修]` ｜ P1
- **现象**：手机端短信登录的极验滑块（gt.js 动态注入 `static.geetest.com`）在 WebView 内不出现/失败；扫码需第二台设备。
- **根因**：验证链路强依赖外域 JS + WebView 环境（UA/无痕态）易被 B 站风控；扫码在单手机上闭环不了。
- **修法**（贴合现有架构的兜底）：
  1. 登录弹窗加「验证页打不开？在系统浏览器完成登录」按钮；
  2. Android：桥方法 `openExternalLogin()` → `ACTION_VIEW` 打开 `origin + "/?login=1"`（后端内嵌本机，系统浏览器访问 127.0.0.1 即同一后端，Chrome 中滑块全功能可用）；
  3. 登录成功（CookieStore 落盘 + 账号激活）后回 App 点「我已完成」→ `fetch("/api/auth/...")` 探测 → `location.reload()`；
  4. 桌面同理（同机浏览器），实现一个按钮即两端受益；
  5. 长线备选：已登录设备一次性迁移码（有风控风险，需实测）；cookie 粘贴导入。
- **落地（2026-09-08，其中 1/2/3 完成）**：登录弹窗 SMS 栏底部新增「验证页打不开？在系统浏览器完成登录」文字钮——Android 经原生桥 `BiliMusicNative.openExternalLogin()`（ACTION_VIEW 打开 origin+/?login=1），桌面/浏览器回退 window.open；点击后按钮变「我已完成登录，刷新 App」，再点探测 `/api/auth/status`：已登录 → 整页刷新进入，未登录 → toast 提示，B 站不可达 → 「暂时连不上 B 站，稍后再试」。同后端同 CookieStore，浏览器登录直接互通（无需迁移码）。
- **验证**：Android 15 模拟器实测 ✅——按钮出现 → 点击拉起系统浏览器（topResumedActivity 切到 browser）→ 返回 App 再点 → 探测到已登录 → 页面刷新（闭环全通）。短信+滑块在真机浏览器里的完整登录留真机；扫码回归不涉及。

---

## C. 播放与控件

### #8 桌面按空格暂停/播放 ｜ `[已修]` ｜ P0 快赢
- 现状：全站无全局 Space 处理（仅有 Esc 关浮层先例 v3.js:1028）。
- **落地（2026-09-08）**：v3.js keydown capture：target 为 input/textarea/select/contenteditable 或 `isComposing` 时忽略；登录/mini 弹窗打开时不接管；否则 `preventDefault()`（防滚动+防聚焦按钮误触）并 `BiliPlayer.toggle()`（含试听态）。
- 涉及：`app/web/static/v3.js`。验证：浏览器合成键全过（body 空格暂停/恢复、输入框空格不触发且不误暂停、聚焦「上一首」时空格只切换播放不切歌）；真机手感待人工复点。

### #15 移动端「上一首/下一首」位置反了 ｜ `[已修]` ｜ P0 快赢
- **根因**：`style.css:885` 移动媒体查询 `#player-bar .p-ctl{... flex-direction:row-reverse}` 把 DOM 序 [上一首][播放][下一首] 渲染成 [下一首][播放][上一首]。
- **落地（2026-09-08）**：已删除该 `row-reverse`（grid-area 与按钮尺寸规则保留）。
- 验证：手机视口 390px 实测 flex-direction=row，左→右=上一首/播放/下一首 ✅；真机目测与歌词页 `.ly-ctl` 顺序待截图确认（歌词页 DOM 序本就正确）。

### #19 音量控件「空」——粉色填充缺失 ｜ `[已修]` ｜ P0 快赢
- **根因**：全 CSS **无任何 `var(--p)` 消费者**（`grep "var(--p" style.css` 零命中）；JS 注释声称 `--p 驱动填充`（v3.js:787）但从未 `setProperty('--p')`；滑条 thumb 全部 width:0（无圆点胶囊设计）→ 音量条只剩灰底细线。进度条 #seek 同源，粉色大概率同样缺失。
- **落地（2026-09-08）**：CSS 四条滑条（#seek/#ly-seek/#vol/#ly-vol）track 改 `linear-gradient(90deg, var(--pink) var(--p), <track色> var(--p))`，Firefox 走 `::-moz-range-progress`；JS 侧 app.js `syncSeekFill()`（timeupdate/拖动/切歌重置/试听接管）+ v3.js 音量与 ly-seek 的初始化与 input/change 全量同步。注：歌词页 `--pink` 被面板 token 映射为白色（沉浸式设计），填充为白色可辨。
- 验证：浏览器实测 ✅（播放中进度填充随时间增长、音量 40% 自下而上 40%、歌词页进度/音量填充可见）；真机待复点。

### #12 长歌名省略号 ｜ `[已修·保持现状]` ｜ P1 快赢
- 现状：#player-title/#player-artist 及部分卡片已有 ellipsis（flex + min-width:0 正确写法）；**未截断的具体位置待用户截图指认**（列表行/迷你卡/歌词页头）。
- **落地（2026-09-08）**：全部曲目行/卡片文本元素补齐 `title` 全文悬停（songs/rec_genre_tracks/daily_columns/rec_cards/recent_rack/search_detail 模板 + 队列 li + 播放条/歌词页标题由 JS 写 title）。省略号 CSS 各处本已齐备，未发现溢出容器的新增点位；用户后续截图指认到具体位置再定点补。
- 验证：浏览器实测行 title ✅；超长歌名各视图单行省略不溢出待长名素材入库后目检。

### #13 超长歌名「窗口内滚动播放」 ｜ `[已修]` ｜ P1
- **定位**：列表/队列保持 #12 省略号；仅「正在播放」标题（#player-title、未来全屏 Now Playing 大字）做走马灯。
- **落地（2026-09-08）**：新增 `ticker.js` v2（按元素各管实例，播放条与歌词页标题互不干扰）：溢出才启用、transform-only rAF 动画（30px/s，两端停 750ms 回卷）、悬停/按住暂停、切歌重置、resize 重测、`prefers-reduced-motion` 退化省略号；激活时加 `.ticker-on` 关省略号。app.js 的 updateNowPlaying / setLyricsText / syncTrialUI 三处接入。
- **模拟器实测抓到的 bug**：Map 重构时把 rAF 自续帧弄丢——动画只走一帧就停（transform 永远 0）。v2 已修（`frame` 末尾 `running.size` 非空则续帧，空则归零 last）。
- **用户实测抓到的第二个 bug（v3）**：transform 平移的是整个标题元素，而裁切就发生在该元素上——盒子整体左移把文字甩出容器压到播放条按钮上（手机端小屏最明显）。v3 改为 **scrollLeft 滚动内容**：盒子不动、内容在裁切容器内滚，从根上消除出界。
- 验证：Android 15 模拟器实测 ✅（scrollLeft 随时间推进、标题 bounding box 始终在播放条内、超长标题激活、短标题静止、切歌复位）；真机观感待抽查。

### #16 点击歌词出现蓝色方框 ｜ `[已修]` ｜ P1（待截图确认形态）
- 现状：歌词行为 `<p class="l-line">`（app.js 渲染），样式无 focus/outline/selection 规则；最可能是**双击/长按触发文本选中**（蓝底+把手），或 tap 高亮。
- **落地（2026-09-08）**：全局 `html{-webkit-tap-highlight-color:transparent}`；`.l-line{-webkit-user-select:none;user-select:none}`（点击行=seek 语义，不需要选词）；行激活反馈沿用 `.on`。未加 `::selection` 全局透明（影响范围过大）。
- 验证：浏览器 computed style ✅（tap-highlight=transparent、user-select=none）；真机点击/长按/双击歌词行无蓝框待验。

---

## D. 启动与性能

### #9 启动页品牌化（logo 而非「正在启动」） ｜ `[已修]` ｜ P0 快赢
- **Android（已落地 2026-09-08）**：
  1. 启动视图从黑底白字 TextView 换为**深色底（#0b0b10）+ 居中图标（96dp，22dp 圆角裁切）+ 细字状态行**（"正在启动…"，失败信息也写在这里）——程序化构建，无新布局文件；
  2. 后端就绪后 WebView **200ms 淡入**，去掉硬切；
  3. `res/values/themes.xml` 新增 `Theme.BiliMusic`（深色 windowBackground/statusBar/navigationBar = #0b0b10），Manifest 引用——冷启动首帧即品牌深色底（**同时落掉了 #2 的方案 A：白矩形/白屏闪烁消失**）。
- **桌面（已落地 2026-09-08）**：`desktop/ui/index.html` 换为深色底 + 居中 icon-512（274KB 压缩版）+ 细字状态行 + 品牌色阴影；就绪 title 标记逻辑未动。
- 验证：Android 15 模拟器实测 ✅（启动帧截图：深底居中图标；加载后深色沉浸无白条）；桌面待 `npm run dev` 冷启目检；Android 12+ 系统 splash 背景随 windowBackground 生效。

### #5 后台 2s 轮询不歇 ｜ `[已修]` ｜ P1 快赢
- 根因：`base.html` `#task-list` `hx-trigger="load, every 2s"`（登录后）无可见性感知；WebView/后台标签页照跑。
- **落地（2026-09-08）**：声明式 `every 2s` 移除（只留 load 首拉）；v3.js 改 JS 驱动轮询——`setInterval` 2s 内 `document.hidden` 直接跳过、busy 标志防重入，`visibilitychange` 回前台立即补一次。
- **验证**：桌面浏览器确认声明式轮询移除、前台 2s 节奏正常；**Android 15 模拟器 CDP Network 实测 ✅**——前台每 2s 一次，HOME 切后台 8 秒内 0 次（仅暂停切换沿出现 1 次竞态帧），回前台恢复 2s 节奏；锁屏/长时间后台的极端节流行为留真机抽查。

### #6 移动端列表/图片性能 ｜ `[待修·候选]` ｜ P2（真机 profile 后定）
- 候选：封面原图未缩略（B 站封面按需取小尺寸）、列表 htmx 整段重渲、backdrop-filter 大面使用（液态玻璃 blur 只在固定层保留，滚动内容避免）、图片 `loading=lazy` + `decoding=async`、头像已有懒解析（upFaceCache）。
- 修法在真机 profile（WebView 远程调试 Performance）后按热点逐个做。

### #11 手机端下拉刷新 ｜ `[已修·真机手势待抽查]` ｜ P1
- **本轮落地（2026-09-08）**：`v3.js` 在移动粗指针设备的主页/曲库顶部加入自绘下拉刷新，64px 阈值触发 `refreshSongs`，详情、弹层、按钮和输入控件不抢占手势；添加加载/就绪状态样式。Node 交互回归 17 例通过，真机手势与网络刷新仍待抽查。
- **修法**：前端自绘（不加 androidx 依赖）：
  1. 仅触摸设备 + 移动布局（matchMedia）且主滚动容器 `scrollTop<=0` + 当前为 feed 视图（主页/曲库）时启用；
  2. touch/pointer 手势：下拉超阈值（约 64px）显示品牌色 spinner，松手触发当前视图数据重取（重触发 htmx partial：genre-shelves / rec-playlists / playlists 等，按视图路由）；
  3. 面板/弹窗/输入态/播放详情内不触发；`prefers-reduced-motion` 下减弱动画；
  4. iOS 浏览器场景说明：Safari 自带整页下拉刷新，与 WebView 内自绘不冲突（WebView 无系统 PTR）。
- 验证：Android 真机各视图下拉出现 spinner 且列表更新、滚动位置保留。

---

## E. 内容与数据

### #14 合集 → 专辑 ｜ `[已修·一期完成，series 二期待做]` ｜ P1（架构级，分两期）
- **本轮推进（2026-09-08）**：完成基础数据层与查询闭环：新增 `Album` 与 `Song.album_id/track_no`，Song 唯一键迁移为 `(bvid,cid)`（含旧 SQLite bvid 唯一索引/约束重建与数据保留），`get_video_info()` 暴露全部 pages 元数据并使用分 P 时长；新增专辑列表/详情/曲目/物化/删除 API、Web 货架/曲目片段，以及无 `p=` 多分 P 导入时一次创建 Album 和全部 Song。专项测试 9 通过；完整 Python 回归 114 通过、2 跳过。收藏语义、导入懒物化与 series 合集仍待完成。
- **二次推进（2026-09-08 同日，接手补完）**：
  1. **DetachedInstance 修复**：playAlbum 首次导入报「Instance not bound to a Session」——commit 后在会话外访问过期 ORM 属性；改为会话内取标量、会话外统一 `library.get_song()` 重载；
  2. **albumRequest 端点对齐**：前端 `albumRequest(id,false)` 原拉专辑 meta（无 songs 数组），改为 `GET /api/albums/{id}/songs`；后端 GET songs 与 POST materialize 统一返回前端契约 `{songs, hasMore, materializedPages}`；
  3. **Android 15 模拟器全链路实测 ✅**：导入 BV1amxrzXEnk（17P）→ 专辑+17 曲目（各自 cid 的 audioUrl）→ 详情 17 行 → 播 P2 = P2 的 cid 流 → P1/P2 歌词按各自 cid 取 CC（内容不同）→ 删除专辑 API + 重导入复测通过；
  4. **单曲移除不伤收藏 ✅**：`DELETE /api/albums/{id}/songs/{sid}`（仅本地删除）+ 前端 data-del 分支路由（其余分 P 共用该视频收藏，不受影响）；
  5. **删专辑的 B 站侧取消收藏 ✅**：delete_album 改 async，按专辑内 (aid, fav_folder_id) 去重后逐视频取消收藏（尽力而为不阻塞本地删除）；
  6. **懒物化 ✅**：>300P 超大合集导入时只建起始分 P（materialized_pages=1），其余由 playAlbum 的 hasMore 循环经 POST materialize 按需补建（materialize 改为真正补建曲目行并返回 `{songs, hasMore, materializedPages}` 契约）；
  7. **分 P 标题清洗 ✅**：`part_display_title` 去「01.」「第3集」等序号噪声，分 P 名已含主标题信息时不重复拼接；
  8. **待补**：series 二期（跨视频合集）。
用户已拍板：范围=**多分P视频 + B 站跨视频合集都要**；同步=**保持 B 站收藏夹哲学**（收藏夹=整视频一次；本地=专辑+曲目；换设备专辑先恢复单行、曲目按需回填）。
- 现状盘点（已查证）：`link_parser` 支持 `?p=n`；`get_video_info`/`get_audio_streams(bvid,cid)`/`get_subtitle_tracks(bvid,aid,cid)` 全按 cid 工作；importer 单 P 导入正确（存 `Song.cid`，标题拼「主标题 · 分P标题」）；缺 Album 实体与多 P 共存（Song.bvid 唯一）。
- **第一期（paged，最短链路）**：
  1. 数据：`Album(id, kind="paged", source_bvid, title, artist, cover_url, total_pages, created_at)`；Song 增 `album_id/track_no`，唯一约束 bvid → (bvid, cid)（注意迁移与旧索引）；导入多 P 链接时一次拉 pages 元数据（cid/标题/时长），全量建行（几百行很轻），超大合集（建议 >300P）懒物化保护；
  2. 流路由：**先修 cid bug（见 §F0）**；audioUrl 带 `?cid=`；
  3. 歌词：各 P 按自己 cid 取 CC/AI 字幕，LRCLIB 用**分P标题**匹配（更干净、匹配率更高）；
  4. UI：曲库「专辑」区块（卡=封面/标题/艺人/曲数）→ 专辑页曲目列表（编号/曲名/时长）→ 整张播放（顺序队列）、单曲加歌单；收藏/删除为专辑级（见语义表）；
  5. 分P标题清洗（去「01 ·」序号噪声）。
- **第二期（series）**：link_parser 识别 `space.bilibili.com/{mid}/channel/collectiondetail?sid=` 与分享文本 → Album(kind="series", source_sid) + 逐页拉视频列表建曲目；删除=批量取消收藏（后台自愈）；恢复：sid 公开→重建并与收藏夹合并；sid 失效→退化为散曲不丢歌。
- **语义矩阵（两期共用）**：

| 环节 | paged | series |
|---|---|---|
| 收藏同步 | 整视频收藏一次 | 每曲各收藏一次 |
| 删除 | 删专辑=取消收藏该视频；单曲移除=本地隐藏（不伤收藏） | 删专辑=批量取消收藏；单曲删除=取消该视频收藏 |
| 换设备恢复 | 收藏夹单行→专辑行→曲目按需回填 | sid 重建+与收藏合并；sid 失效退化散曲 |

- 风险：合集含非音乐内容（自决）；接口频控（拉 pages/列表限速）；超大合集懒加载；标题噪声清洗词表迭代。

### #10 歌词源增强（替代 Shazam 思路） ｜ `[已修·网易云源落地]` ｜ P1
- **落地（2026-09-08）**：
  1. 网易云源：`_from_netease`（非官方接口 search/lyric，进程级限频 1.5s + 失败冷却 60s + 静默降级），插入优先级 CC → LRCLIB带轴 → **网易云(ncm，仅收带轴、时长容差±3s)** → AI → LRCLIB纯文本；
  2. 放开手动重取：`GET /api/songs/{id}/lyrics?force=1` + 歌词页「↻ 重试」按钮（backend ensure_for_song(force)）；
  3. 来源角标：歌词页 `来源 · B站字幕/LRCLIB/网易云/...`（前端 ncm 映射已加）。
- **验证**：单元测试 3 例（命中 ncm / 时长容差过滤 / 故障静默降级）；真实 API 实测 ✅「晴天 周杰伦」→ ncm 带轴歌词。QQ音乐备选与冷门歌真机抽查留后续。
- **本轮部分修复（2026-09-08）**：发现 `fetch_for_song()` 命中 LRCLIB 纯文本后直接返回，跳过 AI 时间轴字幕，与既定优先级不符。已改为 CC → LRCLIB 带轴 → AI → LRCLIB 纯文本；LRCLIB 明确纯音乐标记维持直接返回。新增 4 例覆盖 AI 优于纯文本、纯文本兜底、带轴优于 AI、纯音乐标记。完整 Python 回归 111 通过、2 跳过（缺真实音频样本），前端现有 17 例通过。旧歌词缓存不自动重取；本条网易云源、手动重取与来源 UI 待办保持未完成。
- **本轮继续（2026-09-08）**：歌曲歌词页新增重试按钮，调用 `/api/songs/{id}/lyrics?force=1` 清除缓存并重新执行取词链；试听歌词不显示重试入口。`tests/test_lyrics.py` 20 通过，前端脚本语法检查通过。网易云源、来源角标和错误反馈仍待完成。
- **来源角标（2026-09-08）**：歌词页现在展示 CC / AI / LRCLIB / 网易云来源（后端已有来源值时），切歌或重试会清空并重新更新角标。歌词专项 20 通过，Node 前端回归 17 通过。
- **判断**：不需要音频识别——每曲 bvid/标题/歌手/时长已知，识别引擎解决「未知音频」，且 Shazam/ACRCloud 曲库=主流商用音乐，对 B 站系内容覆盖不比现链路高（还有 SDK/费用/条款成本）。
- 现状：`app/services/lyrics.py` 链 = B站人工 CC → LRCLIB → B站 AI 字幕 → LRCLIB 纯文本。短板=中文主流曲目与无人字幕搬运视频。
- **修法**：
  1. 进取词链新源：**网易云音乐歌词**（中文覆盖最好；非官方接口需限频+失败静默+来源标注；`lyrics_source` 可加值如 `ncm`）；QQ 音乐作备选调研；
  2. 放开手动重取：现 `lyrics_checked` 置 1 后不再打外部接口 → 歌词页加「重试 / 换源」按钮走 `?force=1`；
  3. UI：歌词页来源角标（cc / ai / lrclib / ncm）+ 歌词错误反馈入口（数据沉淀）。
- 合规：非官方接口稳定性与 ToS 风险，功能默认静默降级。

### #7 左侧「＋」新建歌单失败 ｜ `[已修]` ｜ P0
- 链路：`base.html:80` ＋ → `app.js createPlaylist()` → POST `/web/playlists/create` → `playlists.create()`（同名/空名检查、B 站建夹、入库）——服务端本身健壮。
- **根因确认 + 落地（2026-09-08）**（按概率全部修掉）：
  1. **`__promptModal` 缺失时静默失败** → app.js 顶部内置最小兜底 `__promptModal/__confirmModal`（v3.js 正常时被其带样式版本覆盖，v3.js 失效时兜住）；
  2. **未登录 fetch 不带 htmx 头 → 307 重定向吞掉（实测确认的第二根因：fetch 跟随拿到 HTML 却 ok=true，歌单实际没建）** → `webFormPost()` 统一带 `HX-Request: true`，服务端回 401 JSON → `formFailed()` 弹登录窗；
  3. **fetch 网络异常无 catch** → `webFormPost()` 捕获异常 → toast「网络错误」；
  4. `MainActivity` WebChromeClient 补 `onJsPrompt` + `onJsConfirm`（AlertDialog + EditText）——兜住 rename/delete 等一切 prompt/confirm 路径。
- **验证**：浏览器弹窗路径 ✅；**Android 15 模拟器全链路 ✅**（应用内弹窗出现（未触发原生 prompt）→ 建单成功（服务端建夹）→ 删除走确认弹窗 → B 站夹同步删除，全部经 CDP 实测）；实体真机抽查待做；未登录 401→登录窗路径待验。

---

## F. 独立严重 bug 与视觉细节

### F0 ★ 播放流忽略 Song.cid：导入的 p>1 歌曲播成 P1 音频 ｜ `[已修]` ｜ 最高优先
- 根因：`app/api/routes.py` `stream_bvid()` 只 `get_video_info(VideoRef(bvid))` 取默认分P cid；而 importer 存了正确 `Song.cid` 却无人使用。凡导入 `?p=2..n` 的曲目，点播放听到的都是第一分P。
- **落地（2026-09-08）**：客户端新增 `video_page_cids()`（一次 wbi/view 拿全部分 P cid，接口调用量不变）；路由支持可选 `?cid=`，`_pick_stream_cid()` 校验该 cid 属于该 bvid 否则 **400「cid 与该视频不匹配」**；`song_out` 的 audioUrl 携带 `?cid=<Song.cid>`；试听/搜索现解析路径保持默认 P1（向后兼容）。专辑功能（#14）可在此基础上开工。
- 验证：单元测试 6 例全绿（`tests/test_stream_cid.py`：pages 解析/空 pages 报错/默认 P1/显式 cid 路由/伪造 cid 400/audioUrl 带 cid）；浏览器实测曲库 12/12 首 audioUrl 带 cid、伪造 cid=400、Range 206 流代理正常、播放音频加载成功；与 B 站逐 P 对照试听待有多 P 素材后人工确认。

### #21 歌词页非当前行对比度不足 ｜ `[已修]` ｜ P1（视觉微调待定）
- 现象（mac 截图）：底部「直到现在」几乎融入深褐封面背景。
- 根因：桌面 `.l-line`（style.css:598）`color:var(--txt3); opacity:.55`，叠加暖色封面背投后对比不足；当前行 `.on` 正常。
- **落地（2026-09-08）**：非当前行提亮为 `color:var(--txt2)`（面板内=白 72%）+ `opacity:.75`；新增 hover 行高亮（`color:var(--txt)` / opacity .92）；手机端基础 opacity .38→.52。未再加浓 scrim（避免压暗封面氛围）。
- 验证：浏览器截图 ✅ 暖色封面下非当前行清晰可读、当前行纯白突出；浅色主题与冷色封面待人工各截一张。

### #22 歌词页关闭按钮（左下圆形 ✕）突兀 ｜ `[已修·hover 显现]` ｜ P2
- **落地（2026-09-08，用户拍板 hover 显现方案）**：桌面端（≥901px）歌词页关闭钮平时 `opacity:0`，鼠标移到其位置或键盘聚焦时 0.25s 淡入；移动端触屏无 hover，保持常显（style v153）。
- **验证**：桌面浏览器实测 ✅（默认 opacity 0 → hover 1）；移动端媒体查询隔离 ✅。
- **本轮落地（2026-09-08）**：桌面端关闭按钮移至歌词面板右上角，移动端保留顶栏左侧常显入口以保持单手可达和发现性；现有歌词页重试按钮与关闭入口分离。
- 现象（mac 截图）：左下角半透明圆形 ✕ 在主界面显得孤立。
- **候选修法**（择一，用户定）：移到歌词面板右上角成对布局（与滚动条留白协调）；或 hover 才显现（桌面）/保持常显但换描边弱化样式（移动）；与 #btn-lyrics-close 现有 36px 圆钮一致的前提下调整归属区。
- 验证：桌面+手机歌词页关闭入口可发现性测试。

---

## G. 建议执行批次

| 批次 | 内容 | 状态 |
|---|---|---|
| B0 快赢批 | #8 #15 #19 #12 #13 #16 #7 + F0(cid) | ✅ 2026-09-08 完成（浏览器 + 模拟器验收） |
| B1 壳与导航 | #1(back-stack) #2(方案A+B e2e) #17(路由收口) #9(品牌启动) | ✅ 2026-09-08 完成（真机抽查待做） |
| B1.5 补充 | #18(浏览器登录兜底) #5(轮询) #21(歌词对比度) | ✅ 2026-09-08 完成 |
| B2 原生播放 | #3 一段+升级（前台服务 + MediaSession 媒体卡片）、#4 音频焦点 + 耳机拔出 已落地；二段（Media3 迁移/锁屏深测）待定 | ✅ 一段完成（真机抽查待做） |
| B3 内容 | #14 一期(paged 专辑) ✅ → 二期(series) 待开工；#10 歌词源（网易云源 + 重试换源 + 来源角标）✅ | ✅ 一期完成 |
| B4 桌面/视觉 | #20(Overlay 原生标题栏·已修) #22(关闭钮·已修) #21(已修) #6(性能·待真机profile) | ✅ 大部完成 |
| B5 补充 | #11(下拉刷新) | ✅ 2026-09-08 落地（真机手势待抽查） |
| B6 用户实测批 | #27(IME 空格·P0) #33(取消收藏·P0) #29(通知栏 metadata·P0) #32(搜索返回·P0) #30(UP dock) #24(窗口拖动) #25(退出) #23(标题) #26(最小尺寸) #31(搜索封面) #34(资料库) #35(收藏钮) #28(并入 #29) #36(多P→专辑容器) + #37(搜索合集三分类) | ✅ 2026-09-09 编码完成并作为 **v0.4.0** 提交（Python 120 passed / 前端 24 例通过）；真机抽查待做 |

> 已提交：`3eb2ad0..dc44bc1` 六笔（upic 头像 / F0 cid / 前端体验批 / Android 壳 / 桌面启动页 / 文档）+ `5a26c67` 网易云源与专辑懒物化 + `45b06a6` Overlay 标题栏 + `8a4f02e` insets 单位换算与耳机拔出 + `36ffda5` next-steps 刷新 + `bdf3091`/`85ce4cb`/`1f5ad6b`/`a774f1d`（台账同步 / **v0.3.0 发版** / Windows 构建 cfg 门控 / 发版记录）。`main` 与 `v0.3.0` 已推远端。
> **2026-09-09 用户实测批（§I #23–#35）**：用户对 v0.3.0 双端实测新报 13 条；其中 #29/#30/#32 的工作区未提交改动已覆盖主干，其余待开工。
> #14 一期推进（用户开工 + 会话补完）：专辑数据层/导入/播放/歌词/详情 UI 模拟器全链路 ✅；会话内修复 DetachedInstance、albumRequest 端点对齐、MediaPlaybackService 包名错位。
> 后续计划详见 `docs/next-steps.md`。

## H. 修复进度勾选

- [x] #1 返回语义（Web 层 + Android 壳桥接，模拟器全过）｜ [x] #2 系统栏（方案 A+B 沉浸全落地）｜ [x] #17 路由 ｜ [x] #20 无边框（Overlay 原生方案定稿）
- [x] #3 第一段（前台服务+MediaSession 媒体卡片）｜ [x] #4 音频焦点（Chromium 原生）+ 耳机拔出（真机抽查）｜ [x] #18 浏览器登录兜底（真机浏览器完整登录待抽查）
- [x] #8 空格 ｜ [x] #15 按钮序 ｜ [x] #19 音量填充 ｜ [x] #12 省略（title 全文）｜ [x] #13 滚动 ｜ [x] #16 蓝框 ｜ [x] #7 建歌单
- [x] #9 品牌启动（双端） ｜ [x] #5 轮询 ｜ [ ] #6 性能 ｜ [x] #11 下拉刷新（真机手势待抽查）
- [x] #14 专辑一期完成（series 二期待开工） ｜ [x] #10 歌词源（网易云源 + 重试换源 + 来源角标，实测命中「晴天」）
- [x] #21 歌词对比度 ｜ [x] #22 关闭钮（hover 显现）
- [x] F0 cid 流路由

**§I 用户实测批（2026-09-09，#23–#35）**：`[x]` 已修 / `[~]` 部分修（工作区已覆盖主干，仍有缺口）/ `[ ]` 待修 / `[?]` 待确认

- [x] #23 桌面标题 ｜ [ ] #24 窗口拖动 ｜ [x] #25 退出速度 ｜ [x] #26 最小窗口尺寸（1260×410）｜ [x] #27 IME 空格劫持（P0，待真机验证）
- [x] #29 通知栏 metadata（试听流接入 + 进度换算 + ART/ALBUM 键 + setFlags/setSessionActivity + 封面绝对化 + UA/Referer；javac 编译通过，真机待验）
- [x] #30 UP 详情页 dock 层级（`:has()` + `body.up-open` 双保险）
- [x] #31 搜索详情页封面等比缩小（手机 3 列 + `max-width:120px`）
- [x] #32 搜索详情页返回栈（层注册泛化 + `closeDetailTo` + `#view-search` CSS 收口 + 显式返回钮 + 2 例新测试）
- [x] #33 点已收藏 = 取消收藏（P0，已修：单曲 `DELETE /api/songs`；多分 P 专辑确认后 `DELETE /api/albums`）
- [x] #28 已澄清：＝ 通知栏播放组件在未收藏（试听流）时信息不全，并入 #29 一起修
- [x] #34 手机端「曲库」→「资料库」（独立视图 + 歌单列表 → 歌单曲目 + 来源感知返回）
- [x] #35 手机播放页收藏钮 + 桌面播放条按钮对齐（并入 `.p-acts` + SVG sprite）
- [x] #36 多P → 专辑容器（曲库行「专辑」入口 + 专辑内 `＋` 收藏到歌单）
- [x] #24 窗口拖动（`data-tauri-drag-region="deep"` + `.tb-drag`）

> 批次记录：**B0 快赢批 + B1 壳与导航 + B1.5 + B2 一段/升级 + B3 一期 + B4 视觉 均已完成编码与模拟器/桌面验收**（详见 acceptance-manual §9）；**B6 用户实测批（§I #23–#36）已全部编码完成并本地打包**（Python 120 passed / 2 skipped、前端 24 例通过；`BiliMusic.app` 冒烟通过：壳 + 后端 + 新资源均验证；APK 由真实 Gradle 编译产出）；剩余：实体真机抽查（#27 IME、#29 通知栏、#34 资料库手势、#35 手机星标）、#6 性能 profile、#14 series 二期、#3 深段（Media3）。

---

## I. 2026-09-09 用户实测新报（#23–#36）

> 来源：用户对 **v0.3.0** 的双端实测（5 张截图）。分层：I.1 桌面端 / I.2 手机端 / I.3 收藏语义 / I.4 界面改进。
> 条目编号与用户原文顺序对应；每条含 现象 → 根因（文件:行号）→ 修法 → 涉及文件 → 验证方式。

### I.1 桌面端（Tauri 壳）

#### #23 窗口顶部「BiliMusic」标题难看，砍掉 ｜ `[已修]` ｜ P2 快赢
- **落地（2026-09-09）**：`main.rs` 窗口 `.title("")`；错误态 `set_title("启动失败")`。`cargo check` ✅。
- **现象**：桌面窗口顶部正中一条 "BiliMusic" 文字，与下方搜索栏叠在一起（截图 1）。
- **根因**：macOS `TitleBarStyle::Overlay` 只做 `titlebarAppearsTransparent(true)` + `FullSizeContentView`（`tauri-runtime-wry-2.11.4/src/lib.rs:1211-1213`），**不隐藏标题文字**（tao-0.35.3 `macos/window.rs:266-268` 只设 transparent，`titleVisibility` 未动）→ 文字照画。Tauri v2 未暴露 `title_hidden`（grep 无结果），也**没有** document.title → 窗口标题自动同步（`on_document_title_changed` 只是回调）。因此文字的唯一来源是 `desktop/src-tauri/src/main.rs:169` 的 `.title("BiliMusic")`；`base.html:6` 的 `<title>` 只影响浏览器/Windows WebView2，不影响 macOS 窗口标题。
- **修法**：`main.rs:169` → `.title("")`（空串=标题栏不画字；Dock/Mission Control 仍用 bundle 名，来自 `tauri.conf.json:3` 的 `productName`）；`main.rs:51` → `set_title("启动失败")`（仅错误态）；`desktop/ui/index.html:2` → 空。可选：`base.html:6` → `<title>B站音乐收藏</title>`；`library.html:120` 页脚可见品牌字「BiliMusic ·」；`manifest.json:2-3` 只影响 PWA 安装名。**不要动** `tauri.conf.json:3` 的 `productName`（改了连带改 .app/Dock/菜单栏名）。
- **涉及**：`desktop/src-tauri/src/main.rs`、`desktop/ui/index.html`（可选 `app/web/templates/base.html`、`library.html`、`manifest.json`）。
- **验证**：`cargo tauri dev` 后窗口顶部无文字；错误态只剩「启动失败」；红绿灯/拖动/双击最大化不受影响。
- **顺带发现**：窗口标题（`main.rs:169`）与页面标题（`base.html:6`）不一致且无同步；若 Windows 端在意窗口标题，需在 `on_document_title_changed` 里补 `window.set_title(&title)`。前端无其它 `document.title` 写入（仅 htmx 历史恢复会按响应 `<title>` 改，不触发窗口标题）。

#### #24 点击应用上沿无法拖动窗口 ｜ `[已修]` ｜ P1
- **落地（2026-09-09）**：`base.html` 的 `#topbar` 加 `data-tauri-drag-region="deep"`，侧栏首位新增 `.tb-drag`（同样带 `deep`）；`style.css` 把原来的 `.sidebar::before` + 无效的 `-webkit-app-region` 换成实元素 `html.tauri .tb-drag{position:absolute;top:0;left:0;right:0;height:40px;z-index:1}`；`v3.js` 删掉自写 pointerdown/dblclick（保留给 macOS 加 `html.tauri` 的那段）。前端 24 例回归 ✅。
- **待验**：真机拖顶栏与侧栏顶部 40px；窗口失焦后首次单击需再拖一次（tauri#11605，系统限制）。
- **现象**：鼠标按在窗口最上方拖不动窗口，只有左侧栏顶部一小条能拖。
- **根因**（**不是 capabilities 权限问题**——`desktop/src-tauri/capabilities/main.json:13` 已有 `core:window:allow-start-dragging`，`toggleMaximize` 属 `core:window:default`）：
  1. `app/web/static/style.css:1051-1053` 只给 `.sidebar::before` 加了 `-webkit-app-region:drag` —— 该属性是 **Chromium/Electron 私有属性，macOS WKWebView 不实现**，这条规则是死的；
  2. `app/web/static/v3.js:26-27` 的 `draggable()` 只挂了 `#topbar` 与 `.sidebar .side-nav`，且 `v3.js:18/22` 放行 `input,button,a` —— 顶栏主体是 480px 搜索框、`.side-nav` 全是按钮、40px 让位带自身无监听，**实际可拖区域几乎为零**；
  3. macOS `start_dragging` 依赖当前鼠标按下事件（tao 读 `NSApp.currentEvent`），窗口失焦时首击会被系统用于激活窗口（tauri#11605）——表现为「第一次点没反应」。
- **修法**（改用 Tauri 内置 drag region，删掉自写 pointerdown）：
  1. `base.html:52` `<div class="topbar" id="topbar">` 加 `data-tauri-drag-region="deep"`（`deep` = 子树可拖；drag.js 仍跳过 `input/button/a`，搜索框照常可点）；
  2. `base.html:73-75` 在 `<aside class="sidebar">` 首位加 `<div class="tb-drag" data-tauri-drag-region="deep"></div>`，并把 `style.css:1051-1053` 的伪元素换成实元素：`html.tauri .tb-drag{position:absolute;top:0;left:0;right:0;height:40px;z-index:1}`，保留 `.sidebar{padding-top:40px}`；`-webkit-app-region` 两行可删（想保 Windows 触摸拖动就留）；
  3. `v3.js:6-32` 的 pointerdown/dblclick 整段删除（drag.js 在 macOS 按系统语义处理双击最大化：mouseup 且鼠标未移动）。
  - `data-tauri-drag-region` 由 Tauri 注入脚本处理，浏览器/Android WebView 无副作用。
- **涉及**：`app/web/templates/base.html`、`app/web/static/style.css:1051-1053`、`app/web/static/v3.js:6-32`（`main.rs` / `capabilities` 不用改）。
- **验证**：拖侧栏顶部 40px 空白与顶栏空白都能带动窗口；搜索框仍可输入；双击拖拽带最大化。**注意 macOS 已知限制**：先点其它 App 让窗口失焦，再单击拖拽带需再拖一次才生效（tauri#11605，非本项目 bug）。

#### #25 退出应用很慢，需要等 ｜ `[已修]` ｜ P1 快赢
- **落地（2026-09-09）**：`main.rs` 的 `stop()` 轮询 `0..30` → `0..5`（宽限 0.5s，实测后端 0.33s 退）；`app/embedded.py` `timeout_graceful_shutdown` 3 → 1，`stop()` 的 `join(timeout=5)` → `1.5` 且超时后 `os._exit(0)`。`cargo check` ✅ / `py_compile` ✅。
- **现象**：关窗后应用要卡几秒才真正退出。
- **根因**：`desktop/src-tauri/src/main.rs:259-263` 只在 `RunEvent::Exit` 里调 `runtime.stop()`，而 `stop()`（`main.rs:27-41`）**在主线程同步阻塞**：`drop(child.stdin.take())` 后 `for _ in 0..30 { try_wait(); sleep(100ms) }` → 最坏 **3.0s** 才 `kill()`。后端**会被回收**（不是漏 kill），但会吃满上限：`app/embedded.py:45` `timeout_graceful_shutdown=3` + `embedded.py:60-64` `_thread.join(timeout=5)`，有在飞请求（播放中的 `/api/stream/{bvid}` 长连接代理）就吃满 3s。**实测**（临时 data-dir、无连接）：stdin EOF 后后端 **0.33s** 退出 → 慢的不是后端，是「3s 上限 + 主线程阻塞等待」。
- **修法**（择一/组合）：
  - **最小改动**：`main.rs:32` `for _ in 0..30` → `0..5`（0.5s 宽限，覆盖实测 0.33s），超时即 `kill()`；
  - **推荐（真正不阻塞）**：`main.rs:259` 整段换成 `RunEvent::ExitRequested { api, .. } if !shutting => { shutting = true; api.prevent_exit(); thread::spawn(move || { rt.stop(); app.exit(0); }); }` + `RunEvent::Exit => rt.stop()`。`shutting` 标志必须有——只拦一次，否则 `app.exit(0)` 会被再次拦截；`stop()` 靠 `child.take()` 天然幂等；
  - **后端侧**：`embedded.py:45` `timeout_graceful_shutdown=3` → `1`；`embedded.py:64` `join(timeout=5)` → `1.5`，join 超时后直接 `os._exit(0)`，避免 `main()` 里 `while _thread.is_alive()` 空转。
- **涉及**：`desktop/src-tauri/src/main.rs:27-41,259-263`、`app/embedded.py:45,60-64`。
- **验证**：播放中关窗计时到进程消失（目标 <0.6s）；`ps -p <backend pid>` 无残留 python；看 `~/Library/Application Support/io.github.lq1123.bilimusic/backend.log` 有无 shutdown 报错。

#### #26 限制最小窗口尺寸 ｜ `[已修]` ｜ P2 快赢
- **落地（2026-09-09）**：`main.rs:171` → `.min_inner_size(1260.0, 410.0)`（1260 > 900 断点，永不触发响应式布局）。`cargo check` ✅。
- **用户澄清（2026-09-09）**：设最小尺寸的**目的是保证桌面端永远不触发响应式布局**——响应式布局只是为了打包/移动端方便，桌面窗口不该滑进手机布局。
- **判据**：全站断点是 `@media (max-width: 900px)`（`style.css:880`，另有 `:871` 的 700px）→ **只要最小宽度 > 900px 就不会触发**；`1260 > 900` ✅。
- **现状**：`main.rs:170-171` 已有 `.inner_size(1280.0, 850.0).min_inner_size(800.0, 600.0)`（800 < 900，所以现在能拖进手机布局）；`tauri.conf.json:8` 的 `"windows": []` 为空（窗口在 Rust 里建）→ **只能改 `main.rs`**（写进 conf 会与建窗逻辑冲突/多开窗，且要丢 `on_navigation`/`on_page_load`，不建议）。
- **取值**：原文「**`126*37`**」按 **1260×370** 理解（126×37 比红绿灯+40px 让位区还小，不可能是有效窗口）。实施值 **`main.rs:171` → `.min_inner_size(1260.0, 410.0)`**：**410 = 370 + 40**，因为 Overlay 下 `style.css:1051` `html.tauri .sidebar{padding-top:40px}`（+:1052 `::before{height:40px}`）把顶部 40px 让给系统红绿灯/标题栏，而 `min_inner_size` 量的是**内容高度**。
- **可用性提醒**：410px 里顶栏约 71px（`style.css:68` padding 16+13+42）、播放条约 74px（`style.css:328-331` bottom:18 + min-height:56），内容区只剩 ~265px，侧栏（3×40 导航 + 歌单 + 用户行）会挤；若要观感更稳，可抬到 1260×560（=520+40）。
- **涉及**：`desktop/src-tauri/src/main.rs:171`（可选 `tauri.conf.json`，不推荐）。
- **验证**：拖右下角，宽 ≥1260、高 ≥410；缩到最小时布局仍是桌面三栏（侧栏在左、底部播放条横贯），**不出现手机端胶囊 Dock**；或用 `window.innerSize()` 核对。

#### #27 搜索不支持中文：空格被劫持、输入法选词上不了屏 ｜ `[已修·二次修正]` ｜ P0
- **⚠️ 第一次修错了机制（2026-09-09 用户复测仍失败）**：首版只加了「空格 handler 的四重防线」（`imeActive` / `keyCode 229` / `activeElement` / `#tbSearch`），但**守卫确实打进了 `.app` 与 APK**（`grep imeActive` 包内命中）而症状依旧 → 说明打断输入法的不是全局空格 handler。
- **真实根因（按代码链路定位）**：搜索下拉的渲染时机不对。`input` 事件里每次输入都 `setTimeout(run, 350)`，而 `run()` 会 `renderLib()` 重写 `#sd-lib` 并 `htmx.ajax` 重写 `#sd-web`。中文输入法打字时，**只要键间隔超过 350ms，就会在组合（composition）中途把下拉的 DOM 换掉**，候选窗口随之被打断——与空格键本身无关。
- **二次落地（2026-09-09）**：
  1. `v3.js` 搜索输入改为**组合感知**：抽出 `scheduleSearch()`，`input` 里 `if (e.isComposing || imeActive) { clearTimeout(timer); return; }`（组合中只清定时器、不重渲染），并监听 `compositionend` 再触发搜索；
  2. 空格 handler 追加**硬保险**：`var sd = $("search-drop"); if (sd && !sd.hidden) return;`——搜索下拉开着就绝不上报播放切换（覆盖 WKWebView 组合态下 `activeElement` 变成 body 的极端情况）；
  3. `base.html` 搜索框 `type="search"` → `type="text" inputmode="search" enterkeyhint="search"`（WebKit 的 search 字段有 IME 怪癖，同时保留手机键盘的「搜索」键）。
  - 缓存号 `v3.js?v=60` → `61`；前端 24 例回归 ✅；`.app` 与 APK 均已重打包并验证包内是新代码。
- **若仍失败**：下一步在应用内加「按键事件诊断浮层」（记录 `key / isComposing / keyCode / target / activeElement / imeActive`），让用户复现一次截图定位——因为无法用自动化模拟中文输入法，只能靠真机取证。
- **现象**：桌面端在搜索框用中文输入法打字，按空格选候选词时被应用吃掉（触发播放/暂停），中文输入失败。
- **根因（推断，需实测确认机制）**：全局空格播放/暂停 handler（`app/web/static/v3.js:1239-1247`）只有两道防线——`e.isComposing` 与 `e.target.tagName === "INPUT"`。macOS WKWebView + 系统输入法组合态下，keydown 可能出现 `isComposing === false`（WebKit 长期缺陷）且 `target` 未必是输入框，于是走到 `e.preventDefault()` + `BiliPlayer.toggle()`，候选词被吞。全工程**没有任何 `compositionstart/compositionend` 监听**（`grep` 零命中）——这一点是确定的事实；「哪一道防线失效」需实测。
  **排除项**：后端与本地检索都支持中文——`/api/search`（`app/api/routes.py:491-501`）走 `encodeURIComponent` + B 站 WBI 搜索；本地曲库 `list_songs()`（`app/services/library.py:16-18`）用 `Song.title.like('%中文%')`（SQLite LIKE 对中文无大小写问题）。所以「不支持中文」是**输入层**问题，不是检索层。
  **复现/定位手法**：在 `v3.js` 空格 handler 首行临时打点 `console.log(e.key, e.isComposing, e.keyCode, e.target.tagName, document.activeElement.tagName)`，用中文输入法在搜索框输入一次，看组合期间那几帧的真实值——据此确定是加 `imeActive` 还是仅补 `keyCode===229` 就够。
- **修法**（三道防线一起加）：
  1. document 级 `compositionstart`/`compositionend`（capture）维护 `imeActive` 标志，`compositionend` 后延迟 ~50ms 复位；
  2. 增加 `e.keyCode === 229`（IME 处理中）判断；
  3. 用 `document.activeElement` 兜底判断焦点是否在 `input/textarea/[contenteditable]` 内；
  4. 可选：`e.target.closest("#tbSearch")` 直接排除搜索胶囊。
- **涉及**：`app/web/static/v3.js`（空格 handler）。
- **验证**：macOS 中文输入法在搜索框输入「周杰伦」全程不触发暂停、空格正常选词、候选词上屏；输入框外空格仍暂停/恢复；Android WebView 回归（#8 原有行为不回退）。

### I.2 手机端

#### #29 通知栏/锁屏媒体卡拿不到正在播放的歌 ｜ `[已修]` ｜ P0
- **落地（2026-09-09）**：
  - `app.js`：`syncMediaMetadata()` 里封面先 `new URL(cover, location.origin).href` 转绝对再传桥（修掉相对 URL 抛 `MalformedURLException`）；
  - `MediaPlaybackService.java`：`updateSessionState()` 补 `METADATA_KEY_ART` + `METADATA_KEY_ALBUM`（`ALBUM_ART` 保留兼容）；`onCreate()` 补 `setFlags(FLAG_HANDLES_MEDIA_BUTTONS|FLAG_HANDLES_TRANSPORT_CONTROLS)` 与 `setSessionActivity(...)`（点媒体卡能回 App）；`loadCover()` 改 `HttpURLConnection` + UA/Referer + 5s 超时（竞态保护与静默容错保留）。
  - 验证：`node --check` ✅；**Android 源文件用本机 `android.jar` + javac 实际编译通过（exit 0）**，并用 `javap` 核对所引常量/方法在 androidx.media 1.7.0 中确实存在。
- **待验**：真机（冷启/切歌/试听流三条路径，通知栏与锁屏都要有歌名+歌手+封面，进度随播放走，点卡片回 App）。
- **现象**：Android 通知栏媒体卡只显示应用名（截图 3：「BiliMusic · B站音…」），没有歌名/歌手/封面。
- **根因**：
  1. **试听流不推 metadata**：`app.js` 原本只在 `playSong()` 里调 `BiliMusicNative.playbackStarted`（HEAD `app.js:308`）；推荐/搜索/UP 页走 `playStream → syncTrialUI`（`app.js:1352`），既不推 title/artist/cover 也不推进度。移动端主入口（推荐/搜索/UP 页）**都是试听流** → 最常见表现就是「通知栏拿不到当前歌」；
  2. 会话元数据不全：`MediaPlaybackService.java:109` 只写 `METADATA_KEY_ALBUM_ART`，缺 `METADATA_KEY_ART` / `METADATA_KEY_ALBUM`；`onCreate`（:40-55）从未 `session.setFlags(FLAG_HANDLES_MEDIA_BUTTONS|FLAG_HANDLES_TRANSPORT_CONTROLS)`，也没 `setSessionActivity(...)` → **点媒体卡回不到 App**；
  3. 封面链路：`loadCover()`（:141-153）裸 `new URL(url).getContent()` 无 UA/Referer，失败被 `catch (Exception ignored)` 吞；HEAD 回调只 `startForeground` 不 `updateSessionState()` → 封面到位后会话里 `ALBUM_ART` 仍是 null（通知有大图、系统卡/锁屏/车机仍无图）。**相对 URL 只是兜底缺口不是主因**：`song_out`（`app/api/routes.py:120`）在 `cover_path` 非 http 时返回 `"/api/songs/{id}/cover?token=…"`，`app.js:341` 原样传桥 → 原生 `new URL("/api/…")` 抛 `MalformedURLException` 被吞；实测 `data/accounts/*/bilimusic.db` 现有 40 首**全是 https CDN**，所以此路当前不触发；
  4. 已提交代码里 `updateSessionState()` 把 `lastPosition * 1000L` **再乘一次 1000**（双重换算），进度显示错乱。
- **工作区已修（未提交）**：`app.js` 抽出 `syncMediaMetadata()` 并在 `syncTrialUI()` 接入 + recAudio `timeupdate` 按 1s 节流推 `playbackProgress`；`MediaPlaybackService.java` 修正 `positionMs` 双重乘 1000、封面加载完成回调补 `updateSessionState()`。
- **仍待修**：① metadata 补 `METADATA_KEY_ART`/`METADATA_KEY_ALBUM`，`onCreate` 补 `setFlags` + `setSessionActivity`；② 封面 URL 传桥前转绝对地址（`new URL(cover, location.origin).href`，或在 `MainActivity.playbackStarted` 内用 `origin` 拼）；③ `loadCover` 加 UA + `Referer: https://www.bilibili.com/`，或**直接复用本地封面缓存**——`FileStore.cover_path()`（`app/storage/files.py:76`）、`cover_response()`（:362）、`/api/songs/{id}/cover`（`routes.py:358-365`）、缓存目录 `data/covers`（`app/config.py:17`），原生侧读本地文件绕开 CDN；④ 页面恢复（`onPageFinished` / `visibilitychange`）重推一次当前曲 metadata，避免进程被杀后通知栏回落成 "BiliMusic"；⑤ 切歌/试听/队列切换三条路径统一走 `syncMediaMetadata`。
- **涉及**：`app/web/static/app.js`、`android/app/src/main/java/io/github/lq1123/bilimusic/{MediaPlaybackService,MainActivity}.java`、`app/api/routes.py`、`app/storage/files.py`。
- **验证**：真机试听推荐池一首 → 下拉通知栏/锁屏看标题+歌手+封面；切下一首看是否刷新；点媒体卡能回到 App；`adb logcat -s BiliMusic` 看 cover-loader 异常。

#### #30 歌手（UP 主）详情页底部导航栏消失 ｜ `[已修]` ｜ P0
- **落地（2026-09-09）**：在已有 `:has()` 规则之外补了不依赖 `:has()` 的兜底——`v3.js` 的 `__showPanel`/`__hidePanel` 调 `syncUpOpen()` 切 `body.up-open`，`style.css` 加 `body.up-open #m-dock{z-index:95}`（隐藏动画结束后再降回）。
- **现象**：进 UP 主/歌手详情页后底部「主页/曲库/账号」导航栏看不见（但左上 ✕ 与返回手势有效——是**被盖住**不是「无法返回」）。
- **根因**：**层级覆盖**而非隐藏——`#up-panel`（`style.css:629`）`position:absolute;inset:0;z-index:90` + 不透明底 `#0a0a10`，压在 `#m-dock`（`style.css:996`）`z-index:65` 之上；两者同为 `#app` 的直接子元素（`.app{position:fixed;inset:0}`，`style.css:54`），同级比 z-index，65 < 90 必被盖。全工程无任何 JS 切 dock 显隐（`v3.js`/`app.js` 无 `m-dock` 引用）→ 排除「详情态 CSS 隐藏」。
- **工作区已修**：`style.css:975` 新增 `body:has(#up-panel:not(.hidden)):not(:has(#lyrics-panel:not(.hidden))) #m-dock{z-index:95}`（歌词页沉浸态仍让位）。
- **仍待**：`minSdk 26` 的老 WebView 不支持 `:has()`，整条规则会被丢弃 → 加不依赖 `:has()` 的兜底：在 `v3.js` 的 `__showPanel`/`__hidePanel`（`v3.js:612-625`）里 `document.body.classList.toggle("up-open", el.id === "up-panel" && !el.classList.contains("hidden"))`，CSS 加 `body.up-open #m-dock{z-index:95}`。（`.up-lay` 已有 `padding-bottom:150px`，`style.css:680/987`，内容不会被 dock 挡。）
- **涉及**：`app/web/static/style.css`、`app/web/static/v3.js`。
- **验证**：手机视口 + 真机：UP 详情页 dock 常驻底部可点，返回后层级恢复正常。

#### #31 搜索详情页封面排版错误、需等比缩小 ｜ `[已修]` ｜ P1
- **落地（2026-09-09）**：手机媒体查询里 `.sr-grid` 由 2 列改 **3 列**（`repeat(3,minmax(0,1fr))`，间距 16/10），并给 `.sr-song .im` 加 `max-width:120px`（保留 `aspect-ratio:1` 等比）。320–430px 宽度下封面均 ≤120px。
- **现象**：搜索后进入结果页，歌曲封面过大且不随屏幕缩放（「不能一直是这个大小」）。
- **根因**：`.sr-grid`（`style.css:492`）用 `repeat(auto-fill, minmax(158px,1fr))`，`.sr-song .im`（`style.css:494`）`width:100%; aspect-ratio:1` **无尺寸上限**；手机媒体查询只把它固定成 2 列（`style.css:976`）。窄屏（≤360px）时 auto-fill 塌成 1 列 → 单张封面撑满整屏；即使 2 列也有 ~170px 见方，明显偏大。
- **修法**：① 手机端固定 3 列（`repeat(3, minmax(0,1fr))`），或给封面加 `max-width:120px`（保留 `aspect-ratio:1` 等比）；② 更省空间：结果页改「72px 小方图 + 两行文字」的紧凑行式列表（与曲库列表一致）；③ 保留 `min-width:0` 防网格溢出（工作区已加 `.sr-song{min-width:0}` 与 `.sr-song .im img{display:block}`，但治的是基线缝隙，不是尺寸）。
- **涉及**：`app/web/static/style.css`（`.sr-grid`/`.sr-song`）。
- **验证**：320/360/390/430 宽度下封面均等比且 ≤120px，文字不溢出。

#### #32 搜索详情页只能靠搜索栏 ✕ 退出 ｜ `[已修]` ｜ P0
- **落地（2026-09-09）**：`back-stack.js` 的 detail 层 isOpen 泛化为「非 home 且非 Tab 视图（library）」，close 优先走 `closeDetailTo()`；`v3.js` 的 `closeDetail()` 守卫由「只认 detail」改为「home 才 return」、`goHome()` 顺带清空 `#sr-body`；`style.css` 把 `#view-search` 补进显隐名单并加 `.app[data-view="search"] #view-search{display:block}`；`partials/search_detail.html` 顶部加「‹ 返回」按钮（`.sr-back` 样式）。新增 2 例回归（`closeDetailTo` 优先 / library 不入栈），`node --test tests/test_mobile_navigation.js` 3 例全过。
- **现象**：搜索后进入结果页，点底部导航栏、手机回退手势都无效，只能再点搜索栏 → ✕ 才退得出。
- **根因**（三段同一根：搜索详情态 `data-view="search"` 没进统一出口）：
  1. 搜索详情态写的是 `#app[data-view="search"]`（`v3.js:923`），而 `back-stack.js:105-107` 的层注册只认 `"detail"` → `__backStackDepth()` 返回 0 → 壳层 `onBackPressed`（`MainActivity:273-283`）走 `doDefaultBack()`，而 `web.canGoBack()` 为 false（代码注释已说明 WebView 不认同文档 pushState 历史）→ `super.onBackPressed()` **直接退出 App**；
  2. **即使注册也会被自己吃掉**：HEAD 的 `sync()` 在 `forEach` 里就 `history.pushState`，之后才 `for(…) history.back()`；进搜索详情的那一次 sync 里 search-drop 关闭记了 `backs=1`（`back-stack.js:42-46`）→ 刚推的条目被自己弹掉。工作区已重写为「先结算 backs、再用 replaceState 顶替同一条目」（`back-stack.js:28-55`）；
  3. `mTab()`（`v3.js:1432-1440`）走 `__backStackReset(); closeDetail(); rehydrateHome();`，而 `closeDetail()` 开头是 `if ($("app").dataset.view !== "detail") return;`（`v3.js:305-306`）→ 搜索详情态被整段跳过，Tab 只换高亮、页面不动。工作区已改 `goHome()`；
  4. `style.css:737` 的视图隐藏名单（`#view-home,#view-detail,#view-account,#view-recommend,#view-up{display:none}`）**漏了 `#view-search`**，且全文件无任何 `.view` 规则 → `#view-search`（`library.html:94`）恒为 block，退主页后旧搜索结果仍留在主页下方。
  - **为什么会漏**：§A #1 把「详情态」等同于 `data-view="detail"` 这一个值，§A #17 的出口函数 `closeDetail()` 又用单值守卫复刻了同一假设；搜索详情复用同一个 `#app[data-view]` 属性却取了第二个值 → 层注册与出口收口同时漏。
- **工作区已修**：`back-stack.js` 注册条件改为 `view === "detail" || view === "search"`；`sync()` 改批量 `replaceState/pushState`；`v3.js` 的 `mTab()` 改走 `goHome()`。
- **仍待修（建议一次收口，别再打特例）**：① `back-stack.js` 的 isOpen 泛化为 `var v = app.dataset.view; return !!v && v !== "home";`（任何非 home 视图都可返回）；② `closeDetail()` 守卫改 `if (view === "home") return;`；③ `#view-search` 补进 `style.css:737` 并加 `.app[data-view="search"] #view-search{display:block}`，`goHome()` 里清 `$("sr-body").innerHTML = ""`；④ `partials/search_detail.html` 顶部加显式 `<button onclick="goHome()">← 返回</button>`。
- **涉及**：`app/web/static/back-stack.js`、`v3.js`、`style.css`、`app/web/templates/partials/search_detail.html`。
- **验证**：`node --test tests/test_mobile_navigation.js`（已有 search→back→home 用例）；真机：搜索回车进详情 → 点底部「曲库」应回主页；再进详情 → 系统返回手势应回主页而非退出；退回主页后搜索结果不残留。

### I.3 收藏语义

#### #33 点已收藏歌曲的收藏图标 = 取消收藏 ｜ `[已修]` ｜ P0（语义级）
- **落地（2026-09-09）**：`v3.js` 新增 `collectedIds`（bvid → song.id）、`albumForBvid()`（查 `/api/albums` 建 视频→分P专辑 映射）、`uncollectCurrent()`；`collectCurrent()` 的已收藏分支由「只弹提示」改为调用它。单曲走 `DELETE /api/songs/{id}`；多分 P 专辑弹 `__confirmModal` 说明影响后走 `DELETE /api/albums/{id}`（整张 + 取消 B 站收藏）。成功后清状态、`markStar()`、toast、`htmx.trigger(refreshSongs)`。`node --check` ✅ / 前端 22 例回归 ✅。
- **现象/期望**：点已收藏曲目的星星应取消收藏；现在点了没反应（只弹提示）。
- **根因**：`v3.js:784-800` 的 `collectCurrent()` 只实现「未收藏 → 收藏」，已收藏时仅 `toast("这首已在曲库中")` 后 return，**全链路没有取消收藏入口**；`collected` 映射以 **bvid** 为键（`v3.js:768-775`），多分 P 专辑所有曲目共用一个 bvid，星星无法区分单曲。后端**已有** `DELETE /api/songs/{id}`（`app/api/routes.py:402-419`：本地删除 + `unfavorite_song` 同步 B 站），前端只差接线。
- **修法**（只改 `v3.js` 三处；后端接口已就绪，列表行 ✕ 已在用同一条路径 `app.js:428-433`）：
  1. `v3.js:755` 旁新增 `var collectedIds = {};`；`loadCollected`（`v3.js:768-775`）补 `if (s.id) collectedIds[s.bvid] = s.id;`；`window.__markCollected(bvid, id)` 增加 id 入参（`v3.js:1391` 调用处无需改）；
  2. `collectCurrent()` 已收藏分支（`v3.js:787`）改调新增的 `uncollectCurrent(bvid)`：取 `collectedIds[bvid]` → `fetch("/api/songs/"+id,{method:"DELETE"})` → 成功后 `delete collected[bvid]` + `delete collectedIds[bvid]` + `markStar()` + toast「已取消收藏 · 已从 B 站收藏夹移除」+ `htmx.trigger(document.body,"refreshSongs")`（已绑 `loadCollected` 与 `refreshPlaylist`）；
  3. 加二次确认：取消收藏是破坏性操作，用现成的 `window.__confirmModal`（`v3.js:1298`）。
  - **副作用（必须知道）**：多分 P 共用同一个 B 站视频收藏，取消一行 = 取消**整个视频**的收藏；同视频其余分 P 的 `fav_folder_id` 仍非零，下次同步会按 `app/services/sync.py:257-273`（夹里消失 + `fav_folder_id` 非零 = 已取消）把它们一并删除。若要「只删当前曲目」的精确语义，取消时需按 `aid` 删全部同视频行（照 `routes.py:274-282` `delete_album` 的做法），或至少提示影响范围。
  - **粒度已定（2026-09-09）**：B 站收藏是视频级、逐曲「收藏」走加入歌单（#36 已拍板 B 方案），所以**星星 = 视频级收藏/取消**，不按分 P 区分。
  - **仍待拍板（取消范围）**：多分 P 专辑里点星星取消时——① 只删当前曲目（需按 `aid` 精确处理，并清理同视频其余行的 `fav_folder_id` 残留）；② **推荐**连带删除整张专辑（对齐 §E #14「删专辑=取消该视频收藏」），并在 `__confirmModal` 里写明「将取消该视频的 B 站收藏，并移除专辑内 N 首」。**默认按 ② 实现**，用户若要 ① 再改。
- **涉及**：`app/web/static/v3.js`（改）、`app/api/routes.py` / `app.js`（只读复用）。
- **验证**：登录 → 播一首已入库歌 → 点 ★ → toast 变「已取消收藏」、★ 变灰、曲库该行消失、B 站 `bilimusic` 夹少一条；再点 ★ 能重新收藏回来；`tests/test_delete_song.js` 回归。

#### #28 播放「未收藏」的歌时显示不正确 ｜ `[已澄清·并入 #29]` ｜ P1
- **用户澄清（2026-09-09）**：「指的是**通知栏的播放组件**，在未收藏的时候无法正确识别所有信息。」
- **结论**：这不是独立问题，而是 **#29 的另一条表现**——「未收藏的歌」= 没入库的试听流（推荐/搜索/UP 页点播），走的正是 `playStream → syncTrialUI` 那条**不推 metadata** 的路径；而入库歌曲走 `playSong()` 会推。两者同根因、同修法。
- **处理**：合并到 #29 一起做，不单独占工作量。验证时把「播放未收藏的试听流 → 通知栏信息完整」作为 #29 的一条必测用例。

### I.4 界面改进

#### #34 手机端「曲库」Tab → 「资料库」：列歌单 → 进歌单看全部歌曲 ｜ `[已修]` ｜ P1
- **落地（2026-09-09）**：按 S1–S8 全量实现——`base.html` 文案改「资料库」（`data-mtab` 仍为 `library`）；`library.html` 新增 `#view-library`（`#mlib-pls` 走 `/partials/playlists`，含「全部歌曲」伪卡）；`style.css` 加 `#view-library` 显隐 + `.mlib-pls` 移动端覆盖 + `pointer:coarse` 常显重命名/删除 + **删除死规则** `body[data-mtab="library"] …`；`v3.js` 新增 `openLibraryTab()` / `closeDetailTo()` 与 `detailOrigin` 来源感知，`mTab('library')` 走前者；`back-stack.js` 的 close 改调 `closeDetailTo()`；详情页 ‹ 按钮与面包屑按来源显示「资料库 / …」。回归：node 24 例、Python 120 passed / 2 skipped ✅。
- **现状（已勘察，文件:行号）**：
  - 底部 Tab：`base.html:259-266`（`.m-tab[data-mtab="home|library|account"]` + `.m-orb`），「曲库」在 `base.html:262`；
  - `mTab()`（`v3.js:1432-1440`）只做三件事：`body.dataset.mtab=name`、切 `.m-tab.on`、**无条件 `goHome()`**；高亮滑块位移由 `data-mtab` 驱动（`style.css:1006-1007`）；
  - 所以「曲库」渲染的**就是主页**（`goHome()` 把 `#app[data-view]` 设回 `home`），再用纯 CSS 藏掉发现区——`style.css:1029-1030` `body[data-mtab="library"] .sec-hero,#genre-shelves{display:none}`。**没有任何歌单列表**；`v3.js:197-201` `pullEnabled()` 里的 `view==="library"` 是死分支（view 永远是 home）；`routes.py:167-169` 的 `/library` 只是 307 跳 `/`。
  - 电脑端可复用：侧栏 `base.html:80-85` `hx-get="/partials/playlists"` → 片段 `partials/playlists.html`（`.side-pl` 行：`.sp-cov` 30px 封面 / `.sp-name` / `.cnt` 曲数 / `.pl-rename` / `.pl-del`，`onclick="openDetailFrom(this)"`）；详情页 `openDetailFrom`（`v3.js:501-508`）→ `fillUserDetail`（`v3.js:415-451`）→ `htmx.ajax GET /partials/songs?playlist_id=N` → `#dt-songs`（`library.html:76`），曲目片段 `partials/songs.html`。后端 `routes.py:172-185` `/partials/playlists`（`cards[0]` = id 0「全部歌曲」）与 `routes.py:241-254` `/partials/songs` **均无需新增**。
- **改造（分步，零新片段、零新接口）**：
  1. **文案 + 缓存号**：`base.html:262` 文本 →「资料库」；**`data-mtab` 值必须保持 `"library"`**（`style.css:1006`、`:1030`、`v3.js:1451` 都依赖）；同步 bump `base.html:15/20/21` 的 `style.css?v=` / `v3.js?v=` / `back-stack.js?v=`；
  2. **新视图段**：`library.html:55`（`#view-detail` 之前）插入 `<section class="view" id="view-library">`，主体 `<nav id="mlib-pls" hx-get="/partials/playlists" hx-trigger="load, playlistsChanged from:body, refreshSongs from:body" hx-swap="innerHTML">`，**原样复用 `partials/playlists.html`**（含 id=0 伪卡）；
  3. **CSS**：`style.css:737` 的 `display:none` 名单加 `#view-library`，紧随加 `.app[data-view="library"] #view-library{display:block}`；`:730` 动画名单同步；手机媒体查询内加 `.mlib-pls{flex:none;overflow:visible;padding-right:0;margin-right:0}` 与 `@media(pointer:coarse){.side-pl .pl-rename,.side-pl .pl-del{display:grid}}`；**删除死规则 `style.css:1030`**（否则与新机制打架）；
  4. **Tab 路由**：`mTab()` 改分支——`library` 走新函数 `openLibraryTab()`（放 `closeDetail` 旁）：`collapseOverlays(); app.dataset.view="library"; body.classList.remove("in-detail"); switchView("library");`，`#mlib-pls` 为空时补一次 `htmx.ajax`；其余 Tab 保持 `goHome()`；
  5. **返回来源感知（关键）**：`openDetailFrom`（`v3.js:501`）记录模块级 `detailOrigin = (view === "library") ? "library" : "home"`；新增 `window.closeDetailTo()`：`search` → `goHome()`；`detailOrigin==="library"` → 还原 `data-view="library"` + `switchView("library")`（**不要调 `mTab`**，否则重复 rehydrate/滚顶）；否则 `goHome()`；
  6. **详情页入口/面包屑**：`library.html:57` 的 `onclick="goHome()"` → `closeDetailTo()`；`v3.js:430` 的 `#dt-crumb` 按 `detailOrigin` 拼「资料库 / 」或「主页 / 」；
  7. **返回栈对接**：`back-stack.js:107` detail 层 close 改 `function(){ if (window.closeDetailTo) closeDetailTo(); else if (window.goHome) goHome(); }`（`isOpen` 不动，避免双 observer 回调引起 back/push 竞态）；
  8. **测试**：`tests/test_mobile_navigation.js` 加一例——`closeDetailTo` 存在时 detail 层关闭调用它而非 `goHome`。
- **风险点**：① 账号 Tab 用 `body[data-mtab]` 显示（`style.css:1031-1032`）、资料库改用 `data-view`，两套机制共存必须删 `:1030`；② `data-mtab` 值不可改；③ 若给资料库另注册一个层会与详情层的 MutationObserver 回调产生「先 back 再 push」抖动——本方案用来源感知 close 规避，**不新增层**；④ 触屏无 hover，`.pl-rename/.pl-del` 默认 `display:none`（`style.css:286-288`），手机端需 `pointer:coarse` 常显；⑤ 「排版参考电脑端」有落差：手机 `style.css:907-912` 隐藏了 `.list-head` 与 `.trk .no/.pl-pill/.q/.du`，最小建议只放开 `.no` + `.du`（列模板 `26px 40px minmax(0,1fr) auto`）；⑥ 未登录时 `/partials/playlists` 走 `_login_redirect`（`routes.py:32-38`）→ 401 JSON → 现有全局监听弹登录窗，不会空白；⑦ `sw.js:2` 的 `CACHE` 未随版本换，务必 bump `?v=`；打包副本（`desktop/backend/...`、`android/app/build/intermediates/assets/...` 里的 base.html）**勿手改**，重新打包即可。
- **涉及**：`app/web/templates/base.html`、`library.html`、`app/web/static/{style.css,v3.js,back-stack.js}`、`tests/test_mobile_navigation.js`、`docs/acceptance-manual.md`（可选）。**新建：无**。
- **验证**：① `pytest -q tests/` + `node --test tests/test_mobile_navigation.js`；② 390px 视口：底部显示「资料库」→ 点入见「全部歌曲 + 各歌单（含曲数）」→ 点歌单 → `#view-detail` 曲目与电脑端一致 → 系统返回/浏览器后退**回到资料库**（不是主页，Tab 高亮仍为资料库）→ 详情 ‹ 也回资料库；③ 回归电脑端侧栏歌单点击/详情/返回主页不变；④ 主页↔资料库↔账号 连切 ≥3 轮无残留/空白/重复堆叠；⑤ 未登录点「资料库」弹登录窗而非空白。

#### #35 收藏按钮两处补齐 ｜ `[已修]` ｜ P2
- **落地（2026-09-09）**：
  - (a) `base.html` 在 `.hs-txt` 后加 `#ly-star-big`；`v3.js` 的 `markStar()` 选择器与绑定数组都加上它；`style.css` 手机媒体查询内加 36×36 圆钮样式（`#ly-star-big.on` 变粉）。
  - (b) 采纳推荐 A：`#btn-star` 从 `.trow` 移进 `.p-acts` 首位，图标换成新增的 SVG sprite `<symbol id="i-star">`，`style.css` 的 `#btn-star` 改为与 `.p-acts button` 同构（桌面 38×38 / 手机自动继承 32×32）。
- **现象**：(a) 手机端播放详情页歌名后没有收藏按钮；(b) 电脑端播放条收藏按钮比右侧按钮小一圈。
- **根因**：
  - (a) 星标现有两处——`#btn-star`（`base.html:121`，紧跟 `#player-title`）与 `#ly-star`（`base.html:174`，在 `.l-songrow > .ly-morerow` 内）。手机端 `#lyrics-panel` 分两态：封面态被 `style.css:932-934` 的 `#lyrics-panel:not(.showlyrics) .l-songrow{display:none}` 整行藏掉（★ 在其中），只有切到歌词态（`.showlyrics`）才显示；而手机播放详情页的大标题走的是另一块 `.l-hero > .l-herosong > .hs-txt > #ly-title-big`（`base.html:180-188`）→ 封面态歌名后没有收藏入口。（桌面端 `.l-hero{display:none}`，`style.css:624`，不受影响。）
  - (b) `#btn-star` 被独立 id 规则钉死为 `18×18`（`style.css:366`），而同一条播放条右侧 `.p-acts button` 是 `38×38`（`style.css:387`；手机 `32×32`，`style.css:924`）——尺寸差一倍多；且 ★ 是**文字符号**（字体度量跨平台不一致），DOM 也不在同一按钮组（`.p-meta .trow` vs `.p-acts`）；id 选择器优先级高于 `.p-acts button`，所以只搬 DOM 不改 CSS 无效。
- **修法**：
  - (a) `base.html:186`（`.hs-txt` 之后）插入 `<button id="ly-star-big" type="button" title="收藏到我的曲库（同步 B 站收藏夹）">★</button>`；`.l-herosong` 已是 `display:flex;gap:12px`（`style.css:961`），无需改布局；`v3.js:764` 的 `markStar()` 选择器加 `#ly-star-big`、`v3.js:801` 的绑定数组加 `"ly-star-big"`（两处都要，否则状态不刷新/点了没反应）；手机媒体查询内补样式（照 `#ly-bubble`，`style.css:965-967`）：`flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-size:20px`。
  - (b) **推荐 A（真正等大）**：把 `#btn-star` 移进 `.p-acts` 首位（`base.html:127` 之后），图标换成 SVG `<symbol id="i-star">`（与现有 icon sprite 同构，避免字体度量问题），`style.css:366-368` 改为与 `.p-acts button` 同构（或直接删掉让通用规则接管）→ 桌面 38×38、手机自动继承 32×32。副作用：手机迷你播放条会多一个按钮，375px 下 `.p-meta` 约剩 150px，嫌挤可在手机媒体查询里藏掉 `#btn-queue`。
  - **备选 B（最小改动）**：DOM 不动，`#btn-star` 改 `26×26` + `#btn-star svg{width:22px;height:22px}`——视觉齐平但并非真正等大。
- **涉及**：`app/web/templates/base.html`、`app/web/static/style.css`、`app/web/static/v3.js`。
- **验证**：手机 375px → 播歌 → 点封面进全屏 → 歌名右侧出现 ★ → 点它入库/取消 → 切歌词视图两处 ★ 状态一致（`markStar()` 同时刷三个 id）；桌面 1440px → 量右侧按钮与 ★ 同为 38×38、SVG 24×24 → 点 ★ 变粉色。

#### #36 多P视频 → 专辑容器：点击进专辑 + 专辑内逐曲收藏 ｜ `[已修·一期]` ｜ P1
- **落地（2026-09-09）**：
  - **进专辑入口**：`app/web/routes.py` 的 `_song_ctx()` 补 `album_id`（原来曲库片段拿不到专辑信息，按钮渲染不出来）；`partials/songs.html` 对 `s.album_id` 非空的行加「专辑」按钮（`data-open-album` / `data-album-name`）；`v3.js` 加 **capture 阶段** 的委托监听（先于 app.js 的 `data-play` 播放委托，并 `stopPropagation`），点击即 `openDetailFrom()` 打开该专辑；`style.css` 加 `.trk .goalbum` 胶囊样式，手机端常显。
  - **专辑内逐曲收藏**：按拍板的 B 方案，复用现有 `＋`（`data-add`），把 `album_tracks.html` 的 title 改为「收藏到歌单」明确语义——不加新字段、不改 B 站收藏粒度。
  - 回归：node 24 例、Python 120 passed / 2 skipped ✅。
- **待验**：真机/桌面导入一个多分 P 链接 → 曲库行出现「专辑」→ 点它进专辑 → 逐曲 ＋ 收藏到歌单。
- **用户原话（2026-09-09）**：「多p视频会自动解析为一个歌单，作为专辑，我点击多p的时候会转到这个专辑中，我可以在这个专辑中收藏歌曲。」
- **现状盘点（代码事实）**：
  - 「自动解析为专辑」**已实现**（§E #14 一期）：导入无 `p=` 的多分 P 链接 → 建 `Album(kind="paged")` + 全部曲目行；
  - 「点击多P 进专辑」**只对主页「专辑」货架的卡片成立**——`partials/albums.html` 的 `.album-card` 带 `onclick="openDetailFrom(this)"` → `fillAlbumDetail`（`v3.js:358-388`）→ `#view-detail`；而**曲库列表里每个分 P 各占一行**（`partials/songs.html` 的 `.trk` 只有 `data-play`，点了直接播，**没有进专辑的入口**）；
  - 「专辑内收藏」**目前没有**——专辑曲目行（`partials/album_tracks.html`）只有两个动作：`＋` 加入歌单（`data-add`）与 `✕` 从专辑隐藏（`data-del`，注释明确「保留 B 站收藏」）；行本身 `data-play` 点了就播。
- **要做的三件事**：
  1. **多P = 一个歌单/专辑容器**（语义确认）：导入即建容器 + 曲目；主页「专辑」区与手机端「资料库」（#34）都能看到入口；
  2. **点击多P → 进专辑**：曲库/搜索结果/最近收藏里的分 P 行需要一条「进专辑」路径（`album_tracks.html` 已有 `data-album`，可复用）；**建议行内加专辑角标按钮或更多菜单，不要把整行点击从「播放」改成「进专辑」**——会破坏既有手感；
  3. **专辑内逐曲收藏**：在 `album_tracks.html` 的行动作里加收藏钮，与 `#btn-star` 共用状态。
- **必须先定的语义（B 站收藏是「按视频」不是「按分 P」）**：B 站收藏夹粒度是 aid（整个视频），无法单独收藏某个 P。
  - **✅ 用户已拍板（2026-09-09）：走 B 方案——「收藏」= 加入歌单**。即专辑里的逐曲收藏复用现有 `＋`（`data-add`，`app.js` 的加入歌单流程），**不新增本地 fav 字段、不改 B 站收藏粒度**（整视频仍一条）。实现上只需让这个动作在专辑页更显眼/文案更清楚（如 title 改「收藏到歌单」），无需动数据库。
  - 曲目行呈现：**✅ 用户已拍板走 A 方案——曲库行内加「进专辑」按钮**，整行点击仍是播放（不破坏既有手感）。
- **影响面**：§E #14 的语义矩阵（paged 列「收藏同步 = 整视频收藏一次」**保持不变**）、#33（星星仍是视频级收藏/取消）、#34（多P 专辑是否同时出现在资料库列表——建议「出现」，因为它本质就是一个歌单）。
- **涉及**：`app/web/templates/partials/{songs,album_tracks}.html`、`app/web/static/v3.js`、`app/web/static/app.js`，若走 A 方案另需 `app/db/models.py` + `app/services/library.py`。
- **验证**：导入一个多分 P 链接 → 主页「专辑」出现卡片 → 点进专辑见全部曲目 → 逐曲收藏/取消 → 曲库与专辑两处状态一致 → 按所选语义核对 B 站收藏夹。

#### #37 搜索到「合集」（多P视频）被当成单曲：一收藏把 50 首全塞进曲库 ｜ `[已修]` ｜ P1
- **落地（2026-09-09）**：用户拍板「预探前 20 条 / 只建容器零入库 / 资料库+专辑区都放」，全量实现：
  1. **数据层**：`Song.collected`（默认 True，索引）+ 迁移 `ALTER TABLE song ADD COLUMN collected INTEGER DEFAULT 1`；**存量数据一次性归位**——`album_id>0` 且属于 `kind='paged'` 专辑的曲目改为 `collected=0`（实测用户库：50 首合集曲目移出曲库，12 首单曲保留）；
  2. **导入语义**（`importer.py`）：多 P 视频 → 建容器 + 全部子作品 `collected=False`、`playlist_id=0`（**零入库**）；容器按 `source_bvid` 幂等复用，重复导入不再建第二个容器；
  3. **曲库过滤**（`library.list_songs(only_collected=True)` 默认）：曲库/最近收藏/`/api/songs` 都只看已收藏，子作品不污染曲库；
  4. **容器逐曲收藏**：新增 `POST /api/songs/{id}/collect`（可指定歌单）与 `POST /api/songs/{id}/uncollect`（移出曲库、留在合集里）；合集容器每行右侧是**五角星按钮**（未收藏=灰色空心，已收藏=粉色实心，点击切换；原先的文字「收藏」胶囊在窄列里被挤成竖排两字，用户反馈太丑，2026-09-09 已换掉）；曲库行里的合集曲目用 ✕ = 移出曲库；
  5. **搜索三分类**：`BiliClient.video_page_count()` + `/partials/search-detail` 并发探测前 20 条（信号量 6、进程级缓存、失败按单曲），模板分区 **UP 主 / 合集 / 歌曲**；合集卡带「合集 · N 首」角标，点击走新增 `POST /web/collect-album`（建容器）→ 打开容器；已建容器的直接给 `album_id` 直接进；
  6. **界面归属**：资料库新增「合集」货架（`/partials/albums`）+ 主页「专辑」区，两处都在。
- **验证**：`_probe_collections` 真实接口实测——搜索「周杰伦 合集」20 条正确分出 **18 个合集 / 2 首歌曲**（识别出 50/184/185/100/166 分 P）；用户库迁移后 collected=1 共 12 条、collected=0 共 50 条；Python 120 passed / 2 skipped、前端 24 例通过；`.app` 与 APK 已重打包并验证包内新代码。
- **待验（真机/桌面手测）**：搜索「周杰伦 合集」→ 三区分列 → 点合集卡 → 建容器并打开 → 容器里逐曲「收藏」→ 曲库只多那一首；再点「✕」移出曲库。
- **已知取舍**：搜索下拉（输入即出的小面板）**不做**多 P 探测（否则每次输入都要打 20 个请求），只有回车进入的搜索详情页分类。
- **用户原话（2026-09-09）**：「我搜索到了一个合集。但是界面是在歌曲中。我点击这个歌曲，然后收藏，他把合集中所有的歌全给我收藏进去了。我理想的交互模式是：合集单独显示，可以搜索到 3 个结果，up主、合集、歌曲。合集可以类比为歌单。点开合集，能看到合集中所有的子作品，对子作品收藏。」
- **已定位的事实（查用户库 + 打真实接口）**：
  - 用户库里那条专辑是 `id=2, kind="paged", source_bvid="BV1FPjy6TEiE", total_pages=50`，正是搜索「周杰伦 合集」的第一条 → **用户说的「合集」= 一个 50 分 P 的多 P 视频**，不是 B 站跨视频合集（ugc_season）；
  - 现行导入语义（§E #14 一期）：多 P 链接 → 建 `Album(kind="paged")` + **全部分 P 建成曲目入库**，所以「收藏一次 = 50 首进曲库」；
  - **搜索接口不返回任何合集/多P 标记**：把该条原始字段全量 dump 后确认 `is_union_video=0`、`episode_count_text=""`、`corner=""`、`biz_data=null`、`type="video"`；`search_type=collection/season/media_list` 均被 B 站拒（`被降级过滤的请求`）→ **只能靠 view 接口的 `pages` 判定是否为多 P**；
  - 现行渲染：`partials/search_detail.html` 的 `.sr-grid` 与 `partials/web_search.html` 的行把**所有** video 命中都渲染成「歌曲」，无类型区分。
- **方案要点（待用户拍板后落地）**：
  1. **搜索分三类**（UP主 / 合集 / 歌曲）——合集判定需要在搜索详情页对命中条目并发调 view 取 `pages`（成本 = 每条一次请求，有风控风险，探测条数待定）；
  2. **合集 = 容器**：点击进入容器页（复用 `#view-detail` / `#dt-songs`），列出全部子作品；
  3. **子作品逐个收藏**：对齐 #36 已拍板的 B 方案（收藏 = 加入歌单），即子作品只有被显式收藏才进曲库；
  4. **导入多 P 不再自动入库全部**：建容器时不再批量建 Song 行（可复用 #14 已有的懒物化机制 `materialized_pages` / `POST /api/albums/{id}/materialize`）。
- **涉及（预估）**：`app/bili/client.py`（暴露 `pages` 探测）、`app/services/importer.py`（多P 不再全量入库）、`app/api/routes.py` + `app/web/routes.py`（搜索分类 / 容器接口）、`app/web/templates/partials/{search_detail,web_search,album_tracks}.html`、`app/web/static/v3.js`。
- **验证（预估）**：搜索「周杰伦 合集」→ 三类分组正确 → 点合集进容器见 50 个子作品 → 收藏其中 1 个 → 曲库只多 1 首 → B 站收藏夹语义不变。
