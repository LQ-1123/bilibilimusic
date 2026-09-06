# BiliMusic 后端

把 B 站当曲库的音乐收藏服务：粘贴 B 站分享链接 → 自动解析音频与封面 → 缓存本地入库 → 流式播放。
不接入任何传统音源，曲库完全由用户分享的 B 站链接构成。**仅限个人自用。**

- 后端：Python 3.13 + FastAPI + SQLite + httpx（本仓库）
- Web 页：服务端渲染 + htmx，浏览器直接用（手机浏览器同样可用）
- 安卓端（二期）：Flutter 接同一套 API 契约，见下文「二期对接」

## 快速开始

```bash
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://<本机IP>:8000`（**需扫码登录后使用**）：

1. 首页输入框粘贴 B 站 App 分享出来的文本（或任意 `b23.tv` / `bilibili.com/video/BVxxx` 链接）
2. 粘贴**收藏夹链接**（`space.bilibili.com/{mid}/favlist?fid=xxx`）可批量导入整个收藏夹，已入库的自动去重
3. **入库即收藏**：每首入库的歌自动收藏进你账号的公开收藏夹「**bilimusic**」（系统自动创建）；顶栏「导出」补同步缺失歌曲并生成分享链接，他人粘贴该链接即可整夹导入，链接对浏览器 / B 站 App 同样有效
4. 任务条走完「解析中 → 下载中 → 已入库」，曲库出现封面卡片；点封面播放；搜索框过滤曲库；卡片右上 ✕ 删除

接口文档（OpenAPI，二期前端对接用）：`http://localhost:8000/docs`

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `BM_HOST` / `BM_PORT` | `0.0.0.0` / `8000` | 监听地址 |
| `BM_DATA_DIR` | `./data` | 数据目录（库、音频、封面、cookie） |
| `BM_API_TOKEN` | 空 | 非空则 `/api/*` 需要 `Authorization: Bearer <token>`（媒体接口也接受 `?token=`） |
| `BM_ALLOW_ORIGINS` | `*` | CORS 允许来源（逗号分隔） |

## API 契约（v1）

### 导入

```http
POST /api/imports            {"url": "分享文本或链接"}   → 202 {"importId": "..."}
POST /api/imports/batch      {"url": "收藏夹或视频链接"} → 202 BatchResult
GET  /api/imports/{id}       → {id, status, statusLabel, progress, error, songId, song}
GET  /api/imports            → {"tasks": [...]}  最近 50 条
```

`status`: `pending / resolving / downloading / ready / failed`。
失败时 `error` 为可直接展示的中文文案（含 B 站错误码映射）。

`POST /api/imports/batch` 为智能提交：识别收藏夹链接（含 `fid`，支持 b23.tv 短链）则展开为逐视频任务，
否则按单视频导入。批量响应：

```json
{
  "mode": "batch",
  "folderTitle": "默认收藏夹",
  "total": 4,
  "importIds": ["a1b2", "c3d4", "e5f6", "a7b8"]
}
```

单视频响应：`{"mode": "single", "importId": "..."}`。收藏夹单次上限 200 个视频。

### 曲库

```http
GET    /api/songs?q=关键词     → {"songs": [SongOut]}
GET    /api/songs/{id}         → SongOut
GET    /api/songs/{id}/audio   → 音频流，支持 HTTP Range（206/416），Content-Type: audio/mp4
GET    /api/songs/{id}/cover   → 封面图 image/jpeg
GET    /api/songs/{id}/lyrics  → {"lyrics": "…LRC 文本或纯文本…", "source": "cc|lrclib|ai"}；无歌词 → {"lyrics": null}
DELETE /api/songs/{id}         → 删除记录与本地文件
```

歌词为 B站人工 CC 字幕 / LRCLIB 正式歌词 / B站 AI 字幕三级来源，入库时自动抓取；
存量歌曲在此端点首次访问时懒抓并缓存，取不到已标记不再重复请求外部接口。
带 `[mm:ss.xx]` 时间轴的 LRC 前端跟随滚动，纯文本静态展示。

`SongOut`：

```json
{
  "id": 1, "bvid": "BV1Este6wExx",
  "title": "…", "artist": "UP主名", "duration": 258,
  "qualityId": 30280, "qualityLabel": "192K",
  "audioUrl": "/api/songs/1/audio", "coverUrl": "/api/songs/1/cover",
  "createdAt": "2026-09-03T16:40:49"
}
```

### B 站搜索

```http
GET /api/search?keyword=关键词&page=1 → {"keyword": "...", "results": [SearchHitOut]}
```

`SearchHitOut`：

```json
{
  "bvid": "BV1xx411c7mD", "avid": 123,
  "title": "…（已去除高亮 <em> 标签）", "artist": "UP主名",
  "duration": 252, "durationText": "4:12",
  "coverUrl": "https://i0.hdslb.com/bfs/archive/….jpg",
  "play": 123456,
  "importUrl": "https://www.bilibili.com/video/BV1xx411c7mD"
}
```

- 走 WBI 签名综合搜索（`/x/web-interface/wbi/search/all/v2`），只取视频分区；`importUrl` 可直接作为 `POST /api/imports` 的 `url`
- 依赖启动时获取的 buvid3 指纹；搜索是 B 站风控敏感接口，高频调用可能触发 -352/-412
- Web 端：曲库搜索框输入关键词后，本地结果下方展示「B 站搜索结果」（`/partials/web-search`，同词 5 分钟缓存），一键导入

### 扫码登录

```http
POST /api/auth/qrcode          → {qrContent, qrPngDataUrl(data:image/png;base64,…), qrcodeKey}
GET  /api/auth/qrcode/{key}    → {status: waiting|scanned|confirmed|expired}
GET  /api/auth/status          → {loggedIn, username, maxQuality: "64K"|"192K"}
DELETE /api/auth               → 退出登录
```

扫码和短信登录都先在内存中接收凭据，再通过 B 站 `nav` 实时核验账号；只有核验和账号数据保存成功才返回登录成功。
每个服务实例同时激活一个账号。各账号的数据库和 Cookie 分别保存在 `data/accounts/{mid}/`，切换后可恢复原账号曲库；
进行中的请求固定使用开始时的账号，切换会停止旧账号的导入、同步和导出任务。
退出会清除登录凭据与当前账号标记，保留曲库。旧版数据仅在保存身份与实际登录账号一致时迁移，身份冲突时保留原库并要求重新登录。

### 歌单 ⇆ 收藏夹（账号持久化）

曲库强关联 B 站账号，事实源在 B 站侧，自建服务可随时丢弃重建（登录即自动恢复）：

- **歌单 ↔ 收藏夹一一对应**：歌单 `Rock&roll` ↔ 账号公开收藏夹 `bilimusic- Rock&roll`；
  默认歌单「我的曲库」↔ 主夹 `bilimusic`（历史溢出夹 `bilimusic2…` 也归它）
- 单夹上限 2000 条，满了自动建溢出夹（`bilimusic- Rock&roll2`…），理论无限容量
- **改名同步**：歌单改名 → B 站收藏夹同步改名（收藏夹总长约 20 字上限，歌单名建议 ≤9 字）
- **删歌即取消收藏**：DELETE 歌曲时自动从所在夹移除；旧数据夹未知时后台有界扫描
- **自动对账**（登录成功后 / 服务启动已登录时 / 手动触发）：
  - 收养：账号下未被认领的 `bilimusic- X` 夹 → 自动建成歌单 X（换设备恢复歌单结构）
  - 拉取：夹里有、本地没有 → 自动收藏入库
  - 推送：本地有、夹里没有 → 补收藏（1~1.5s/首频控）
  - 回填：补齐本地歌曲缺失的 fav_folder_id

```http
GET  /api/playlists        → {"playlists": [{id, name, folderIds}]}
POST /api/playlists        {"name": "Rock&roll"}  → 201（同步创建收藏夹）
PATCH /api/playlists/{id}  {"name": "新名字"}      → 歌单与收藏夹同步改名
DELETE /api/playlists/{id} → 202 歌单删除：歌曲移入默认歌单（解放），
                             B 站收藏夹一并删除，歌曲收藏后台转移进主夹
POST /api/sync             （无请求体）→ 202 SyncState（已有进行中同步则幂等返回）
GET  /api/sync/{id}        → SyncState
```

`SyncState`：`{id, status: running|done|failed, folders, adopted, pulled, pushed, backfilled, error, failures}`

收藏提交时可用 `playlistId` 指定目标歌单（缺省 = 默认歌单）：
`POST /api/imports {"url": "...", "playlistId": 2}`

### 推荐池（发现）

滚动的链接组：只存 bvid + 元数据，**不下载音频**，每条 7 天过期、读取时懒清理。

- **采集搭车在听歌上**：播放器起播 → POST /api/recs/seed 以当前歌为种子拉 B 站相关视频；
  三重频控（同种子未过期不重复 / 全局最小间隔 10 分钟 / 每日 20 次），无任何后台爬取
- **风格分类**：种子标签 + 候选标题关键词 → 摇滚 / R&B / 流行 / 民谣 / 说唱 / 电子 / 古风 / 爵士
- **今日推荐**：按「日期 + bvid」确定性挑选 12 条，同一天刷新不变，隔天自动轮换
- **试听**：GET /api/stream/{bvid} 实时流代理（现解析 playurl → 透传 CDN 流，
  支持 Range/206，直链域名过 url_guard 白名单，不落盘）

```http
POST /api/recs/seed        {"songId": 1}  → 202（搭车采集，幂等+频控）
GET  /api/recs             ?genre=摇滚|mode=today → {"items": [RecOut]}
DELETE /api/recs/{bvid}    → 不感兴趣，立即出池
GET  /api/stream/{bvid}    → audio/mp4 实时流（Range 206）
```

Web 端：曲库页「发现」板块——今日推荐 + 风格 chips 过滤，卡片带 ▶ 试听 / 收藏（进所选歌单并出池）/ ✕ 不感兴趣。

### 导出（bilimusic 收藏夹同步与分享链接）

```http
POST /api/exports            （无请求体）→ 202 {exportId, total, status}
POST /api/exports/status     {"exportId"}   → {id, status, total, done, folderTitle, link, error, failures}
GET  /api/exports/{id}       → 同上（API 客户端用）
```

- 强制登录下使用；导出 = 确保夹池存在 → 比对全部曲库夹与曲库的差异 → 补收藏缺失歌曲（约 1 首/秒，自动选未满的夹）→ 返回首夹 `link`
- `status`: `pending / syncing / done / failed`；`failures` 为逐首失败明细（bvid + 原因）；正常情况下（入库时已自动收藏）几乎秒回
- `link` 形如 `https://space.bilibili.com/{mid}/favlist?fid={media_id}`（首夹），粘进任意 BiliMusic 导入框即整夹导入（自动去重）；夹池多于一个时 `folderTitle` 为各夹名拼接
- 导出任务状态在内存（服务重启失效）；整夹级持久化/恢复请用上面的「曲库同步」

### 智能过渡（Smart Transition）

切歌不再生硬截断：服务端对每首歌做轻量 DSP 分析（numpy，mono 11kHz，约 0.4s/首，结果缓存
SQLite），浏览器在点 Next / 自然播完前读取缓存的候选切点，配对打分（phrase/beat/BPM/人声/
能量/频谱/边界 加权），用 Web Audio 双 `<audio>` + Equal-Power 增益曲线执行交叉淡化。
队列面板可关闭「智能过渡」（关闭 = 原硬切）。三级降级：智能规划 → 短 crossfade → 硬切，永不中断播放。

**自动决策排序**：播放顺序不再手动指定（无顺序/随机模式）——播放器按过渡得分把整条队列
贪心排成一条「最顺滑」的链（当前歌 → 得分最高的下一首 → …），曲库变化或新分析到位时自动重排，
队列面板即链顺序。隐含循环语义（链尾绕回链首）；「单曲循环」为独立开关。

```http
POST /api/songs/analysis     {"songId": 1}  → 200 TrackAnalysis JSON
                                            → 202 {"status": "analyzing"}（后台分析中，稍后重试）
```

TrackAnalysis 含 `duration / bpm / bpmConfidence / beats / energyCurve / vocalCurve /
centroidCurve / entryPoints / exitPoints`（entry/exit 各 8 个候选，带节拍与乐句对齐标记）。
缓存键 = song_id + analysis_version + duration；分析在后台线程执行，绝不阻塞 API/播放。

### 错误码（B 站 → 展示文案）

`-404` 视频不存在或已删除 · `62002` 稿件不可见 · `62004` 审核中 · `62012` 仅UP主可见 ·
`-403` 无权限（可能需登录） · `-352`/`-412` 触发风控请稍后重试 · `86038` 二维码已失效

## 关键实现说明

- **解析链路**：分享文本正则提 URL → `b23.tv` 短链手动逐跳跟随 302（每跳过白名单与内网校验）→ `BV`/`av` 号 → WBI 签名调用 `x/web-interface/wbi/view`（旧版无签名 view 接口已被 WAF 拦 412）→ `x/player/wbi/playurl?fnval=16` 取 DASH 音轨。
- **分段并发下载**：先以 `Range: bytes=0-0` 探测大小与 Range 支持，≥512KB 的文件按 ~1MB 分段（≤8 段）并发下载，`os.pwrite` 按偏移写入预分配文件后原子改名；单段失败重试 3 次，整体失败自动回退单流。实测 4.4MB 音频约 2s 入库（单流时约 45s）。
- **并发模型**：4 个导入任务并行；所有任务的全部分段共享一个 8 连接全局信号量，批量导入时总连接数有界。
- **设备指纹**：首启经 `x/frontend/finger/spi` 获取 buvid3/buvid4 并持久化，规避 -352；SPI 不可用时本地生成兜底。
- **音频落盘**：DASH 音轨即 fMP4/AAC，直接存 `.m4a` 无需转码；下载带 `Referer: https://www.bilibili.com`，依次尝试 base_url 与 backup_url（CDN 容错），临时文件原子改名。
- **安全约束**：所有外发请求仅 http/https，域名白名单（b23.tv / bilibili.com / hdslb.com / bilivideo.com|cn / akamaized.net），拒绝 localhost、环回、私有、保留地址（含 DNS 解析结果复核）；文件路径统一白名单 + 目录归属校验，杜绝路径穿越。
- **导出实现**：曲库每首歌存有 `bvid` 与 `aid`（av 号，旧数据导出时经 view 接口懒补）。账号下有专用公开收藏夹「bilimusic」：**入库时自动收藏**（`favorite_song`，夹被删自动重建），导出 = 差异比对补收藏 + 生成链接。导出的收藏夹链接天然兼容既有收藏夹批量导入链路，导入端零改动。
- **强制登录**：除登录流程（`/api/auth/*`）外的全部 API 要求已扫码登录（401），Web 页未登录一律 307 跳登录页。
- **风控现实**：B 站接口无官方兼容承诺。解析逻辑集中在 `app/bili/` 与 `app/core/`，接口改版时单点修复。个人低频使用基本无感。

## 数据与部署

```
data/
  accounts/{mid}/
    bilimusic.db     # 该账号的曲库（SQLite）
    cookies.json     # 该账号的登录凭据（0600）
  active_mid         # 当前账号标记，退出时清除
  bilibili_music.db   # 未迁移的旧版曲库，归属核验后封存为 .claimed
  music/{bvid}.m4a    # 音频
  covers/{bvid}.jpg   # 封面
  cookies.json        # 设备指纹；迁移后清除旧版登录凭据
```

Docker：

```bash
docker build -t bilimusic .
docker run -d -p 8000:8000 -v bilimusic-data:/srv/data --name bilimusic bilimusic
```

外网访问：部署到云服务器，或家里宽带 + 内网穿透（frp / Tailscale 等）。

## 测试

```bash
.venv/bin/python -m pytest -q
```

覆盖：WBI 签名（官方文档黄金向量）、URL 安全校验（内网/白名单/DNS 复核）、链接解析（短链重定向 Mock、私网重定向拒绝、裸 BV 号、收藏夹 fid 识别）、分段并发下载（字节级校验 + Range 不可用回退）、Smart Transition（合成信号 BPM 检出、Intro/Outro 候选点、scorer/planner/策略——`node --test tests/test_transition.js`）。

## 二期对接（Flutter 安卓端）

- 分享接收：`receive_sharing_intent` 收到 B 站 App 分享文本 → `POST /api/imports`
- 播放：`just_audio_background` 直接播 `audioUrl`（Range 已支持，锁屏/通知栏原生可用）
- 建议增加「播过即缓存」：首次播放后把音频文件缓存到应用目录，离线可听
- 登录态在后端，App 无需处理 B 站凭据
