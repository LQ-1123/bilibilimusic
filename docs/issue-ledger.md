# BiliMusic 体验问题台账与修复方案

> 维护日期：2026-09-08 ｜ 定位：对标 YouTube Music 的「最好用的 B 站音乐播放器」（移动优先）
> 用途：本文件由会话讨论沉淀而来，供开发者逐条自修。每条含：现象 → 根因（代码定位）→ 建议修法 → 涉及文件 → 验证方式。
> 状态图例：`[待修] [修中] [已修] [搁置]`

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

### #3 后台播放不稳、无系统媒体条/锁屏控制 ｜ `[修中]` ｜ P1（分水岭）
- **本轮推进（2026-09-08）**：Android Manifest 已加入媒体前台服务、通知权限与 `mediaPlayback` service；新增 `MediaPlaybackService` 通知渠道/持久在线通知，WebView 起播经 `BiliMusicNative.playbackStarted()` 启动服务。尚未接入原生音频引擎、媒体按钮和进度同步。Android Gradle 编译受本机 wrapper 锁文件权限阻塞；Python 回归 114 通过、2 跳过，前端脚本语法检查通过。
- **现象**：切后台/锁屏后播放不稳定；通知栏没有媒体卡片；锁屏不可控；蓝牙耳机/线控无效。根因：Android 是裸 WebView——WebView **不支持** `navigator.mediaSession`，前端 mediaSession 代码（app.js:253 起）只在桌面浏览器生效。
- **第一段落地（2026-09-08）**：`MediaPlaybackService`（foreground，mediaPlayback 类型）+ 播放通知（标题/艺人/ongoing）；页面桥 `BiliMusicNative.playbackStarted/stopped` 起停服务；Manifest 声明服务与 FOREGROUND_SERVICE_MEDIA_PLAYBACK/POST_NOTIFICATIONS 权限；androidx.core 依赖已加。已升级为**系统媒体卡片**并实测 ✅：MediaSessionCompat + MediaStyle（封面大图、播放/暂停大钮、上一首/下一首、进度状态）；按钮与锁屏/耳机线控经 Session 回调 → evaluateJavascript 回控 WebView 播放器（暂停/切歌实测生效，图标随 `playbackPaused` 桥同步）；运行时申请 POST_NOTIFICATIONS。封面缓存 + 进度经 `playbackProgress` 桥（1s 节流）上报。Media3 迁移可后续再做（现 androidx.media 方案已满足锁屏/通知/线控）。**修法**（路线 B 渐进，四段式，总估 4–8 周）：
  1. **前台服务**：`MediaPlaybackService`（foreground，Android 14+ 声明 `android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK`；13+ 运行时申请 `POST_NOTIFICATIONS`）；MediaStyle 通知带封面/进度/收藏按钮；点击通知回对应页（需 #1 寻址）；
  2. **Media3 Session**：播放引擎迁原生，直接拉本地后端流（`/api/stream` 已支持 Range；务必先修 cid bug，见 §F0）；锁屏/蓝牙 AVRCP/线控/音频焦点全由 Session 提供；
  3. **JS Bridge**：接口先行设计（播放/暂停/切歌/进度/音量/封面歌词元数据双向同步），Web UI 保留现状，播放命令改走桥；
  4. **Smart Transition 策略**：v1 原生单轨 + 前端给过渡计划，或原生双 ExoPlayer crossfade；TrackAnalysis 数据在 SQLite，完整复刻后置。
- 配套：#4 音频焦点与耳机拔出（becoming noisy）在此一并实现（来电/他 App 播放→暂停；拔出→暂停）；进程被杀冷启→恢复播放（见 #1 寻址 + 播放状态持久化）。
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

### #11 手机端下拉刷新 ｜ `[待修]` ｜ P1
- **本轮落地（2026-09-08）**：`v3.js` 在移动粗指针设备的主页/曲库顶部加入自绘下拉刷新，64px 阈值触发 `refreshSongs`，详情、弹层、按钮和输入控件不抢占手势；添加加载/就绪状态样式。Node 交互回归 17 例通过，真机手势与网络刷新仍待抽查。
- **修法**：前端自绘（不加 androidx 依赖）：
  1. 仅触摸设备 + 移动布局（matchMedia）且主滚动容器 `scrollTop<=0` + 当前为 feed 视图（主页/曲库）时启用；
  2. touch/pointer 手势：下拉超阈值（约 64px）显示品牌色 spinner，松手触发当前视图数据重取（重触发 htmx partial：genre-shelves / rec-playlists / playlists 等，按视图路由）；
  3. 面板/弹窗/输入态/播放详情内不触发；`prefers-reduced-motion` 下减弱动画；
  4. iOS 浏览器场景说明：Safari 自带整页下拉刷新，与 WebView 内自绘不冲突（WebView 无系统 PTR）。
- 验证：Android 真机各视图下拉出现 spinner 且列表更新、滚动位置保留。

---

## E. 内容与数据

### #14 合集 → 专辑 ｜ `[修中·一期主体完成]` ｜ P1（架构级，分两期）
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
| B2 原生播放 | #3/#4 第一段(前台服务+MediaStyle 通知) → 二段(Session/锁屏/蓝牙) → 三段(JS Bridge) | ⏳ 下一大项（分阶段 3~6 周） |
| B3 内容 | #14 一期(paged 专辑) → 二期(series)；#10(歌词源) | ⏳ #14 一期建议紧接当前批次启动（F0 已就绪） |
| B4 桌面/视觉 | #20(Overlay 原生标题栏·已修) #22(关闭钮·已修) #21(已修) #6(性能·待真机profile) | ✅ 大部完成 |
| B5 补充 | #11(下拉刷新) | ⏳ 独立小项 |

> 已提交：`3eb2ad0..dc44bc1` 六笔（upic 头像 / F0 cid / 前端体验批 / Android 壳 / 桌面启动页 / 文档）。
> #14 一期推进（用户开工 + 会话补完）：专辑数据层/导入/播放/歌词/详情 UI 模拟器全链路 ✅；会话内修复 DetachedInstance、albumRequest 端点对齐、MediaPlaybackService 包名错位。
> 后续计划详见 `docs/next-steps.md`。

## H. 修复进度勾选

- [x] #1 返回语义（Web 层 + Android 壳桥接，模拟器全过）｜ [x] #2 系统栏（方案 A+B 沉浸全落地）｜ [x] #17 路由 ｜ [x] #20 无边框（Overlay 原生方案定稿）
- [x] #3 第一段（前台服务+通知；Session/锁屏/蓝牙待做）｜ [ ] #4 全量音频焦点 ｜ [x] #18 浏览器登录兜底（真机浏览器完整登录待抽查）
- [x] #8 空格 ｜ [x] #15 按钮序 ｜ [x] #19 音量填充 ｜ [x] #12 省略（title 全文）｜ [x] #13 滚动 ｜ [x] #16 蓝框 ｜ [x] #7 建歌单
- [x] #9 品牌启动（双端） ｜ [x] #5 轮询 ｜ [ ] #6 性能 ｜ [ ] #11 下拉刷新
- [x] #14 专辑一期（主体；B 站取消收藏/懒物化/series 待做） ｜ [x] #10 歌词源·重试换源部分（网易云源待做）
- [x] #21 歌词对比度 ｜ [x] #22 关闭钮（hover 显现）
- [x] F0 cid 流路由

> 批次记录：**B0 快赢批 + #1 + #5 + #17 + #21 + #9(桌面) 已于 2026-09-08 完成编码，浏览器 + Android 15 模拟器（BM35 AVD）双端验收**（详见 acceptance-manual §9）；#2 为下一个 P0，实体真机抽查建议随 #2 一起做。
