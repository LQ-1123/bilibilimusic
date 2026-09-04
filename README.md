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
DELETE /api/songs/{id}         → 删除记录与本地文件
```

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

### 扫码登录

```http
POST /api/auth/qrcode          → {qrContent, qrPngDataUrl(data:image/png;base64,…), qrcodeKey}
GET  /api/auth/qrcode/{key}    → {status: waiting|scanned|confirmed|expired}
GET  /api/auth/status          → {loggedIn, username, maxQuality: "64K"|"192K"}
DELETE /api/auth               → 退出登录
```

### 导出（bilimusic 收藏夹同步与分享链接）

```http
POST /api/exports            （无请求体）→ 202 {exportId, total, status}
POST /api/exports/status     {"exportId"}   → {id, status, total, done, folderTitle, link, error, failures}
GET  /api/exports/{id}       → 同上（API 客户端用）
```

- 强制登录下使用；导出 = 确保账号下存在公开收藏夹「bilimusic」→ 比对补收藏缺失歌曲（约 1 首/秒）→ 返回 `link`
- `status`: `pending / syncing / done / failed`；`failures` 为逐首失败明细（bvid + 原因）；正常情况下（入库时已自动收藏）几乎秒回
- `link` 形如 `https://space.bilibili.com/{mid}/favlist?fid={media_id}`，粘进任意 BiliMusic 导入框即整夹导入（自动去重）
- 专用夹的 media_id 缓存于 `cookies.json`，用户在 B 站侧删夹后会自动重建；收藏夹标题上限约 20 字
- 导出任务状态在内存（服务重启失效）

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
  bilibili_music.db   # 曲库（SQLite）
  music/{bvid}.m4a    # 音频
  covers/{bvid}.jpg   # 封面
  cookies.json        # buvid 与登录 cookie（0600，仅本机可读）
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
