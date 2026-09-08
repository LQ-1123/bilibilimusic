# BiliMusic 下一步计划（Next Steps）

> 维护日期：2026-09-08 ｜ 配套：`docs/issue-ledger.md`（问题台账）、`docs/acceptance-manual.md`（验收手册）
> 当前基线：台账 25 组验收项 **通过 18 组**；代码已提交至 `dc44bc1`（六笔：upic 头像 / F0 cid 流路由 / 前端体验批 / Android 壳 / 桌面启动页 / 文档）。

---

## 0. 已完成速览（本日两个批次）

| 范围 | 内容 |
|---|---|
| 后端 | F0 cid 流路由（`?cid=` 校验 + audioUrl 携带 cid）；建歌单 307 重定向根因修复 |
| Web 前端 | 滑条粉色填充、移动三键顺序、空格播放、走马灯标题、歌词蓝框/对比度、返回语义 back-stack、移动路由收口、前台轮询、建歌单加固 |
| Android 壳 | 系统栏沉浸（方案 A+B）、品牌启动页（图标 + 淡入）、返回键桥、浏览器登录兜底、onJsPrompt/Confirm、debug WebView 调试、缺失图标资源补齐 |
| 桌面 | 深色品牌启动页 |

验收方式与结果明细见 `acceptance-manual.md` §9；模拟器环境配方见该文件末尾。

---

## 1. 下一批（建议立即开工）：#14 专辑一期（多分P paged）

进度：**全链路已通（2026-09-08 会话内实测，Android 15 模拟器）**——导入 17P 视频→专辑+17 曲目（各自 cid）→详情→按分 P 播放（P2 = 对应 cid 流）→分 P 歌词（P1/P2 的 CC 内容不同）→删除+重导入复测 ✅；含下拉刷新。会话内修复：导入 DetachedInstance（会话外访问过期 ORM 属性）、`albumRequest` 端点对齐（原拉 meta 无 songs）、`MediaPlaybackService` 包名/目录错位（编译断点）。
剩余：删专辑的 B 站侧取消收藏 ✅、>300P 懒物化 ✅（materialize 端点 + playAlbum 循环）、分 P 标题清洗 ✅、series 二期（独立开工）。

**目标**：粘贴多分 P 视频链接（≥2P）导入为「专辑」，按分 P 播放/看词/收藏，行为符合台账 #14 语义矩阵。F0 的 cid 流路由已就绪，这是它的价值兑现。

**拆解（按依赖顺序）**：
1. **数据层**：新增 `Album(kind="paged", source_bvid, title, artist, cover_url, total_pages)`；`Song` 加 `album_id/track_no`，`bvid` 唯一约束迁移为 `(bvid, cid)`（写 Alembic 式启动迁移，注意旧库 `bvid` 唯一索引重建）。
2. **导入**：importer 检测 `?p=` 或 pages>1 → 一次 wbi/view 拉全部分 P（`video_page_cids` 已有，需扩展成 pages 元数据：cid/part 标题/时长），批量建 Song 行 + Album 行；>300P 懒物化保护；分 P 标题清洗（去「01 ·」序号噪声，复用 lyrics 的 title_candidates 思路）。
3. **播放**：audioUrl 已带 cid（F0 完成），队列按 track_no 排序。
4. **歌词**：各 P 按自己 cid 取 CC/AI；LRCLIB 用分 P 标题匹配（`fetch_preview` 需支持传 cid）。
5. **UI**：曲库「专辑」区（卡=封面/标题/艺人/曲数）→ 专辑详情页（编号/曲名/时长 + 整张播放）；收藏/删除为专辑级（B 站夹整视频一次，语义矩阵见台账）。
6. **验收**：`acceptance-manual` §6 #14 一期清单逐条；重点回归普通单视频导入零回归。

**预估**：数据层+导入 2~3 天，UI 2~3 天，语义与回归 2 天。

## 2. #3+#4 原生播放第一段——已落地（前台服务 + 播放通知），余媒体卡片升级

- `MediaPlaybackService`（foreground）+ MediaStyle 通知（封面/进度/上一首/下一首，点击回 App）；
- Android 14+ `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 权限、13+ 运行时 `POST_NOTIFICATIONS`；
- JS 播放命令暂不走桥，先做「原生侧镜像播放状态」的最小闭环（Web 起播时把曲元数据推给壳，壳起前台服务托管音频焦点）；
- 锁屏/蓝牙 AVRCP/Smart Transition 迁移留二、三段。
- 实测：播放中 dumpsys 可见前台通知（标题/艺人）；`playbackStopped` 已接队尾/边界停。
- 三键按钮已用系统 Notification Action 实现 ✅（通知栏实测：暂停/上下曲回控 WebView 生效）；封面大图 + 进度条 + Media3 Session 留升级。
- **验收**：手册 §3 #3 基础项已过；媒体卡片交互（进度/按钮）待 Media3 Session 升级后验。

## 3. 穿插小项（每项 ≤1~2 天，可任意插队）

| 项 | 内容 | 备注 |
|---|---|---|
| #10 歌词源 | 网易云源（限频+静默降级+来源角标）+ 歌词页「重试/换源」（`?force=1`） | 中文覆盖率主提升 |
| #11 下拉刷新 | 前端自绘 PTR，仅移动端 feed 视图顶部 | 纯前端 |
| #20 无边框 | Rust `decorations(false)` + capabilities remote 授权 + 自绘三键/拖拽 | spike 已过：remote IPC 授权方案确定，cargo check + smoke 通过 ✅；剩屏幕目检 |
| ~~#22 关闭按钮~~ | 已按「hover 显现」落地（style v153） | ✅ 完成 |
| #12 截断点位 | 等你截图指认具体位置 | title 全文已全员兜底 |
| #6 性能 | 真机 profile 后定点（封面缩略/backdrop-filter 审计） | 需实体真机 |

---

## 4. 待用户输入

- [x] #22 关闭按钮：已按「hover 显现」落地（2026-09-08）。
- [x] #12：用户确认保持现状，关闭。
- [ ] 实体真机抽查排期：手势导航返回手感、锁屏 30 分钟、横向刘海、性能手感（模拟器已覆盖其余验收）。

## 5. 工程事项

- [x] `tests/test_recs.py` 3 个预存失败（2026-09-08）：核对 `c74e725` 的十类体系调整后更新旧分类断言；命中数优先测试改用现有蓝调/摇滚金属分类，保留双向比较覆盖。
- [x] #10 现有歌词链路优先级修复（2026-09-08）：LRCLIB 纯文本不再抢占 AI 时间轴字幕；没有 AI 时仍回退纯文本，保留纯音乐标记。新增 4 个测试。完整 Python 回归 **111 passed / 2 skipped**（缺真实音频样本），前端 Node 回归 **17 passed**。现有 `datetime.utcnow()` 弃用警告仍在；旧歌词缓存不自动重取，网易云源与重试入口仍待实现。
- [ ] 提交已完成（`3eb2ad0..dc44bc1` 六笔）；`out/`、`.dsh-paste/`、`android/out/`、`.DS_Store` 为会话草稿，未入库。
- [ ] 桌面端 `npm run dev` 冷启目检 #9 启动页（代码已就位，未目检）。

## 6. 验收环境速查

- 模拟器：AVD `BM35`（API 35 arm64，Pixel 6，三键导航），配方与 CDP 驱动见 `acceptance-manual.md` 末尾。
- 构建：`cd android && JAVA_HOME=… PATH=python3.11:$PATH PIP_INDEX_URL=阿里云 ./gradlew assembleDebug`（详见 acceptance-manual 环境节）。
- 种子数据：`adb push` DB/cookies/active_mid → `run-as` 拷入 `files/data/`。
