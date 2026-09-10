# BiliMusic 前端 PRD（重设计版）

> 版本：v1.0（对齐代码 v1.0.2）｜ 状态：草案
> 依据：`app/api/routes.py`、`app/web/routes.py`、`app/main.py`、`app/db/models.py`、`app/config.py`、`docs/bugs.md`、`docs/v0.5.0-prd.md`、`README.md`、`app/web/static/*.js`、`app/web/templates/**`
> 用途：① 说清后端已经给前端开了哪些接口；② 说清重新设计前端需要哪些功能；③ 说清哪些接口还缺、需要后端配合。
> 设计稿（静态原型，无构建）：`rebuild_frontend/`——`cd rebuild_frontend && python3 -m http.server 8001` 后用浏览器打开。

---

## 0. 这份文档回答什么

| 问题 | 章节 |
|---|---|
| 后端给前端开了哪些接口？ | §3 接口总览、§4 接口契约详解 |
| 每个接口返回什么字段、什么错误？ | §4.13 数据字典、§4.1 通用约定 |
| 重新设计前端需要哪些功能？ | §5 功能需求、§6 信息架构 |
| 前端状态怎么管、怎么和 SSE 对齐？ | §7 状态与数据流 |
| 现有接口够不够支撑重设计？缺什么？ | §4.14 接口缺口清单、§9 技术选型 |
| 有哪些已知坑必须绕开？ | §11 已知缺陷与风险 |

---

## 1. 产品定位与设计原则

**一句话**：把 B 站里的音乐，放进自己的播放器。

| 维度 | 结论 | 来源 |
|---|---|---|
| 对标 | YouTube Music（不是 Spotify 的曲库逻辑，是 YT 的「视频即音源」逻辑） | 项目决策 |
| 目标用户 | 个人 / 小圈子，自建部署，同一局域网多设备 | README |
| 目标 | 「最好用的 B 站音乐播放器」，不是版权曲库替代品 | 项目决策 |
| 优先端 | 移动优先（手机浏览器 + Android APK），桌面为第二优先 | 项目决策 |
| 数据主权 | **曲库以 B 站收藏夹为准确数**，本地库是镜像；收藏/取消收藏直接作用于 B 站账号 | BUG-004、v0.5.0 §3.6 |
| 播放形态 | 纯在线流媒体（后端代理 B 站 CDN），**不做离线下载/本地曲库** | README、`_migrate_to_streaming` |
| 登录 | 扫码登录（v1.0.1 起下线短信登录），凭据存本机 `data/` | BUG-002、FEAT-001 |

### 设计原则（重设计时不要违背）

1. **B 站是唯一真相源**。任何「收藏/取消收藏/删歌/删专辑/删歌单」都必须能在 B 站侧找到对应语义（收藏夹 / 视频收藏）。前端文案与二次确认要体现这一点。
2. **视频级 vs 曲目级**。一个多 P 视频在 B 站算 1 条收藏，在本地是 N 行曲目（`collected` 逐行标记）；一个系列（series）是多个独立视频，每个视频各收藏一次。计数、删除、收藏三处语义必须一致（BUG-004 的根因就是这里没对齐）。
3. **操作即时反馈 + 后台自愈**。删除/同步/导出失败不阻塞本地，失败进后台对账；前端要做「乐观更新 + 失败回滚」。
4. **不引入构建链是现状，不是约束**。重设计可以换栈，但要评估 §9 的成本。
5. **风控敏感**。B 站接口有频控/风控，前端不要做「逐条并发轮询」「一屏内批量打接口」这类动作；批量能力由后端限速承担。

---

## 2. 系统架构与前端边界

```
┌────────────────────────────────────────────────────────────┐
│ 前端（浏览器 / Tauri WebView / Android WebView）            │
│  现状：Jinja2 SSR + htmx + 原生 JS（app.js / v3.js）        │
└───────────────┬────────────────────────────┬───────────────┘
                │ JSON API /api/*            │ HTML 片段 /partials/*
                │ SSE /api/events            │ 表单 POST /web/*
┌───────────────▼────────────────────────────▼───────────────┐
│ 单进程 FastAPI（app/main.py）                                │
│  ├ 中间件：account_scope（按账号隔离）+ 缓存头                 │
│  ├ /api/*      JSON，需 B 站登录态（/api/auth/* 除外）        │
│  ├ /partials/* HTML 片段（htmx）                             │
│  ├ /web/*      表单动作，返回 HTML 或纯文本                    │
│  ├ /api/stream/{bvid}  音频流代理（Range/206）                │
│  └ /static/*   CSS/JS/图标                                    │
│ 服务：BiliClient（WBI 签名）/ Importer / Syncer / Exporter /  │
│       Lyrics / Recs / Zone / Accounts                        │
│ 存储：SQLite（data/accounts/<mid>/bilimusic.db）+ data/cookies.json        │
└─────────────────────────────────────────────────────────────┘
```

> 桌面与 Android 是**嵌入式**形态：壳进程拉起后端 → 后端在回环随机端口监听并打印 `BILIMUSIC_URL=` → 壳轮询 `/openapi.json` 就绪后导航。前端不要硬编码 `:8000`（详见 §14 附录 A）。

### 运行与配置（`app/config.py`）

| 环境变量 | 默认 | 对前端的影响 |
|---|---|---|
| `BM_HOST` / `BM_PORT` | `0.0.0.0` / `8000` | 前端 base URL；局域网手机访问需 0.0.0.0 |
| `BM_DATA_DIR` | `./data` | 数据库/凭据/封面缓存位置 |
| `BM_API_TOKEN` | 空 | 非空时 `/api/*` 需 `Authorization: Bearer <token>`；`<audio src>` 可用 `?token=` 附带 |
| `BM_ALLOW_ORIGINS` | `*` | CORS 白名单，逗号分隔 |

### 三层鉴权

| 层 | 规则 | 失败表现 |
|---|---|---|
| Token（可选） | `BM_API_TOKEN` 非空时校验 Bearer 或 `?token=` | `401 {"detail":"无效的 API Token"}` |
| B 站登录态 | 除 `/api/auth/*` 外全部要求已扫码登录 | `401 {"detail":"需要先扫码登录 B 站账号"}` |
| 页面级 | `/` 未登录也渲染骨架，操作时弹登录弹窗；htmx 请求返回 401 JSON，整页导航 307 跳 `/?login=1`。登录态另由 SSR 注入 `body[data-auth][data-mid]` 供 JS 直接读 | `_login_redirect()`、`base.html:23` |

### 中间件行为（重设计必须知道）

- `/api/*` 响应统一加 `Cache-Control: no-store`（曲库/收藏状态必须实时）。
- `/static/*` 加 `Cache-Control: no-cache`（配合 `?v=NN` 查询串做版本化）。
- `/api/stream/*` **不设缓存头**（保留 Range 语义，利于 WebView 渐进缓冲）。
- 每个请求按当前账号 `mid` 绑定数据库与客户端（`account_scope`），多账号互不串扰。

---

## 3. 接口总览

后端共 **3 组接口面**：JSON API（`/api/*`）、htmx HTML 片段（`/partials/*`）、表单动作（`/web/*`）。

### 3.1 JSON API（`/api/*`）

| # | 方法 | 路径 | 用途 | 需登录 |
|---|---|---|---|---|
| 1 | POST | `/api/auth/qrcode` | 生成登录二维码 | 否 |
| 2 | GET | `/api/auth/qrcode/{qrcode_key}` | 轮询扫码状态 | 否 |
| 3 | GET | `/api/auth/captcha` | 极验参数（短信登录，**已下线**） | 否 |
| 4 | POST | `/api/auth/sms/send` | 发验证码（已下线） | 否 |
| 5 | POST | `/api/auth/sms/login` | 短信登录（已下线） | 否 |
| 6 | GET | `/api/auth/status` | 登录态 + 昵称 + 音质 | 否 |
| 7 | DELETE | `/api/auth` | 退出登录 | 否 |
| 8 | POST | `/api/auth/logout` | 退出登录（网页用） | 否 |
| 9 | POST | `/api/imports` | 单视频导入 | 是 |
| 10 | POST | `/api/imports/batch` | 智能批量导入（收藏夹/系列/单视频） | 是 |
| 11 | GET | `/api/imports` | 最近 50 条导入任务 | 是 |
| 12 | GET | `/api/imports/{task_id}` | 单个任务进度 | 是 |
| 13 | GET | `/api/songs` | 曲库列表（搜索/按歌单） | 是 |
| 14 | GET | `/api/songs/{id}` | 单曲详情 | 是 |
| 15 | GET | `/api/songs/{id}/cover` | 封面图（http 封面 302 到 CDN） | 是 |
| 16 | GET | `/api/songs/{id}/lyrics` | 取歌词（懒抓 + 缓存） | 是 |
| 17 | POST | `/api/lyrics/preview` | 未入库曲目试听取词 | 是 |
| 18 | POST | `/api/songs/{id}/collect` | 合集子作品入库（星标） | 是 |
| 19 | POST | `/api/songs/{id}/uncollect` | 合集子作品移出曲库 | 是 |
| 20 | DELETE | `/api/songs/{id}` | 删歌（并尝试取消 B 站收藏） | 是 |
| 21 | GET | `/api/albums` | 专辑/合集列表 | 是 |
| 22 | GET | `/api/albums/{id}` | 专辑详情 | 是 |
| 23 | GET | `/api/albums/{id}/songs` | 专辑曲目（含 hasMore） | 是 |
| 24 | POST | `/api/albums/{id}/materialize` | 懒物化补建分 P 曲目 | 是 |
| 25 | DELETE | `/api/albums/{id}` | 删专辑/合集（同步取消收藏） | 是 |
| 26 | DELETE | `/api/albums/{id}/songs/{song_id}` | 专辑内移除单曲（仅本地） | 是 |
| 27 | GET | `/api/playlists` | 歌单列表 | 是 |
| 28 | POST | `/api/playlists` | 新建歌单 | 是 |
| 29 | PATCH | `/api/playlists/{id}` | 改名（同步 B 站夹名） | 是 |
| 30 | DELETE | `/api/playlists/{id}` | 删歌单（歌曲移入默认） | 是 |
| 31 | GET | `/api/playlists/{pid}/covers` | 歌单封面素材（最多 4 张） | 是 |
| 32 | GET | `/api/playlists/{pid}/share-link` | 歌单对应的 B 站收藏夹分享链接 | 是 |
| 33 | POST | `/api/sync` | 触发双向对账同步 | 是 |
| 34 | GET | `/api/sync/{sync_id}` | 同步进度 | 是 |
| 35 | GET | `/api/events` | SSE：曲库/歌单变更推送 | 是 |
| 36 | GET | `/api/search` | B 站站内搜索（视频） | 是 |
| 37 | POST | `/api/exports` | 导出/补收藏任务 | 是 |
| 38 | GET | `/api/exports/{export_id}` | 导出进度 | 是 |
| 39 | POST | `/api/exports/status` | 导出进度（静态路径 + body） | 是 |
| 40 | POST | `/api/recs/seed` | 以当前歌为种子采集推荐 | 是 |
| 41 | GET | `/api/recs` | 推荐池（今日/按风格） | 是 |
| 42 | DELETE | `/api/recs/{bvid}` | 不感兴趣 | 是 |
| 43 | GET | `/api/stream/{bvid}` | 音频流代理（Range/206） | 是 |

### 3.2 HTML 片段（`/partials/*`，htmx 用）

| 方法 | 路径 | 参数 | 渲染内容 |
|---|---|---|---|
| GET | `/partials/playlists` | `mode=rack` | 歌单卡片（rack=主页海报架，不含「全部歌曲」伪卡） |
| GET | `/partials/songs` | `q`、`playlist_id`、`artist` | 曲库列表行 |
| GET | `/partials/up-list` | — | 曲库内 UP 主清单（含计数与代表 bvid） |
| GET | `/partials/tasks` | — | 导入任务列表；有新入库时返回 `HX-Trigger: refreshSongs` |
| GET | `/partials/rec-playlists` | — | 推荐歌单架（每日精选 + 电台 + 风格精选，封面 4 宫格拼贴） |
| GET | `/partials/recommend-shelves` | — | 推荐页横向货架（每货架 15 张卡） |
| GET | `/partials/rec-genre-tracks` | `genre=daily\|rank\|nl3\|s-*\|风格名`、`layout=rows\|cards\|dcols` | 推荐曲目表 / 大封面横滑卡 |
| GET | `/partials/genre-shelves` | — | 首页流派货架（池子优先、搜索补位、跨货架去重） |
| GET | `/partials/up` | `mid`、`pn`、`name` | UP 主投稿列表（首屏 TOP10 + 分页；接口被风控时降级为搜索过滤） |
| GET | `/partials/recent` | — | 最近收藏架（8 首） |
| GET | `/partials/albums` | — | 专辑/合集卡片 |
| GET | `/partials/album-tracks` | `album_id` | 专辑曲目表 |
| GET | `/partials/web-search` | `q` | 站内搜索下拉（视频 + UP 主；带 5 分钟缓存） |
| GET | `/partials/search-detail` | `q` | 搜索详情页（UP 主 / 合集 / 歌曲 三分类） |
| GET | `/partials/recs` | `genre`、`mode=today` | 发现板块列表 |

### 3.3 表单动作（`/web/*`）

| 方法 | 路径 | 表单字段 | 返回 |
|---|---|---|---|
| POST | `/web/playlists/create` | `name` | 纯文本 `ok` / 400 错误文案 |
| POST | `/web/playlists/rename` | `id`、`name` | 同上 |
| POST | `/web/playlists/delete` | `id` | `ok <移动的歌曲数>` |
| POST | `/web/playlists/add-song` | `song_id`、`playlist_id` | `ok` |
| POST | `/web/import` | `url`、`playlist_id` | 任务列表 HTML + `HX-Trigger: refreshSongs` |
| POST | `/web/sync` | — | 任务列表 HTML + `HX-Trigger: refreshSongs` |
| POST | `/web/collect-album` | `bvid` | JSON `{ok, albumId, title, totalPages}`（最多等 ~20s 容器出现） |
| POST | `/web/recs/dismiss` | `bvid` | `ok` |
| GET | `/web/up/resolve` | `bvid` 或 `mid` | JSON `{mid,name,face,hue}`（hue=头像主色，供配色） |

### 3.4 页面

| 路径 | 说明 |
|---|---|
| `GET /` | 主界面（`library.html`）：曲库 + 歌单 + 发现 + 播放器，未登录也渲染骨架 |
| `GET /library` | 307 → `/` |
| `GET /login` | 307 → `/?login=1`（登录已改为全局弹窗） |
| `GET /docs` | FastAPI 自动 OpenAPI 文档（仅 JSON API，不含 `/partials/*`） |

---

## 4. 接口契约详解

### 4.1 通用约定

- **Base URL**：`http://<host>:<port>`，JSON 前缀 `/api`。
- **请求体**：`application/json`（`/web/*` 是 `application/x-www-form-urlencoded`）。
- **成功**：HTTP 200/201/202 + JSON 对象；`202` 表示「已受理，需轮询」。
- **失败**：FastAPI 标准 `{"detail": "<中文文案>"}`。常见码：
  - `400` 参数/语义错误（bvid 格式、cid 不匹配、歌单名超长、歌单不存在于 B 站夹池）
  - `401` 未登录 / token 无效
  - `404` 资源不存在（歌曲/专辑/歌单/任务）
  - `409` 歌单还没同步到 B 站收藏夹（分享链接）
  - `502` B 站接口/CDN 失败（`detail` 为可展示文案）
- **分页现状（重要）**：除 `/api/search?page=` 与 `/partials/up?pn=` 外，**所有列表接口都没有分页**。曲库 `/api/songs` 硬上限 **500 条**，推荐池 `/api/recs` 上限 **500 条**，导入任务 `/api/imports` 只回最近 **50** 条。重设计若要「全量曲库 + 虚拟滚动」，需要后端加游标分页（见 §4.14）。
- **时间**：ISO8601 字符串（`createdAt` / `expiresAt`）。
- **时长**：`duration` 为秒（int）；`durationText` 为 `m:ss` / `h:mm:ss`（搜索与推荐接口才有）。
- **音频地址**：`song.audioUrl` 已由后端拼好（含 `?cid=`），前端直接丢给 `<audio>`；封面 `coverUrl` 同理（`http(s)` 直连 CDN，否则走 `/api/songs/{id}/cover`）。
  > ⚠️ 启用 `BM_API_TOKEN` 时 `audioUrl` **不带** `?token=`（只有 `coverUrl` 带），`<audio>` 无法发 Authorization 头 → 播放 401。见 §11 D-7。

### 4.2 登录（`/api/auth/*`，免登录门禁）

**POST `/api/auth/qrcode`** → 
```json
{ "qrContent": "https://...", "qrPngDataUrl": "data:image/png;base64,...",
  "qrcodeKey": "abc", "matrix": [[1,0],...], "modules": 33 }
```
- `qrPngDataUrl` 直接给 `<img>`；`matrix`+`modules` 是给原生端自己画二维码用的。
- 前端应在拿到后立即开始轮询，并在 ~120s 后展示「已过期，点击刷新」。

**GET `/api/auth/qrcode/{qrcode_key}`** → `{"status": "pending|scanning|confirmed|expired|..."}`
- 只有 `confirmed` 会触发后端账号激活（写库、建默认歌单）。
- 轮询节奏建议 1.5~2s；`confirmed` 后必须再调 `/api/auth/status` 确认。

**GET `/api/auth/status`** → `{"loggedIn": true, "username": "昵称", "maxQuality": "192K|64K"}`

**DELETE `/api/auth`** / **POST `/api/auth/logout`** → `{"ok": true}`

> 短信登录端点（`captcha` / `sms/send` / `sms/login`）**已下线**，重设计不要接。

### 4.3 导入

**POST `/api/imports`**（单视频）
```json
请求 { "url": "<B站链接或完整分享文本>", "playlistId": 0 }
响应 202 { "importId": "a1b2c3..." }
```

**POST `/api/imports/batch`**（智能提交，推荐前端只用这一个）
```json
请求 { "url": "...", "playlistId": 0 }
响应 202 三种形态：
  单视频  { "mode": "single", "importId": "xxx" }
  收藏夹  { "mode": "batch", "folderTitle": "bilimusic", "total": 30, "importIds": ["..."] }
  系列    { "mode": "series", "importId": "xxx", "importIds": ["xxx"], "total": null }
```
- 识别：收藏夹明链（`favlist?fid=`）、系列明链（`channel/collectiondetail?sid=`）、任意含 fid/sid 的文本、`b23.tv` 短链（后端跟随跳转）。
- 收藏夹单次上限 **200** 条（`_FAV_CAP`）。
- 未公开收藏夹会 400：`收藏夹为空、不存在或未公开（未公开收藏夹需要先在「账号」页扫码登录）`。

**GET `/api/imports`** → `{"tasks": [task, ...]}`（最近 50，新在前）
**GET `/api/imports/{task_id}`** → `task`

### 4.4 曲库

**GET `/api/songs?q=&playlist_id=`** → `{"songs": [song, ...]}`
- `q` 标题/歌手模糊匹配；`playlist_id=0` 表示全部。
- 默认只返回 `collected=1` 的曲目（合集容器内未收藏的子作品不出现）。
- **上限 500，无分页**。

**GET `/api/songs/{id}`** → `song`

**GET `/api/songs/{id}/cover`** → 图片二进制；封面为在线 URL 时 302 到 CDN。
> ⚠️ 该分支代码有缺陷（`RedirectResponse` 未导入 → NameError/500），见 §11 D-1。

**GET `/api/songs/{id}/lyrics?force=0`** → `{"lyrics": "<LRC 或纯文本>|null", "source": "cc|lrclib|ai|null"}`
- 首次访问懒抓（B 站字幕 + LRCLIB）并落库；取不到返回 `null` 并打标不再重试。
- `force=1` 清缓存重抓（前端「重试」按钮用）。

**POST `/api/lyrics/preview`** → `{"lyrics", "source"}`
```json
请求 { "bvid": "BV...", "title": "", "artist": "", "duration": 0 }
```
- 用于推荐/搜索里「试听未入库曲目」时的歌词，不落库。

**POST `/api/songs/{id}/collect?playlist_id=0`** → `{"ok": true, "song": song}`
- 合集子作品星标入库；series 容器会后台触发该视频的 B 站收藏（视频级）。

**POST `/api/songs/{id}/uncollect`** → `{"ok": true}`
- paged：只动本地；series：该视频退出曲库 + 取消 B 站收藏（同视频其他分 P 一起退，目录行保留）。

**DELETE `/api/songs/{id}`** → `{"ok": true}`
- 删歌 + 尝试取消 B 站收藏（失败不阻塞本地，登记后台自愈）。

### 4.5 专辑 / 合集容器

| 接口 | 响应要点 |
|---|---|
| `GET /api/albums` | `{"albums": [album]}`，按创建时间倒序 |
| `GET /api/albums/{id}` | `album` |
| `GET /api/albums/{id}/songs` | `{"songs": [...], "hasMore": bool, "materializedPages": n}` |
| `POST /api/albums/{id}/materialize` | 同上；paged 专辑按需补建缺失分 P 行，series 直接返回现有行 |
| `DELETE /api/albums/{id}` | `{"ok": true}`；paged=取消该视频收藏一次，series=逐视频批量取消（失败自愈） |
| `DELETE /api/albums/{id}/songs/{song_id}` | `{"ok": true}`，仅本地移除 |

- `album.kind`：`"paged"`（多 P 视频）/ `"series"`（跨视频合集）。
- `sourceBvid`：paged 是 bvid，series 是 `sid:<id>`。
- series 的 `track_no` 按分 P 累计、`total_pages` 是视频数，**两者不同刻度**（前端别拿它们做百分比）。
- 懒物化：超大合集导入时只建起始分 P，前端滚动到底再调 `materialize`。

### 4.6 歌单

| 接口 | 说明 |
|---|---|
| `GET /api/playlists` | `{"playlists": [{"id","name","folderIds":[...]}]}` |
| `POST /api/playlists` `{name}` | 201；名称 1~16 字；同步创建 B 站收藏夹 `bilimusic- <名>` |
| `PATCH /api/playlists/{id}` `{name}` | 改名并同步 B 站夹名 |
| `DELETE /api/playlists/{id}` | 202 `{"moved": n, "folders": n}`；歌曲移入默认歌单，B 站夹删除，收藏转移后台执行 |
| `GET /api/playlists/{pid}/covers` | `{"covers": ["url", ...]}`（最多 4 张，供 mosaic 封面） |
| `GET /api/playlists/{pid}/share-link` | `{"name","link","folderCount"}`；`pid=0` = 主夹；夹池未建立时 409 |

- 默认歌单名 `我的曲库`，不可删除；每个歌单可对应多个 B 站收藏夹（主夹满 2000 条自动开溢出夹）。

### 4.7 同步与实时事件

**POST `/api/sync`** → 202 `syncState`
```json
{ "id": "xxx", "status": "running|done|failed",
  "folders": n, "adopted": n, "pulled": n, "pushed": n,
  "removed": n, "dropped": n, "backfilled": n,
  "error": null, "failures": [ ... ] }
```
- 双向对账：拉取（B 站夹 → 本地导入，以导入任务形式出现）+ 推送（本地 → 补收藏）。
- 已有进行中的同步时**幂等返回当前状态**。

**GET `/api/sync/{sync_id}`** → 同上；404 表示任务已不存在（内存态，重启即失效）。

**GET `/api/events`**（SSE）
```
retry: 3000

event: libraryChanged
data: libraryChanged

event: playlistsChanged
data: playlistsChanged

: ping        ← 15s 无事件时的心跳
```
- 事件名只有两个：`libraryChanged`（曲库增删）、`playlistsChanged`（歌单增删改）。
- 按账号 mid 过滤，多账号不串扰。
- 前端订阅后即可「免手动刷新」；断线由浏览器按 `retry: 3000` 自动重连。

### 4.8 搜索

**GET `/api/search?q=<关键词>&keyword=<别名>&page=1`** →
```json
{ "keyword": "xxx",
  "results": [{ "bvid", "avid", "title", "artist", "duration", "durationText",
                "coverUrl", "play", "importUrl" }] }
```
- WBI 签名综合搜索，**仅视频分区**；`q` 与 `keyword` 等价。
- 没有 `total`，没有 UP 主结果（UP 主搜索只在 SSR 的 `/partials/web-search` 里）。
- 结果可直接把 `importUrl` 提交 `/api/imports/batch` 导入。

### 4.9 导出 / 分享

**POST `/api/exports`** → 202 `{"exportId","total","status"}`
**GET `/api/exports/{export_id}`** / **POST `/api/exports/status` `{exportId}`** →
```json
{ "id", "status": "pending|syncing|done|failed", "total", "done",
  "folderTitle", "link": "https://space.bilibili.com/<mid>/favlist?fid=xxx",
  "error", "failures": [...] }
```
- `exportId` 必须 12 位小写 hex（`/exports/status` 有正则校验）。

### 4.10 推荐

**POST `/api/recs/seed` `{songId}`** → 202 `{"queued": true}`（起播搭车调用，服务端频控：同种子 7 天内不重复、全局最小间隔 10 分钟、每日上限 20 次）

**GET `/api/recs?genre=&mode=today`** →
```json
{ "items": [{ "bvid", "title", "artist", "duration", "durationText",
              "coverUrl", "genre", "seedBvid", "expiresAt" }] }
```
- `mode=today` = 今日推荐（按日期+ bvid 确定性挑选，当天刷新不变）；否则按 `genre` 过滤。
- 风格键（`recs.GENRE_KEYWORDS`）：古典 / 摇滚金属 / R&B / 蓝调 / 华语流行 / hiphop / 力量 / 古风 / 静心 / 网络音乐。
- 推荐池只存元数据，播放走 `/api/stream/{bvid}`；7 天过期懒清理。

**DELETE `/api/recs/{bvid}`** → `{"ok": true}`

### 4.11 媒体流

**GET `/api/stream/{bvid}?cid=<可选>&token=<可选>`**

| 情况 | 响应 |
|---|---|
| 正常 | `200/206`，`audio/mp4`，透传 `content-length` / `content-range` / `accept-ranges` |
| `Range` 请求 | 转发上游 206（进度拖动、WebView 渐进缓冲依赖它） |
| bvid 格式错 | `400 {"detail":"bvid 格式错误"}` |
| cid 不属于该视频 | `400 {"detail":"cid 与该视频不匹配"}` |
| B 站解析失败 | `502`（detail 可展示） |
| CDN 拒绝 | `502 {"detail":"B 站 CDN 拒绝了播放请求"}` |

- 请求头固定带 `Referer: https://www.bilibili.com`，直链经白名单校验（仅放行 B 站 CDN）。
- **多分 P 必须带 `cid`**，否则播成 P1（项目历史 bug）。`song.audioUrl` 已自动带上。

### 4.12 SSR 片段与表单（重设计时的取舍）

`/partials/*` 与 `/web/*` 是**为 htmx 服务端渲染链路**准备的，返回 HTML 或纯文本：

- 优点：无构建链、首屏快、SEO 无关紧要时够用。
- 缺点：数据与视图耦合在 Jinja2 模板里，前端无法复用状态；同一份数据（曲库、歌单、专辑）在 JSON API 和模板里各写一遍，容易漂移。
- **重设计建议**：新前端只依赖 `/api/*`；`/partials/*` 与 `/web/*` 保留给旧页面/兼容期，不迁入新栈。若坚持 SSR+htmx，则把 `/partials/*` 当作事实接口（下表即契约），并接受 `HX-Trigger: refreshSongs` 这类隐式约定。

### 4.13 数据字典

**song**（`song_out`）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 本地主键 |
| `bvid` | str | B 站视频号 |
| `title` / `artist` | str | 标题 / UP 主名（当歌手用） |
| `duration` | int | 秒 |
| `qualityId` / `qualityLabel` | int / str | 0=在线；否则音质标签（如 192K） |
| `audioUrl` | str | `/api/stream/{bvid}?cid=...` |
| `coverUrl` | str | CDN 或 `/api/songs/{id}/cover` |
| `coverColor` | str | 封面主色 `#rrggbb`（无封面时由 bvid 哈希派生，恒定） |
| `aid` | int | av 号（收藏夹导出用） |
| `playlistId` | int | 所属歌单，0=默认 |
| `favFolderId` | int | 所在 B 站收藏夹 media_id |
| `albumId` | int | 所属专辑/合集，0=单曲 |
| `collected` | bool | 是否在曲库（合集子作品默认 false） |
| `createdAt` | str | ISO8601 |

**task**（`task_out`）
`id`、`sourceUrl`、`status`（pending/resolving/downloading/ready/failed）、`statusLabel`（中文）、`progress`（0-100）、`error`、`songId`、`song`（成功后内嵌完整 song）、`createdAt`

**album**（`_album_out`）
`id`、`kind`（paged/series）、`sourceBvid`、`title`、`artist`、`coverUrl`、`totalPages`、`materializedPages`

**playlist**：`id`、`name`、`folderIds`（B 站收藏夹 id 数组）

**rec**：`bvid`、`title`、`artist`、`duration`、`durationText`、`coverUrl`、`genre`、`seedBvid`、`expiresAt`

**searchHit**：`bvid`、`avid`、`title`、`artist`、`duration`、`durationText`、`coverUrl`、`play`、`importUrl`

**syncState** / **exportState**：见 §4.7 / §4.9

### 4.14 接口缺口清单（重设计前需要后端补的）

按对前端体验的影响排序：

| # | 缺口 | 现状 | 建议接口 | 优先级 |
|---|---|---|---|---|
| G-1 | **曲库分页** | `/api/songs` 上限 500，无游标 | `GET /api/songs?cursor=&limit=` + `nextCursor` | P0 |
| G-2 | **曲库排序/筛选** | 只有 `q` 与 `playlist_id` | `sort=createdAt\|title\|artist\|duration`、`order=`、`artist=` | P0 |
| G-3 | **队列跨端** | 队列已本地持久化（`bmSession:<mid\|guest>`），但换设备/换浏览器丢失 | 由 `docs/issue-ledger.md` **#23** 覆盖（会话上移服务端） | P1 |
| G-4 | **播放进度 / 最近播放** | 无接口，无法跨端续播 | 由 `docs/issue-ledger.md` **#23** 覆盖（Phase 1 完成即关闭） | P1 |
| G-5 | **智能过渡分析接口缺失** | `app.js:706` 调 `POST /api/songs/analysis`，后端**没有这个路由**；但调用被 `smartEnabled()` 恒 `false` 短路，当前不会触发 404 | 二选一：删除死代码与宣传文案，或补路由（`app/analysis/` 有算法，但纯在线播放无本地音频可分析） | P2（现状不影响用户） |
| G-6 | **批量操作** | 无批量删除/批量加歌单 | `POST /api/songs/batch`（delete/move） | P1 |
| G-7 | **搜索补全** | `/api/search` 无 UP 主、无 total、无合集标记 | `GET /api/search/all`（视频+UP+合集，带 `pages`/`albumId`） | P1 |
| G-8 | **B 站收藏夹浏览** | 只能同步，不能直接浏览 B 站原始收藏夹 | `GET /api/fav-folders`、`GET /api/fav-folders/{id}/videos` | P2 |
| G-9 | **歌词增强** | 只有原文 LRC | 翻译/罗马音字段 | P2 |
| G-10 | **账号资料/统计** | `/api/auth/status` 只有 username | `GET /api/me`（头像、mid、曲库统计） | P2 |
| G-11 | **操作审计/错误中心** | `failures` 散落在 sync/export 里 | 统一 `GET /api/jobs`（导入/同步/导出/分析） | P2 |

---

## 5. 功能需求（重设计要做什么）

> 优先级：**P0** = 没有它产品不成立；**P1** = 体验完整必需；**P2** = 加分项。
> 每个功能域给出「必备能力 / 依赖接口 / 验收点」。

### 5.0 功能域地图

```
账号登录 ─┬─ 曲库（列表/搜索/排序/批量）
          ├─ 歌单（增删改/加歌/分享）
          ├─ 专辑与合集（paged/series、星标、懒物化）
          ├─ 导入（单/收藏夹/系列 + 任务进度）
          ├─ 发现（每日精选/电台/风格货架）
          ├─ 搜索（曲库内 + B站站内 + UP 主）
          └─ 播放器（队列/歌词/后台/媒体会话）
                 └─ 同步对账（手动/自动 + SSE 免刷新）
                        └─ 设置（主题/音质/账号/关于）
```

### 5.1 账号与登录（P0）

**必备能力**
1. 扫码登录弹窗：二维码渲染（`qrPngDataUrl`）、倒计时、过期刷新、扫码中/已确认状态文案。
2. 移动端登录路径：点二维码 → 存相册（Android 原生桥 `saveQrToGallery`）→ 拉起 B 站 App（`openBilibiliApp`）；浏览器/桌面回退为下载 PNG。
3. 登录态展示：头像 + 昵称 + 当前音质（`maxQuality`）；登录态过期时全局降级（弹登录而不是报错）。
4. 退出登录：清本地缓存（曲库/队列/歌词），回落到未登录骨架。
5. 多账号：后端按 mid 隔离数据，前端至少不要缓存跨账号数据。

**依赖接口**：`POST /api/auth/qrcode`、`GET /api/auth/qrcode/{key}`、`GET /api/auth/status`、`POST /api/auth/logout`

**验收点**：未登录打开首页能看到骨架并弹登录；扫码确认后 3s 内曲库出现；退出后本地无残留曲目。

### 5.2 曲库（P0）

**必备能力**
1. 列表：封面 / 标题 / UP 主 / 时长 / 音质 / 所属歌单 / 专辑入口（`albumId>0` 时显示「进专辑」）。
2. 搜索框：曲库内实时搜索（`q`），空结果空态。
3. 排序与筛选（**需后端补 G-2**）：按收藏时间 / 标题 / UP 主 / 时长；按歌单筛选。
4. 分页或虚拟滚动（**需后端补 G-1**，现状 500 上限）。
5. 行内操作：播放、加入歌单、星标/移出曲库（`collect`/`uncollect`）、删除（二次确认，文案提示会同步取消 B 站收藏）。
6. 计数口径：与 B 站收藏夹一致——**收藏单曲 1 条 + 合集容器 1 条**（BUG-004）。
7. 乐观更新 + 失败回滚：删歌/星标先改 UI，失败恢复并 Toast。

**依赖接口**：`GET /api/songs`、`POST /api/songs/{id}/collect|uncollect`、`DELETE /api/songs/{id}`、`GET /api/events`

**验收点**：删歌后列表立即消失且 B 站收藏减少；SSE 收到 `libraryChanged` 后无需刷新即更新。

### 5.3 播放器（P0，核心）

**必备能力**
1. 基本控制：播放/暂停、上一首/下一首、进度拖动、音量、静音。
2. 播放模式：顺序 / 单曲循环 / 随机 / 列表循环（现状已存 `bmPlayMode`、`bmRepeatOne`）。
3. 队列：当前队列面板、跳到指定曲、清空、从列表「下一首播放」。
4. 音源：`<audio>` 直接吃 `song.audioUrl`；**多分 P 必须带 cid**（`audioUrl` 已含）；支持 `Range` 拖动。
5. 错误处理：`502` / 音频 `error` 事件 → 跳过或提示「视频可能已失效」（README 明确该提示不代表下架）。
6. 媒体会话：`navigator.mediaSession` 元数据 + `previoustrack`/`nexttrack` 动作；移动端锁屏/通知栏卡片。
7. 后台播放：Android WebView 需原生层配合（现状由原生内核承担，见 §5.13）。
8. 预加载与切歌：现状有双 `<audio>`（`audio` + `audio2`）+ WebAudio gain 图，但**智能过渡/交叉淡入已停用**——`app.js:602` 的 `smartEnabled()` 恒返回 `false`（注释：「纯在线版已停用（依赖本地音频分析）」）。重设计要么保留双元素做无感切歌，要么明确砍掉这条路径。
9. 推荐采集搭车：起播后调 `POST /api/recs/seed {songId}`（失败静默）。

**依赖接口**：`GET /api/stream/{bvid}`、`POST /api/recs/seed`、`GET /api/songs/{id}/lyrics`

> ⚠️ **现状最大移动端缺口**：≤900px 断点下 `.p-time`、`#seek`、`#player-artist` 全部 `display:none`（`style.css:955-965`）——手机底部播放条**没有进度条、没有歌手名**，拖进度必须先进歌词页。移动优先产品不能这样，重设计必须把「进度 + 歌手 + 封面 + 三键」放进 mini 条。

**验收点**：拖动进度不重新下载整首；多 P 曲目播的是对应分 P；切歌无爆音；锁屏可控；**手机 mini 条可直接拖进度**。

**现状缺口（重设计逐条修）**：① 播放模式入口只在歌词页，桌面播放条没有；② 单曲循环埋在队列面板里；③ 音量不持久化（每次回到 100）；④ 队列无拖拽排序、无「从队列移除」；⑤ 试听是独立 `Audio` 实例，与主播放器互斥（起试听会暂停主播放器）；⑥ 媒体会话未注册 `play`/`pause`/`seekto`；⑦ 进度有主/歌词两套实现。实现位置见 §15 B.1。

### 5.4 歌词（P0）

**必备能力**
1. 带轴 LRC 滚动高亮 + 点击某行跳转；无轴纯文本降级。
2. 来源标注（`cc` / `lrclib` / `ai`）；取不到时显示「暂无歌词」而不是空白。
3. 重试按钮（`force=1`）；试听未入库曲目走 `/api/lyrics/preview`。
4. 全屏歌词页：大封面 + 主色背景（`coverColor` / `hue`）+ 安全区适配。

**验收点**：老歌首次打开自动补齐歌词；`null` 时 5 秒内出空态而不是无限 loading。

### 5.5 歌单（P0）

**必备能力**：新建（≤16 字）/ 改名 / 删除（提示歌曲会移入默认歌单且删 B 站夹）/ 加歌 / 卡片（4 宫格 mosaic 封面 + 计数）/ 分享（`share-link`，未同步时给出可操作提示而非报错）。

**依赖接口**：`/api/playlists*`、`GET /api/playlists/{pid}/covers|share-link`

### 5.6 专辑与合集容器（P0）

**必备能力**
1. 卡片区分 `paged`（多 P 视频）与 `series`（跨视频合集）；计数文案：`N 首` vs `N 个作品`。
2. 详情页：曲目表、整张播放、随机播放、分享到 B 站（`sourceBvid`）。
3. 逐作品星标：空心 ↔ 实心，调 `collect`/`uncollect`；series 的星标是**视频级**（同视频多分 P 一起变化）。
4. 懒物化：滚到底触发 `POST /api/albums/{id}/materialize`，用 `hasMore` 判断。
5. 删除容器：明确提示会批量取消 B 站收藏（series）或取消该视频收藏（paged）。
6. 进度展示：导入任务按「分 P 数 / 作品数」区分文案。

**验收点**：星标只让计数 +1 而不是全量入库；删容器后 B 站收藏批量消失（本地已删）。

### 5.7 导入（P0）

**必备能力**
1. 统一输入框：粘贴视频/收藏夹/系列链接或分享文本，走 `/api/imports/batch`，按 `mode` 给出不同反馈（单曲/批量 N 条/系列）。
2. 任务列表：状态、进度条、失败原因、重试；`ready` 后自动刷新曲库（或靠 SSE）。
3. 导入目标歌单选择（`playlistId`）。
4. 错误可读化：未公开收藏夹、链接失效、风控限流都要有明确文案。
5. 风控友好：不要前端并发轮询单条任务；用 `/api/imports` 列表低频轮询 + SSE。

### 5.8 发现 / 推荐（P1）

**必备能力**：每日精选（当天稳定）、B 站音乐区电台（热歌榜 / 新上架 / 钢琴 / 吉他 / 翻唱 / 古风 / 爵士 / 电子）、风格货架（10 个风格键）、发现板块「刷新即换一批」、不感兴趣（`DELETE /api/recs/{bvid}`）、试听（`/api/stream` + `/api/lyrics/preview`）。

> 注意：SSR 里的「货架」由 `/partials/genre-shelves`、`/partials/recommend-shelves` 提供，JSON API 只有 `/api/recs`（池内数据）。重设计若只依赖 JSON API，**货架补位逻辑（池子不足时按风格搜索补位、跨货架去重）需要后端补接口或前端自行实现**。

### 5.9 搜索（P0）

**必备能力**
1. 双模搜索：输入是链接/BV 号 → 走导入；否则站内搜索。
2. 结果三分类（UP 主 / 合集 / 歌曲），合集项显示「已收藏则直接打开专辑」。
3. 结果操作：试听、收藏入库、打开 UP 主页。
4. UP 主页：投稿列表分页、首屏 TOP10、播放量格式化、头像主色背景。
5. 缓存与节流：同词 5 分钟内复用（后端已做），前端避免每键一搜。

**依赖接口**：`GET /api/search`（视频）、SSR `/partials/web-search|search-detail|up`（UP 主与合集标记，或等 G-7）

### 5.10 同步（P0）

**必备能力**
1. 手动同步按钮 + 进度（`status`、`pulled/pushed/removed/dropped/backfilled` 计数）。
2. 结果摘要可读化：「从 B 站拉取 N 首、补收藏 N 首、移除 N 首」。
3. 失败登记展示（`failures`），提供「稍后自动重试」的说明。
4. 打开即同步（现状已有）：进首页静默触发一次，不要打断用户。
5. 同步期间禁用重复提交（后端幂等，但前端也要给状态）。

### 5.11 设置（P1）

主题（亮/暗/跟随系统）、音质说明（`maxQuality` 取决于登录态）、默认歌单、清缓存（本地队列/歌词）、账号信息、关于与版本、错误诊断入口。

### 5.12 多端外壳（P1）

| 端 | 现状 | 重设计要做的 |
|---|---|---|
| 浏览器 | 响应式 + PWA（`manifest.json` + `sw.js`） | 保留 PWA；移动底部导航 + 桌面侧栏；安全区 `env(safe-area-inset-*)` |
| Tauri 桌面 | 内嵌后端；`capabilities/main.json` 只开放 `core:default` + 窗口最小化/最大化/关闭/拖动；依赖只有 `single-instance` / `open` / `reqwest` | **没有托盘、没有全局媒体键、没有系统媒体会话**——前端不要设计依赖它们的能力（要加需先扩 Tauri 侧）。窗口控制与单实例可继续用 |
| Android | 原生 WebView + Chaquopy 内置后端；播放内核是 **WebView 内的 HTML5 `<audio>`**，`MediaPlaybackService` 只镜像通知栏/媒体会话并回控页面 | 返回键与 back-stack 对齐、通知栏媒体卡片（沿用镜像方案或迁 Media3）、`saveQrToGallery` / `openBilibiliApp` 原生桥、WebView UA 伪装（BUG-002 教训） |

### 5.13 全局体验（P1）

- 空态/加载态/错误态三件套（每个列表、每个面板都要有）。
- Toast + 弹层统一（现状 `#toast`、`#login-modal`、`#export-modal`、`#queue-panel`、`#lyrics-panel`、`#up-panel`、`#song-menu`、`#mini-modal`）。
- 手势：移动端滑动返回（现状 `back-stack.js`）、下拉刷新。
- 主题：`bmTheme` 已存在，需扩为「跟随系统」。
- 可访问性：焦点管理、`aria-*`、`prefers-reduced-motion`（现状已尊重「减少动态效果」）。
- 断网/后端不可达：明确提示「后端未运行」，而不是笼统的「视频可能已失效」。

---

### 5.14 既有体验台账 → 功能映射（重设计必须内建）

`docs/acceptance-manual.md` 里以编号维护了一份「操作 → 期望」台账（`docs/issue-ledger.md` 被引用但仓库中不存在）。下面把每条编号翻译成前端需求，重设计时**不要丢**：

| # | 台账条目 | 重设计需求 | 端 |
|---|---|---|---|
| #1 | 返回语义 | 严格的 LIFO 层级栈（歌词页 → 队列 → 弹窗逐层关，根态才退 App）；浏览器后退键同语义 | Android / 浏览器 |
| #2 | 系统栏沉浸 | 状态栏/导航栏随主题同色系，冷启动无白屏闪烁，键盘弹起不遮挡输入框与 Tab | Android |
| #17 | 移动路由 | Tab 切换必须完全退出详情态（无残留详情/空白区/重复堆叠）；切 Tab 播放不中断 | Android / PWA |
| #20 | 无边框窗口 | 桌面自绘三键（关/最小/最大化）+ 拖拽区，深浅主题下可见 | 桌面 |
| #3+#4 | 后台播放/媒体条/音频焦点 | 锁屏与退后台 ≥5min 不断；通知栏媒体卡片（封面/标题/进度/播放暂停/上下曲）双向同步；蓝牙键、来电、拔耳机、音频焦点按策略处理 | Android |
| #18 | 浏览器登录兜底 | 「在系统浏览器完成登录」+ 回 App 点「我已完成登录」；⚠️ 该条仍写「短信登录+滑块」，与 v1.0.1 下线短信登录冲突，**需与产品确认后改写** | Android / 桌面 |
| #8 | 空格播放/暂停 | 桌面空格切换播放；焦点在输入框时不劫持；按钮保持焦点时不重复触发 | 桌面 / 浏览器 |
| #15 | 按钮顺序 | 手机播放三键左→右 = 上一首 · 播放/暂停 · 下一首（歌词页控制条一致） | Android / PWA |
| #19 | 滑条粉色填充 | 进度条与音量条粉色填充随值变化，拖动跟手 | 桌面 / Android |
| #12+#13 | 长歌名 | 单行省略 + 激活态跑马灯滚动，切歌复位 | 桌面 / Android |
| #16 | 歌词点击 | 点歌词行跳转到对应时间（并处理长按/双击语义） | Android / 桌面 |
| #9 | 品牌启动 | 品牌启动页等比缩放不裁切，深色背景直出 | Android / 桌面 |
| #5 | 后台轮询 | 页面进入后台时暂停/降频轮询（省电，避免 WebView 后台狂打接口） | Android / 浏览器 |
| #6 | 移动性能 | 封面缩略/懒解码，避免大图解码与整树重渲造成长任务 | Android |
| #11 | 下拉刷新 | 移动端下拉刷新曲库/发现 | Android / PWA |
| #14 | 专辑功能 | paged（多 P）与 series（跨视频合集）两期能力：容器、星标、懒物化、删除语义 | 桌面 / Android |
| #10 | 歌词源 | 歌词来源可切换/可标注（现状 LRCLIB 为主） | 桌面 |
| #7 | 新建歌单 | 移动端要有显式「新建歌单」入口（v1.0.2 才补上） | Android / 桌面 |
| #21 | 歌词对比度 | 歌词文字对比度达标（≥4.5:1） | 桌面 |
| #22 | 歌词页关闭按钮 | 歌词页有明确关闭按钮，位置符合拇指热区 | 桌面 / Android |

---

## 6. 信息架构与页面清单

### 6.0 现状 IA（重设计要替换的对象）

现状是「SSR 骨架 + `#app[data-view]` 状态机」：`app.js` / `v3.js` 通过切 `data-view` 显示/隐藏区块，`back-stack.js` 监听该属性做返回栈。

| 端 | 导航项 | 代码 |
|---|---|---|
| 桌面侧栏 | 首页 / 推荐 / UP 主 | `base.html:80-82`（`.side-item[data-nav]`） |
| 手机底部 Tab | 主页 / 资料库 / 账号 | `base.html:265-268`（`.m-tab[data-mtab]`） |
| 视图状态机 | `home` / `recommend` / `up` / `library` / `search` / `detail`（+ 手机专属 `account`，走 `mTab()` 而非 `data-view`） | `v3.js` 各处 `$("app").dataset.view = ...`、`base.html:266-268` |
| 响应式断点 | `max-width:700px`、`max-width:900px`、`min-width:901px`，另有 `pointer:coarse` / `prefers-reduced-motion` / `prefers-reduced-transparency` | `style.css:780/909/918/1086` |

> ⚠️ **两端 IA 不一致**：桌面有「推荐 / UP 主」，手机有「资料库 / 账号」，两套导航指向的视图集合不同，容易出现「某个页面在某端进不去」。重设计应统一为**一份导航模型 + 两种呈现**（侧栏 / 底部 Tab）。

```
Tab/侧栏（建议统一）
├── 首页（发现）
│   ├── 最近收藏架
│   ├── 每日精选
│   ├── 推荐歌单架（每日精选 / 电台 / 风格精选）
│   └── 流派货架
├── 曲库
│   ├── 歌单列表（含「全部歌曲」）
│   ├── 曲目列表（搜索/排序/筛选/批量）
│   ├── 合集/专辑货架
│   └── UP 主视图
├── 搜索（详情页三分类）
└── 账号（登录/退出/同步/设置）

浮层
├── 播放器（底部 mini 条 → 全屏歌词页）
├── 队列面板
├── 歌单操作菜单 / 单曲菜单
├── 导入任务抽屉
├── 导出/分享弹窗
└── 登录弹窗
```

| 页面 | 关键区块 | 主接口 |
|---|---|---|
| 首页 | 最近收藏、每日精选、货架、流派 | `/api/songs`、`/api/recs`、`/partials/genre-shelves` |
| 曲库 | 歌单侧栏、曲目表、合集货架 | `/api/playlists`、`/api/songs`、`/api/albums` |
| 专辑/合集详情 | 头部信息、曲目表、星标、播放 | `/api/albums/{id}/songs`、`/materialize` |
| 歌单详情 | 封面 mosaic、曲目、分享 | `/api/songs?playlist_id=`、`/covers`、`/share-link` |
| 搜索 | 输入、三分类结果、UP 卡 | `/api/search`、`/partials/search-detail` |
| UP 主 | 头像主色背景、TOP10、投稿分页 | `/partials/up`、`/web/up/resolve` |
| 播放器全屏 | 封面、歌词、进度、控制、队列 | `/api/stream`、`/api/songs/{id}/lyrics` |
| 账号 | 登录态、同步、退出、设置 | `/api/auth/*`、`/api/sync` |

---

## 7. 状态与数据流设计

### 7.1 建议的全局状态切片

| 切片 | 内容 | 失效信号 |
|---|---|---|
| `account` | 登录态、mid、昵称、maxQuality | 401 / `logout` |
| `library` | 曲目分页缓存、查询条件、计数 | SSE `libraryChanged`、导入 `ready` |
| `playlists` | 歌单列表 + 每单计数/封面 | SSE `playlistsChanged` |
| `albums` | 专辑/合集 + 曲目 + `hasMore` | SSE `libraryChanged`、`materialize` |
| `queue` | 队列项、当前索引、来源（曲库/推荐/搜索/专辑） | 用户操作 |
| `player` | 播放态、进度、音量、倍速、模式、错误 | `<audio>` 事件 |
| `jobs` | 导入/同步/导出任务 | 轮询 + `HX-Trigger` 等价物 |
| `ui` | 弹层栈、主题、Toast | 用户操作 |

### 7.2 队列模型（重设计要点）

- **来源标记**：队列项要记来源（`library` / `album` / `recs` / `search` / `up`），因为推荐/搜索结果不在曲库中，不能对它们做「删除曲库」类操作。
- **两种项**：`librarySong`（有 `id`）与 `externalTrack`（只有 `bvid`，需走 `/api/stream` + `/api/lyrics/preview`）。
- **持久化**：现状已有账号隔离的会话快照 `bmSession:<mid|guest>`（`app.js:194` `saveSession` / `206 restoreSession`），存 `songId` + `position` + `queueIds`，刷新/重开可续播；播放模式另有 `bmPlayMode` / `bmRepeatOne`。缺的是**跨设备**续播（需要 G-4 的服务端进度）。
- **续播**：纯本地已可用（`bmSession`）；跨端需要 G-4。

### 7.3 本地持久化键（现状 → 建议）

| 键 | 作用域 | 现状 | 建议 |
|---|---|---|---|
| `bmTheme` | 全局 | 亮/暗 | 增加 `system` |
| `bmPlayMode` | 全局 | 顺序/随机/循环 | 保留 |
| `bmRepeatOne` | 全局 | 单曲循环 | 合并进 `bmPlayMode` |
| `bmSession:<mid\|guest>` | 账号 | 会话快照：`songId` + `position` + `queueIds` | 保留并扩展（队列来源标记、音量、倍速） |
| `bm_pl:<mid>` / `bm_pl_name:<mid>` | 账号 | 当前选中歌单 id / 名字 | 保留 |
| `bmHistory:<mid>` | 账号 | 浏览历史（回退栈用） | 与 §5.13 的返回语义合并 |
| `htmx-history-cache` | htmx 内部 | htmx 历史缓存 | 新栈不需要 |
| `bmUpFaces`（session） | 会话 | UP 名 → `{face,hue}` 头像缓存 | 可保留（避免重复解析） |
| `bmToastedTasks`（session） | 会话 | 已提示过的任务 id | 保留（防重复弹完成提示） |
| `bm_synced_open`（session） | 会话 | 打开即同步标记 | 保留（每次会话只自动同步一次） |

> 共 8 个 localStorage 键 + 3 个 sessionStorage 键，全部可用；重设计要保留「账号隔离」这一点（同一浏览器切账号不能串数据）。

### 7.4 SSE 驱动的失效策略

```
订阅 /api/events
  libraryChanged   → 失效 library + albums + 首页最近收藏（保留分页缓存，重取第一页）
  playlistsChanged → 失效 playlists + 歌单卡片计数
断线（EventSource error）→ 退避重连（后端已给 retry: 3000）；重连成功后强制全量失效一次
```

### 7.5 乐观更新与回滚

| 操作 | 乐观效果 | 失败处理 |
|---|---|---|
| 删歌 | 行移除、计数 -1 | 恢复行 + Toast（后端已尽力取消收藏） |
| 星标/移出 | 图标切换、计数 ±1 | 恢复图标 |
| 加歌单 | 目标歌单计数 +1 | 恢复 + 提示 |
| 删专辑 | 卡片移除 | 恢复卡片 |
| 同步 | 按钮进入 loading | 显示 `failed` + `error` |

### 7.6 现状轮询 / 推送 / 401 兜底（重设计要收敛的部分）

| 通道 | 现状频率 | 位置 | 重设计建议 |
|---|---|---|---|
| 导入任务 | 前台 2s 轮询，后台零请求，回前台补一次 | `v3.js:1415-1431` | 保留限流思路；任务多时改 SSE |
| 扫码状态 | 1.5s | `app.js:1009` | 保留 |
| 导出进度 | 1.2s | `export.js:56` | 保留 |
| 歌词页进度 | **500ms**（独立于主 `timeupdate`） | `v3.js:1188-1216` | 删，统一进度源（D-16） |
| 曲目列表就绪探测 | 100ms × 40 | `v3.js:555-562` | 删，改用 SSE/事件 |
| SSE | `/api/events` 唯一推送通道，只覆盖曲库/歌单变更 | `v3.js:1707-1727`（600ms 防抖） | 扩展事件类型（任务/同步进度） |
| 401 兜底 | 包装 `window.fetch` + htmx `responseError`，页面装载后 2s 内抑制 | `app.js:1128-1146` | 改为显式鉴权层，去掉全局副作用 |
| 离线 | **无离线提示**；断网 fetch 全 reject → 统一 toast「网络错误，请重试」 | `app.js:1249` | 区分「后端未启动 / 无网络 / B 站不可达」 |

---

## 8. 关键流程

### 8.1 登录
`POST /api/auth/qrcode` → 渲染二维码 + 立即轮询 `GET /api/auth/qrcode/{key}`（1.5~2s）→ `scanning` 文案 → `confirmed` → `GET /api/auth/status` 确认 → 关闭弹窗 + 全量失效 → 触发一次同步。

### 8.2 导入
输入 → 判断是链接/BV 号 → `POST /api/imports/batch` → 按 `mode` 提示 → 轮询 `/api/imports`（或 SSE）→ `ready` 后刷新曲库 → 失败项给重试。

### 8.3 播放
点击曲目 → 设置 `<audio src=song.audioUrl>` → `POST /api/recs/seed`（搭车，静默）→ 首帧后懒取歌词 → `timeupdate` 更新进度/歌词 → 结束按模式切下一首 → 记录进度（G-4 就绪后上报）。

### 8.4 星标收藏（合集）
详情页点击空心星 → `POST /api/songs/{id}/collect?playlist_id=` → 乐观变实心 → 后端后台完成 B 站收藏（series）→ 失败由同步对账自愈。

### 8.5 同步对账
打开首页静默 `POST /api/sync` → 任务进入 `jobs` → 轮询 `GET /api/sync/{id}` 至 `done|failed` → 展示摘要 → SSE 触发曲库/歌单刷新。

### 8.6 歌词懒抓
打开歌词面板 → `GET /api/songs/{id}/lyrics`（首次触发后端抓取）→ 有 LRC 就解析滚动，`null` 就显示空态 + 「重试」（`force=1`）；未入库曲目用 `/api/lyrics/preview`。

---

## 9. 技术选型建议

### 9.0 现状技术形态（先认清要替换什么）

| 项 | 现状 | 影响 |
|---|---|---|
| 框架 | 无。`app.js`（~1523 行）+ `v3.js`（~1735 行）纯 IIFE，靠 `window` 全局互调 | 唯一跨文件契约是 `window.BiliPlayer`（`app.js:1149-1189`）；改播放器要同时读两个文件 |
| 模板 | Jinja2 SSR（`base.html` + 19 个 partials）+ htmx 局部替换 | 数据与视图耦合在模板里 |
| 样式 | 单个 `style.css`（~82KB），三个断点 + 三组媒体查询 | 主题/组件化改造代价高 |
| 构建 | 无（v0.5.0 §4 明文写死） | 任何新栈都要先推翻这条决策 |
| 状态 | `#app[data-view]` + localStorage 8 键 | 见 §7 |

### 9.1 方案对比

| 方案 | 做法 | 成本 | 风险 | 适用 |
|---|---|---|---|---|
| **A. 保留 SSR + htmx** | 继续用 `/partials/*` + `/web/*`，只重写 CSS/组件 | 低 | 状态管理弱、动画/手势受限、同一数据两套实现 | 只想改视觉 |
| **B. SPA（Vue 3 / React + Vite）** | 只用 `/api/*` JSON，前端自管状态与路由 | 中（引入构建链，与「无构建」决策冲突，需用户拍板） | 首屏、PWA 缓存、WebView 兼容需重做 | 想真正重做交互 |
| **C. 混合** | 新栈做播放器/曲库/发现三个高频页，设置/账号页保留 SSR | 中低 | 两套并存，路由与登录态需打通 | 渐进迁移（推荐） |

**JSON API 覆盖度评估（选 B/C 时）**：曲库、歌单、专辑、导入、同步、歌词、推荐、搜索视频、流媒体**已够用**；缺口集中在 G-1/G-2（分页与排序）、G-7（UP 主与合集搜索）、G-4（续播）。也就是说：**重设计的主要阻塞项是「曲库分页/排序」与「UP 主/合集搜索」**，其余可先用现有接口 + 前端兜底（G-5 的智能过渡接口现状不影响用户，见 D-2）。

> ⚠️ **需要显式推翻的既有决策**：`docs/v0.5.0-prd.md:89` 把「**无前端构建**（服务端渲染 + htmx，不引入构建链）」写成了非功能约束。选方案 B/C 等于推翻它——PRD 落地前需要用户确认，并给出共存/迁移方案（例如：构建产物挂 `/static`、旧页面保留 `/partials/*` 一段时间、登录态与 SSE 双端共用）。

---

## 10. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能 | 首屏可交互 < 2s（局域网）；封面走缩略/懒加载；列表 > 200 行必须虚拟滚动；切歌不阻塞主线程 |
| 离线 | 不做离线播放。⚠️ 现状 `sw.js` 写了缓存逻辑但**全仓没有 `serviceWorker.register` 调用 → 从未注册，PWA 离线能力实际为零**（见 D-8）；重设计要么真正注册并缓存静态资源，要么删掉 `sw.js` 别误导 |
| 兼容 | Chrome/Safari/Android WebView（含旧版）；Tauri 系统 WebView |
| 可访问性 | 键盘可达、焦点管理、`aria-*`、`prefers-reduced-motion`、对比度 ≥ 4.5:1。⚠️ 现状卡片/行是 `div[onclick]`、无 `tabindex`/`role`，键盘与读屏基本不可用（D-11）；`prefers-reduced-motion` 已有降级（`style.css:587/762/1069`） |
| 主题 | 亮/暗/跟随系统；封面主色驱动的动态背景（`coverColor`、UP 头像 `hue`） |
| 错误处理 | 所有 4xx/5xx 展示后端 `detail`；音频错误与网络错误分开提示 |
| 安全 | 不要把 `BM_API_TOKEN` 写进前端产物；Token 通过运行时注入 |
| 可观测 | 关键动作（导入/同步/播放失败）本地可导出诊断信息 |

---

## 11. 已知缺陷与风险

### 11.1 缺陷（重设计前必须处理）

| # | 缺陷 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| D-1 | `RedirectResponse` 未导入 | `app/api/routes.py:383`（`song_cover`） | 在线封面歌曲请求 `/api/songs/{id}/cover` 会 `NameError` → 500（目前前端多走 CDN 直链，属潜伏 bug） | 补 import；或改为直接 302 |
| D-2 | `POST /api/songs/analysis` 不存在（前端有调用点） | `app.js:706`；后端无该路由 | 调用被 `smartEnabled()` 恒 `false` 短路（`app.js:602`，「纯在线版已停用」），**当前不会真的发出请求**，属死代码 + 文档宣传不符；一旦有人把开关打开就会 404 | 二选一：① 彻底删除 smart transition 代码与 `manifest.json` 里的宣传文案；② 恢复功能并补后端接口（注意现为流式播放，无本地音频可分析，需重新设计输入） |
| D-3 | 曲库 500 条上限 | `library.list_songs(limit=500)` + `/api/songs` | 超过 500 首的用户看到不完整曲库 | 加分页（G-1） |
| D-4 | 计数口径复杂 | BUG-004 | 用户看到的三处数字不一致 | 前端统一用「视频级」计数并加 tooltip 说明 |
| D-5 | 同步任务内存态 | `sync.py` / `exporter.py` | 服务重启后任务 id 失效（404） | 前端把「任务不存在」当已完成处理 |
| D-6 | 短信登录残留 | `/api/auth/captcha`、`/api/auth/sms/*` | 接口还在但已下线，新前端别接 | 后端可删 |
| D-7 | **媒体 URL 不带 token** | `app/api/routes.py:119`（`song_out.audioUrl`） | `coverUrl` 会拼 `?token=`，`audioUrl` 只拼 `?cid=`。启用 `BM_API_TOKEN` 时 `<audio>` 拿不到 token（无法带 Authorization 头）→ 播放 401 | 后端统一用 helper 拼 token；或前端在拿到 `audioUrl` 后自行附加 token（但 `?cid=` 与 `?token=` 需正确合并） |
| D-8 | **Service Worker 从未注册** | `sw.js` 存在且逻辑完整，但全仓无 `serviceWorker.register` | PWA 离线/静态缓存能力为零，`manifest.json` 的 PWA 承诺名不副实 | 在 `base.html` 注册（注意 `/static` 的 `no-cache` 与版本串），或删除 `sw.js` |
| D-9 | **手机 mini 播放条缺进度与歌手** | `style.css:955-965`（≤900px 隐藏 `.p-time` / `#seek` / `#player-artist`） | 移动端无法在播放条拖进度，必须进歌词页；移动优先产品的核心体验缺口 | 重设计把进度条放回 mini 条（触摸热区 ≥44px） |
| D-10 | **死代码 / 孤儿代码** | ① smart transition 整条链路（`smartEnabled()` 恒 false，交叉淡入、100 首并发分析预取、`transition.js` 196 行）；② `partials/recs.html` 及其路由；③ `#sec-discover`、`.rec-play` / `.rec-collect`；④ 短信登录 CSS（`style.css:880-904`） | 体积与认知负担；改一处要读三处 | 重设计时整体清算，别把死代码迁进新栈（完整清单见 §15 B.3） |
| D-11 | **无障碍基本不可用** | 卡片/行多为 `div[onclick]`，无 `tabindex`/`role`；行内按钮靠 hover 显隐（`genre_shelves.html:6`、`search_detail.html:48`、`daily_columns.html:7`、`style.css:949-952`） | 键盘与读屏用户无法操作；`#8` 空格键的 IME 防线也说明键盘路径敏感 | 换成 `button`/`a` + `role`，行内操作在 `pointer:coarse` 与键盘聚焦时都常显 |
| D-12 | **静态资源版本号靠手改** | `base.html:15-21` 的 `?v=166/66/68/4` 是手工维护，且 `sw.js` 未注册 | 发版漏改 → 用户拿到旧 JS/CSS，出现「改了没生效」的幽灵问题 | 引入内容指纹（构建或后端注入），或真正注册 SW |
| D-13 | **同一片段两份副本** | 侧栏 `#playlists-bar` 与手机 `#mlib-pls` 各渲染一份 `/partials/playlists`，刷新逻辑分别维护（`v3.js:1715` 只刷侧栏；`app.js:1305-1307` 只挂侧栏） | 手机端改歌单后另一份不同步 | 单实例渲染 + 复用 |
| D-14 | **桌面端没有导出入口** | 导出按钮只在手机账号页（`library.html:138`），桌面侧栏没有 | 桌面用户无法导出/分享曲库 | 重设计统一入口 |
| D-15 | **任务区失败可见性差** | 完成/失败任务 5.2s 后自动移除、上限 10 进行中 + 5 已完成、无重试入口（`v3.js:1657-1676`） | 导入失败容易错过，用户以为没发生 | 保留可查历史 + 单条重试 |
| D-16 | **双轨进度实现** | 主播放器 `#seek`（`app.js:571-589`）与歌词页 `#ly-seek`（`v3.js:1185-1216`，独立 500ms 轮询） | 两套逻辑、两套 bug 面；手机端只有后者能用 | 统一为一个进度组件 |

### 11.2 文档一致性问题（会误导重设计）

| # | 问题 | 证据 | 处理 |
|---|---|---|---|
| C-1 | 验收手册仍要求「短信登录 + 滑块验证」为 #18 的核心验收点，但短信登录已在 v1.0.1 下线 | `docs/acceptance-manual.md:87-91` vs commit `27b0afd` | 重写 #18 为「系统浏览器扫码登录兜底」，并删除 `/api/auth/sms/*` 与极验相关前端代码 |
| C-2 | 验收手册引用的 `docs/issue-ledger.md` 在仓库中不存在 | `docs/acceptance-manual.md:3` | **已补齐**：新建 `docs/issue-ledger.md`，历史条目按来源索引，#23 起为新条目 |
| C-3 | `docs/v0.5.0-prd.md` 的版本/范围已落后于 v1.0.2（系列、同步、计数都已完成） | 该文件 §3.5/§3.6 注记 | 以本 PRD §4/§5 为准，v0.5.0 文档降级为历史 |
| C-4 | PWA `manifest.json` 的 description 宣传「智能过渡播放」，但该功能依赖缺失的 `/api/songs/analysis`（D-2） | `app/web/static/manifest.json` | 要么补接口，要么改文案 |
| C-5 | 桌面侧栏与手机底部 Tab 的导航项集合不同（见 §6.0） | `base.html:80-82` vs `265-268` | 重设计统一导航模型 |

### 11.3 风险

- **B 站风控**：搜索/系列/投稿接口可能 412；前端要接受「降级结果」并给提示（现状 `/partials/up` 已降级为搜索过滤）。
- **CDN 直链时效**：`/api/stream` 每次现解析，长播不缓存；断流要有重试。
- **未公开收藏夹**：需要登录且公开性受限，导入可能失败。
- **多设备一致性**：依赖同步对账；离线操作无法合并。

---

## 12. 验收标准（重设计版）

1. **登录**：新设备扫码 → 曲库数量与 B 站收藏夹一致（回归 BUG-001 的验收口径）。
2. **播放**：多 P 曲目播对应分 P；拖动进度不重下整首；锁屏/通知栏可控（Android）。
3. **曲库**：搜索、排序、筛选、分页（G-1 完成后）正确；删歌后 B 站收藏同步减少。
4. **合集**：星标只 +1；删容器批量取消收藏；懒物化滚动到底自动补。
5. **导入**：单/收藏夹/系列三种链接都能识别，任务进度与失败原因可见。
6. **同步**：手动同步显示五项计数；`done` 后无需刷新即见新曲。
7. **歌词**：老歌自动补齐；无歌词有空态；重试有效。
8. **一致性**：SSE 收到事件后 1s 内 UI 更新。
9. **多端**：手机底部导航 + 安全区；桌面侧栏；Tauri 窗口与媒体键；Android 返回键正确。
10. **自动化门槛**：`python -m pytest -q`、`node --test tests/*.js`、`cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked` 全绿。

> **回归基线**：验收手册当前 27/27 组通过（`docs/acceptance-manual.md:288`），遗留仅 #3 深段（Media3 迁移）与 #14 series 二期。重设计后 §14 A.6 的高风险清单必须逐条复跑，否则等于把已修的问题改回去。

---

## 13. 里程碑建议

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M0 契约冻结 | 确认 §4 接口为前端唯一契约；后端补 G-1/G-2（分页/排序）、G-7（UP 主与合集搜索） | 后端 |
| M1 骨架 | 路由/状态/主题/登录弹窗/播放器壳 | 前端 |
| M2 核心闭环 | 曲库 + 播放器 + 队列 + 歌词 + 歌单 | 前端 |
| M3 合集与导入 | 专辑/合集容器、星标、懒物化、导入任务 | 前后端 |
| M4 发现与搜索 | 每日精选、货架、三分类搜索、UP 主页 | 前后端 |
| M5 多端与打磨 | Tauri/Android 外壳、可访问性、性能、验收 | 全端 |

---

## 14. 附录 A：多端外壳契约（重设计不能破）

### A.1 嵌入式后端启动握手（桌面 + Android 共用）

```
壳进程启动 Python 后端（PyInstaller onedir / Chaquopy）
  → 后端监听 127.0.0.1:<随机临时端口>
  → stdout 打印 BILIMUSIC_URL=http://127.0.0.1:<port>
  → 壳轮询 /openapi.json 直到就绪（桌面最长 120s；Android 120×500ms）
  → 壳导航到该 origin（桌面先显示本地启动页 loading_pc.png + #status）
退出：壳关 stdin（EOF）→ 后端 watch_parent 读到 EOF 即停
```

- 端口**只接受 127.0.0.1 回环**，有单测守卫（`desktop/src-tauri/src/policy.rs`）。
- 前端不要硬编码 `:8000`；必须从壳给的 origin 取（浏览器部署除外）。

### A.2 平台探测（三分支）

| 平台 | 探测 | 依据 |
|---|---|---|
| Tauri 桌面 | `window.__TAURI__` | `v3.js:10` |
| Android | `window.BiliMusicNative` | `v3.js:23` |
| 其余 | CSS `900px` 断点 | `app.js:1073`、`style.css:918` |

### A.3 Android 原生桥（8 个方法，前端必须继续调）

| 方法 | 用途 |
|---|---|
| `setTheme` | 状态栏/导航栏图标明暗跟随主题 |
| `openExternalLogin` | 系统浏览器打开登录页（浏览器兜底登录路径） |
| `playbackStarted` / `playbackProgress` / `playbackPaused` / `playbackStopped` | 驱动 `MediaPlaybackService` 的通知栏/媒体会话镜像 |
| `saveQrToGallery` | 二维码存相册（API 29+ scoped storage；≤28 申请写权限） |
| `openBilibiliApp` | 拉起 B 站 App 扫码 |

- 返回键：原生先问 `window.__backStackDepth()`，>0 走 `history.back()`（**WebView 的 `canGoBack()` 不认 pushState**）——前端必须维护该深度。
- 边到边：原生把 insets ÷ density 注入 CSS 变量 `--inset-top/bottom/left/right`，配合 `env(safe-area-inset-*)` 使用。
- WebView 关键设置：`mediaPlaybackRequiresUserGesture(false)`、UA 伪装成手机 Chrome（去 `; wv`）、第三方 Cookie 允许（BUG-002 的教训）。
- 弹窗兜底：WebView 默认不实现 `prompt/confirm`，原生自绘（Android 上不要用原生 `prompt()`）。

### A.4 桌面端窗口约束

- 窗口 1280×850，**最小宽 1260px**——桌面端永远不会滑进手机布局；不要为桌面单独写一套外壳，除桥调用外与浏览器共用。
- capabilities 只开放窗口最小化/最大化/关闭/拖动 + `core:default`；**无托盘、无全局媒体键、无系统媒体会话**。
- CSP：`default-src 'self' http://127.0.0.1:*`，`img-src` 额外允许 `data:` / `https:`，`style-src 'unsafe-inline'`——新栈若用外域 CDN（字体/图标）会被 CSP 拦。

### A.5 账号与数据边界

- **账号 = 独立 SQLite 库**：`data/accounts/<mid>/bilimusic.db` + `cookies.json`；未登录用 `data/bilibili_music.db`。切账号=切库，**前端不能跨账号聚合**。
- 登录态由 SSR 注入 `body[data-auth][data-mid]`，JS 读属性；不依赖浏览器 Cookie。
- `TrackAnalysisRow`（智能过渡分析缓存）前端不直接展示，属 §11 D-2/D-10 的死代码范围。

### A.6 高风险交互清单（重设计后必须逐条复跑）

`#1` 返回语义 · `#2` 系统栏沉浸 · `#17` 移动路由 · `#19` 滑条填充 · `#12/#13` 长歌名 · `#5` 后台轮询（前台 ~2s、后台零请求） · `#7` 新建歌单 · `#15` 按钮顺序 · `F0` cid 流路由（伪造 cid 必须 400）。

---

## 15. 附录 B：现有实现地图（重设计替换清单）

> 每行 = 一个功能单元 → 现有实现位置 → 重设计时的处置建议。`删` = 可直接删除，`迁` = 需迁移，`重写` = 语义保留实现换掉。

### B.1 播放器内核（`app.js`，~1523 行 IIFE）

| 功能 | 位置 | 处置 |
|---|---|---|
| 底部播放条 | `base.html:113-140`、`app.js:317-338` | 重写（补回手机进度/歌手，见 D-9） |
| 进度条（主） | `base.html:127`、`app.js:571-589`（`--p` 驱动粉色填充） | 重写并统一 |
| 进度条（歌词页） | `v3.js:1185-1216`（独立 500ms 轮询） | 删：与主 `timeupdate` 双轨 |
| 播放/暂停 + 空格 | `app.js:502-521`、`v3.js:1399-1411`（三重 IME 防线） | 迁（保留 IME 保护逻辑） |
| 上一首/下一首 | `app.js:374-409`（试听态循环、order 到队尾停、random） | 迁 |
| 播放模式 | **仅歌词页** `#ly-mode`（`v3.js:1224-1247`，`bmPlayMode`） | 重写：桌面播放条也要有入口 |
| 单曲循环 | 队列面板 checkbox（`app.js:730-737`，`bmRepeatOne`） | 迁：入口不该埋在队列里 |
| 音量 | `v3.js:1116-1152`，**不持久化**（每次加载 100） | 重写 + 持久化 |
| 收藏星 | `v3.js:887-907`、858-884（多 P 弹确认删专辑） | 迁 |
| 歌词面板 | `app.js:756-897`（LRC 解析/点击 seek/当前行居中/来源标注/重试） | 迁 |
| 队列面板 | `app.js:82-111,741-751` | 重写：无拖拽排序、无「从队列移除」 |
| 实时流试听 | `app.js:1354-1421`（独立 `Audio`，与主播放器互斥） | 重写：并入统一播放器 |
| 媒体会话 | `app.js:340-358` | 补：未注册 `play`/`pause`/`seekto` handler |
| 双 audio 交叉淡入 | `base.html:273-274`、`app.js:636-674` | 删（死代码，见 D-10） |
| 会话续播 | `app.js:194-229`（`bmSession:<mid>`，3s 节流写） | 迁 |
| 最近播放 | `app.js:1467-1505`（`bmHistory:<mid>`，本地 20 条） | 迁或升级为 G-4 服务端历史 |

### B.2 视图与导航

| 视图 | 位置 | 处置 |
|---|---|---|
| 视图状态机 | `#app[data-view]` + `style.css:768-773`（无路由、无历史） | 重写：换成真路由 |
| 返回语义 | `back-stack.js:19-55,86-119`（7 类层注册 + MutationObserver 对账） | 重写：新增浮层必须 `reg()` 否则穿透 |
| 首页 | `library.html:7-33`（hero 无文案、`#sec-discover` 不存在） | 重写 |
| 推荐 | `library.html:40-50` | 重写 |
| 资料库 | `library.html:57-68`（**桌面无入口**，`style.css:1083-1084`） | 重写：两端统一 |
| 详情 | `library.html:73-98`，三种 kind 共用 DOM + `dtState` + `htmx:beforeSwap` 守卫 | 重写：拆分三种详情 |
| UP 主 | `library.html:104-108`，右栏 `innerHTML` 手拼（`v3.js:148-153`） | 重写 |
| 搜索 | `library.html:117-118`、`search_detail.html`（返回 `goHome()` 丢搜索词） | 重写：保留搜索态 |
| 账号 | `library.html:122-141`（音质文案写死「192K」） | 重写 |
| 常驻浮层 ×6 | `base.html:142-145,150-160,162-211,213-239,240-262,283-304` | 迁/重写 |

### B.3 可删除的历史包袱（§11 D-10 的完整清单）

| 项 | 位置 |
|---|---|
| Smart Transition 全链路 | `app.js:600-728`、`transition.js`（196 行）、`/api/songs/analysis` 调用点 |
| 孤儿推荐列表 | `partials/recs.html` + `/partials/recs` 路由（无 `#rec-list` 容器加载） |
| 孤儿区块/类名 | `#sec-discover`、`.rec-play`、`.rec-collect`、`switchView` 的 `[data-view]` 分支、`#songs` 分支、`.rec-genres`/`.chips` |
| 短信登录残留 | `app.js:1123-1124`、`style.css:880-904`（~25 条）、`/api/auth/sms/*` |
| 垫底 modal | `app.js:13-46`（与 `v3.js:1434-1475` 正式实现并存） |

### B.4 需要重写的基础设施（隐性成本，选型时要计入）

| 项 | 现状 | 重设计要点 |
|---|---|---|
| 状态管理 | 全模块级全局变量 + 4 个 generation 计数器兜竞态（`queueGeneration`/`refreshGeneration`/`albumDetailGeneration`/`qrAttempt`） | 换单一数据源 |
| 轮询体系 | 任务 2s、扫码 1.5s、导出 1.2s、歌词 500ms、列表就绪探测 100ms×40 | 收敛为 SSE + 按需轮询 |
| 401 处理 | 包装 `window.fetch` + htmx `responseError` + 页面装载 2s 抑制窗口 | 改为显式鉴权层 |
| HTML 转义 | 5 份重复实现（`escapeHtml`/`escHtml`/`escUp`/`esc`/`mosaicHtml` 内联） | 收敛为 1 份 |
| 同一片段两份副本 | 侧栏 `#playlists-bar` 与手机 `#mlib-pls` 各自维护刷新逻辑 | 单实例 + 复用 |
| 缓存版本号 | 手改 `?v=166/66/68/4`（`base.html:15-21`），SW 未注册 | 构建指纹或真注册 SW |
| 老 WebView 兼容 | `:has()` 滑块位移 + `body.up-open` 兜底两套规则（minSdk 26） | 用 JS 类名驱动，别依赖 `:has()` |
| 无障碍 | 卡片/行多为 `div[onclick]`，无 `tabindex`/`role`；行内按钮靠 hover 显隐 | 全部换成可聚焦元素 |
