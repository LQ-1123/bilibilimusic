# BiliMusic 问题与功能台账（Issue Ledger）

> 建立于 2026-09-09。本文件此前被 `docs/acceptance-manual.md:3` 引用但缺失，现补齐。
> 维护约定：**本文件只维护「新增条目」与「状态」**；历史条目按来源索引，不复制正文，避免两处维护。

---

## 0. 条目来源与编号规则

| 来源 | 范围 | 说明 |
|---|---|---|
| `docs/acceptance-manual.md` | 验收项 #1 ~ #22 | 「操作 → 期望」的可执行验收步骤与通过标准 |
| `docs/bugs.md` | BUG-001 ~ BUG-005、FEAT-001 | 用户真机实测确认的 bug（现象→根因→修复→验证） |
| `docs/frontend-prd.md` | 接口契约、G-1~G-11 接口缺口、D-1~D-16 缺陷、重设计功能分级 | 前端重设计的契约与依据 |
| 本文件 | **#23 起的新增条目** | 功能提案、架构级改动、跨端能力 |

编号沿用验收手册的数字序列（#23 接在 #22 之后），条目内标注类型：`功能` / `缺陷` / `架构`。

---

## 1. 条目索引

| 编号 | 类型 | 标题 | 状态 | 详情位置 |
|---|---|---|---|---|
| #1 ~ #22 | 验收 | 系统壳/原生能力/播放控件/启动性能/内容数据 | 27/27 组通过，遗留 #3 深段、#14 series 二期 | `docs/acceptance-manual.md` |
| BUG-001 ~ 005 | 缺陷 | 收藏夹翻页、极验滑块、验证码错误、计数口径、推荐卡 fab | 均已修 | `docs/bugs.md` |
| FEAT-001 | 功能 | 登录改「二维码存相册 + 拉起 B 站 App」 | v1.0.1 已上线 | `docs/bugs.md:79-89` |
| **#23** | **功能** | **多端同步与跨端接力（Spotify Connect 式）** | **Phase 1 已实现（2026-09-10）；Phase 2 待做** | **本文件 §2 / §2.12** |
| **#24** | **缺陷** | **多 P 专辑曲目名冗余（「专辑名 · 分集名」）** | **待排期（用户：先不改代码）** | **本文件 §3** |
| **#25** | **功能** | **分享能力：正向原生分享面板 + 反向分享目标接收** | **已实现（Web/桌面已验证，Android 待重新打包验收）** | **本文件 §4** |

---

## 2. #23 多端同步与跨端接力（Spotify Connect 式）

> 类型：功能 ｜ 状态：**Phase 1 已落地**（设备注册 + 服务端会话 + 只读展示 + 打开即续播，2026-09-10）｜ Phase 2（命令通道 + 移交握手）待做 ｜ 提出于 2026-09-09
> 一句话：同账号的多台设备共享一份权威播放会话，可在设备间查看对方在放什么，并把播放无缝接到自己这台设备上。

### 2.1 背景

对标 YouTube Music / Spotify 的多端体验。当前 BiliMusic 的队列与播放进度只存在各自浏览器的 `localStorage.bmSession:<mid>`（`app.js:194-229`），设备之间互相不可见——手机上听到一半，走到电脑前只能从头开始。

架构上已具备三个有利条件：

| 条件 | 证据 |
|---|---|
| 音频由后端代理，任何设备可独立解析同一条流 | `/api/stream/{bvid}?cid=`，`app/api/routes.py:705-760` |
| SSE 事件总线按 mid 过滤，天然支持多订阅者 | `app/events.py:10` `_subs: set[tuple[mid, Queue]]` |
| 进程内任务单例有成熟先例 | `app/services/sync.py:44` `SyncState`、`:83` `self._current`、`app/services/exporter.py` `ExportState` |

**关键结论**：跨端接力转移的是**会话状态**，不是音频数据。接收端自己向后端取流并 seek 到目标位置即可（Spotify Connect 同原理）。

### 2.2 目标场景（主场景）

1. 手机与电脑用同一 B 站账号登录，处于同一局域网，指向同一个后端进程。
2. 手机正在播放某首歌（例如 3:42）。
3. 电脑打开页面，设备列表显示「iPhone · 正在播放 · <歌名> · 3:42」，进度随手机推进。
4. 电脑点「转到此设备播放」。
5. 手机停止出声（淡出并暂停），电脑从 3:42 继续播放。
6. 手机变为遥控器：显示当前进度与控制键，可控制电脑。

### 2.3 非目标（本期不做）

- **不同账号**之间的会话可见性（账号间严格隔离，按 mid 划分）。
- **跨网络**（手机在 4G、电脑在家）——需反向代理/HTTPS + `BM_API_TOKEN` 或 VPN，属部署问题，不在本期。
- **关掉页面后继续播**（Web 限制）；Android 前台服务 `MediaPlaybackService` 是唯一能后台播的端。
- **音量同步**（Spotify 也是设备本地音量，同步只会互相打架）。
- 真·无间隙交叉淡入（列为 Phase 3，可延后）。

### 2.4 服务端设计

```python
# 进程内单例，写法对齐 SyncState
@dataclass
class Device:
    id: str            # 客户端生成 UUID，存 localStorage.bmDeviceId
    mid: str
    name: str          # 可编辑，默认取平台名（iPhone / Mac / Android）
    kind: str          # browser | tauri | android
    last_seen: float

@dataclass
class Session:
    mid: str
    active_device_id: str | None
    queue: list[dict]      # 队列项：{bvid, cid, songId?, source, title, artist, coverUrl}
    index: int
    position: float        # active 设备上报的秒数
    reported_at: float     # 服务器时间戳（控制器端据此外推显示）
    playing: bool
    repeat: str            # off | all | one
    shuffle: bool
    revision: int          # 乐观并发：命令携带 revision，过期即丢弃
```

- **隔离**：`Session` 与 `Device` 均按 `mid` 划分，跨账号不可见。
- **持久化**：Phase 1 仅内存（服务重启即丢，客户端 `hello` 时重建）；Phase 2 可选加 `playback_session` 表做重启续播。
- **权威性**：`position` 只接受 active 设备的 `PUT`；其他设备的写入返回 `409`。

### 2.5 接口设计

| 方法 | 路径 | 请求 | 响应 | 说明 |
|---|---|---|---|---|
| POST | `/api/devices/hello` | `{deviceId,name,kind}` | `{session,devices}` | 设备注册 + 拉会话快照 |
| GET | `/api/devices` | — | `{devices:[{id,name,kind,lastSeen,active,playing}]}` | 设备列表（`lastSeen>30s` 标记离线） |
| GET | `/api/session` | — | `session` | 会话快照 |
| PUT | `/api/session` | `{deviceId,position,playing,index,revision}` | `session` | **仅 active 设备**；revision 过期 → 409 |
| POST | `/api/session/command` | `{deviceId,type,payload,revision}` | `202` | 转发给 active；type ∈ play/pause/next/prev/seek/setQueue/transfer |
| POST | `/api/session/transfer` | `{fromDeviceId,toDeviceId}` | `202` | 发起移交 |
| POST | `/api/session/position` | `{deviceId,position}` | `200` | 移交时发送端**现报**精确进度 |
| POST | `/api/session/claimed` | `{deviceId,position}` | `200` | 接收端就绪，正式接管 |

**SSE 扩展**（`app/events.py` 的 `publish(mid, name)` 需加 payload 参数）：

```
event: sessionChanged   data: {session}
event: transferRequest  data: {toDeviceId}                      → 发给发送端
event: transferIn       data: {queue,index,position,revision}   → 发给接收端
```

> 回归要求：现有 `libraryChanged` / `playlistsChanged` 订阅端（`app/api/routes.py:525-552`、`v3.js:1707-1727`）必须继续工作，payload 扩展需向后兼容。

### 2.6 移交时序（两条决定体验的规则）

```
手机(active)                后端                    电脑(controller)
   │── PUT position ────────>│<──── hello / GET devices ──│
   │                          │──── sessionChanged ───────>│ 显示「手机正在播放 3:42」
   │                          │<──── POST transfer ────────│ 用户点「转到此设备」
   │<──── transferRequest ────│
   │── 现报精确 position ────>│   ← 规则①：不用缓存值，现场读 audio.currentTime
   │   （淡出并暂停）          │
   │                          │──── transferIn{position} ─>│ 预加载 + seek + 等 canplay
   │                          │<──── POST claimed ─────────│
   │<──── sessionChanged ─────│──── sessionChanged ───────>│
   │  变遥控器态               │                            │ 开始出声
```

- **规则①：进度必须「现报」。** 若用服务端缓存的心跳值（可能 3 秒前），接收端会跳回去。移交时反向问发送端一次，误差从「最多 3 秒」降到「几十毫秒」。
- **规则②：不杀发送端，直到接收端确认。** 顺序必须是「接收端 canplay → 才让发送端淡出」。任一步失败（加载失败、自动播放被拒、超时），发送端继续播放，接收端提示失败。最糟的体验是两端都没声音。

### 2.7 边界与容错

| # | 情况 | 处理 |
|---|---|---|
| 1 | 发送端设备离线（`lastSeen>30s`） | 列表置灰，点击提示「设备未响应」，不发起移交 |
| 2 | 接收端 `canplay` 超时（默认 5s） | 回滚：发送端继续播放，接收端提示「切换失败，请重试」 |
| 3 | 接收端自动播放被浏览器拒绝 | 显示「点一下继续」；发送端保持播放直到收到 `claimed`（该按钮的点击即用户手势） |
| 4 | 两台设备同时播放 | 显式 `transfer` 优先；被抢占的一方弹提示「已在电脑上继续播放」 |
| 5 | 非 active 设备上报 position | `409`，客户端重新 `GET /api/session` |
| 6 | `revision` 冲突 | 客户端拉最新快照后重试命令 |
| 7 | 服务重启 | 会话丢失；客户端 `hello` 重建（Phase 2 可选持久化） |
| 8 | 同一浏览器多标签 | 共享同一 `deviceId`（视为同一设备），避免列表刷屏 |
| 9 | 后台标签页定时器被节流 | `visibilitychange` 回前台补报一次 position（现有任务轮询已用此模式，`v3.js:1419-1430`） |
| 10 | Android 后台 JS 冻结 | 依赖 `playbackProgress` 桥事件上报（`MainActivity.java` 已具备） |
| 11 | 退出登录 | `accounts.logout()` 是全局的（`app/services/accounts.py:123-131`）——一台设备退出，所有设备退出、设备列表清空。需在 UI 上明示 |
| 12 | 音量 | 不同步，各设备本地 |

### 2.8 验收标准（操作 → 期望）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 手机播放中，电脑打开页面 | 设备列表出现手机，显示歌名与实时进度（±1s） |
| 2 | 电脑点「转到此设备播放」 | 手机 300ms 内淡出暂停；电脑从同一进度继续（误差 ≤1s） |
| 3 | 移交时电脑断网 | 手机继续播放不中断；电脑提示失败 |
| 4 | 手机端页面关闭后再点该设备 | 该项置灰，提示「设备未响应」 |
| 5 | 电脑暂停 | 手机遥控器态同步显示暂停 |
| 6 | 手机遥控电脑 next / prev / seek | 电脑响应，两端进度一致 |
| 7 | 服务重启后双方刷新 | 会话重建，无报错、无残留幽灵设备 |
| 8 | 两台设备先后播放 | 只有一台 active，另一台被抢占并给出提示 |

### 2.9 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| Phase 1 | 设备注册 + 服务端 Session + 只读展示 + 打开即续播 | ~1 天 |
| Phase 2 | 命令通道 + 移交握手（现报进度、不杀发送端）+ 手机遥控 | ~2-3 天 |
| Phase 3 | 预加载 `canplay` + 交叉淡入，消除那不到 1 秒的间隙 | ~3 天 |

### 2.10 依赖与风险

| 项 | 说明 |
|---|---|
| 依赖 A | `app/events.py` 的 `publish` 需扩展 payload（向后兼容现有两个事件） |
| 依赖 B | **前端播放器内核需收敛为单一数据源**——否则 position 上报点散落在 `app.js` 的全局变量里（见 `docs/frontend-prd.md` §15 B.4）。这条与「重设计播放器 store」强耦合，建议同期做 |
| 依赖 C | 设备身份需新增 `localStorage.bmDeviceId`（现有 8 个键之外） |
| 风险 1 | 浏览器自动播放策略：接收端必须有用户手势；Android 已关该限制（`MainActivity.java:275`） |
| 风险 2 | Web 端关标签即停播，跨端体验上限受浏览器限制 |
| 风险 3 | 局域网外不可用，跨网络需额外部署（反向代理 + HTTPS + `BM_API_TOKEN`） |
| 风险 4 | 安全面：持有 token 的任意设备可控制播放；个人局域网可接受，公网部署需说明 |

### 2.11 与既有条目的关系

| 既有条目 | 关系 |
|---|---|
| `frontend-prd.md` **G-3**（队列跨端） | 本条目直接覆盖：队列上移服务端后，G-3 关闭 |
| `frontend-prd.md` **G-4**（播放进度/跨端续播） | 本条目直接覆盖：Phase 1 完成即关闭 |
| `frontend-prd.md` **D-16**（主/歌词双轨进度） | 本条目要求单一数据源，与 D-16 的修法一致 |
| `BUG-001`（多设备曲库数量不一致） | 设备列表可显示每台设备最后同步时间，使不一致**当天可见**，是该项的长期可观测性补充 |
| `#3+#4`（后台播放/系统媒体条） | 互补：Android 前台服务是接力链路里唯一能后台运行的端 |

### 2.12 实现落点与验证（Phase 1，2026-09-10）

| 层 | 文件 | 内容 |
|---|---|---|
| 服务端 | `app/services/session_bus.py` | `Device` / `PlaybackSession` + `SessionBus` 进程内单例（按 mid 隔离，写法对齐 `SyncState`）；30s 无上报算离线、10 分钟清设备、设备表上限 12、队列表上限 200、同设备 1s 上报防抖（换歌/拖拽不受限） |
| 服务端 | `app/api/routes.py` | `POST /api/devices/hello`、`GET /api/devices`、`GET /api/session`、`PUT /api/session`（上报后发 `sessionChanged`） |
| 服务端 | `app/events.py` | `publish(mid, name, data=None)`：队列项统一 `(name, data)`；SSE 端 `data` 为空时仍只发事件名（旧监听器行为不变）→ 事件可携带结构化负载 |
| 前端 | `app/web/static/session-sync.js`（新） | 设备身份 `localStorage.bmDeviceId`（同浏览器多标签=一台）、平台名、hello、心跳（切歌/播放暂停/拖动/每 5s/回前台/关闭前）、队列面板里的「设备 · 同账号跨端」区（进度按上报时刻外推，±1s）、「从 X 的 3:42 继续」= 打开即续播 |
| 前端 | `app/web/static/app.js` | `BiliPlayer.queue()`（上报用队列快照）、`BiliPlayer.adopt(items, index, at)`（把远端队列搬到本机：按 bvid+cid 自建 `/api/stream` 地址、从同一进度开始） |
| 前端 | `app/web/static/v3.js` | 复用现有 EventSource，把 `sessionChanged` 转成 DOM 事件 `bm:sessionChanged`（不再开第二条 SSE 连接） |

**与提案的差异（有意）**：① SSE 事件里**不带整条队列**（只带摘要 + `queueSize` + `queueChanged`），
客户端点「继续」时再 `GET /api/session` 拉全量——否则每 5 秒推几十 KB；② Phase 1 用响应里的
`accepted/preemptedDeviceId` 表达「你是不是 active、被谁抢了」，暂不用 409（Phase 2 做显式移交时再收紧）。

**验证**：

- 单测：`tests/test_session_bus.py` 9 例（注册/首播成 active/被抢标记/非 active 不改会话/进度外推/防抖与跳变/离线与清理/设备表上限/账号隔离）；
  `tests/test_session_api.py` 3 例（hello→上报→快照、上报发 `sessionChanged` 且不带队列、第二台抢占用 `preemptedDeviceId`）；`tests/test_events.py` 补 payload 用例。**181 passed / 2 skipped**。
- 端到端（两个独立 Chrome 实例 = 两台设备）：A 上报「正在播放 爱的初体验 @42.5s」→ B 打开页面即在队列面板看到
  `Mac · 正在播放 · 张震岳 - 爱的初体验 · 0:45`；A 推进到 88.25s → B **不刷新**自动变 `1:28`（SSE ✓）；
  B 点「从 Mac 的 0:45 继续」→ 本机播放条变成同一首歌、队列 2 首、提示「已从 Mac 的进度继续」；
  B 上报在播 → 会话切到 B、A 收到「已在另一台设备上继续播放」（验收 #8 的抢占提示 ✓）。

---

## 3. #24 多 P 专辑曲目名冗余（「专辑名 · 分集名」）

> 类型：缺陷 ｜ 状态：**待排期（用户拍板：先不改代码，仅登记）** ｜ 记录于 2026-09-10 ｜ 用户真机实测反馈

### 3.1 现象

多 P 视频被解析为专辑后，专辑详情里每一条曲目都显示「专辑名 · 分集名」（例：`陶喆合集 · 晴天`）。专辑名在详情页 hero 已经展示过一次，逐行重复是冗余。

**用户诉求**：只要分集名（`晴天`）。

### 3.2 根因（代码定位）

| 位置 | 作用 |
|---|---|
| `app/services/importer.py:39-49` | `part_display_title(main, part)`：分集名不含主标题时返回 `f"{main} · {cleaned}"` |
| `app/services/importer.py:189-196` | 专辑**首行**标题：`title = f"{info.title} · {suffix}"`（首行同样带前缀） |
| `app/services/importer.py:241` | 多 P 专辑**子曲目行**：`title=part_display_title(info.title, page.part)` |
| `app/services/importer.py:359,365` | **系列（series）** 路径同样调用该函数 |
| `app/api/routes.py:246` | 懒物化补建的分 P 行同样带前缀 |

关键点：拼接发生在**导入时写入 `Song.title`**，不是渲染时拼接。所以新导入与历史数据都会带前缀，改渲染层解决不了老数据。

### 3.3 关键约束（不能一刀切改）

`part_display_title` 同时服务两种语义：

| 场景 | `main` 是什么 | 前缀是否冗余 |
|---|---|---|
| **paged 专辑**（多 P 视频） | 专辑标题，**所有行相同** | 冗余，应去掉 |
| **series 合集**（跨视频系列） | 该视频自己的标题，**每个视频不同** | **必须保留**，是区分作品的关键信息 |

因此修复必须按 `Album.kind` 分流，否则会破坏系列合集的可读性。

### 3.4 期望行为

1. paged 专辑详情每行显示分集名（`晴天`、`夜曲`），专辑名只在 hero 展示。
2. series 合集保持「视频标题 · 分集名」。
3. 曲库 / 队列 / 播放条中，专辑曲目同样显示分集名（同一份 `Song.title`）。

### 3.5 修复方案（待实施，勿在未排期时动手）

1. `part_display_title(main, part, *, with_main=True)` 增加参数；`with_main=False` 只返回分集名。
2. paged 路径改传 `with_main=False`：`importer.py:241`、`routes.py:246`、专辑首行（`importer.py:189-196`，首行取 P1 的分集名）。
3. series 路径（`importer.py:359/365`）保持默认 `with_main=True`，不动。
4. **历史数据回填**：在 `app/db/session.py::_init_engine` 加一次性幂等收敛——仅当 `Song.title` 以「专辑名 + 分隔符」开头、且 `Album.kind == "paged"` 时剥离前缀。
5. 测试：更新 `tests/test_albums.py:74-84`，补两种语义 + 误伤用例。

### 3.6 风险

| 风险 | 说明 |
|---|---|
| 系列被误改 | 必须按 `album.kind` 分流；series 去前缀会丢作品标识 |
| 回填误伤 | 必须要求「主标题 + 分隔符」严格匹配。反例：`main=「月亮」`、`title=「月亮代表我的心」`，做子串剥离会变成「代表我的心」 |
| 首行仍是冗余 | 专辑首行当前存的是视频标题（= 专辑名），只改子行不改首行，第一行依旧冗余 |
| 不可恢复的历史行 | 旧数据中「分集名是主标题子串」的行，`Song.title` 存的是专辑名，分集名已丢失；除非重新拉取 B 站分 P 列表回填，否则只能保持现状 |

### 3.7 验收标准（操作 → 期望）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 导入一个多 P 视频 | 专辑详情每行显示分集名，无「专辑名 · 」前缀 |
| 2 | 打开已有（历史）专辑 | 旧曲目名同样收敛为分集名 |
| 3 | 导入一个系列合集 | 每行仍是「视频标题 · 分集名」，能区分不同作品 |
| 4 | 查看曲库 / 播放条 | 专辑曲目显示分集名 |
| 5 | 边界 | 分集名为空 → 回退显示视频标题；分集名与专辑名相似（`月亮` / `月亮代表我的心`）不被误裁 |

---

## 4. #25 分享能力：正向原生分享面板 + 反向分享目标接收

> 类型：功能 ｜ 状态：已实现（Phase 1+2 落地；Android 侧需重新打包后真机验收）｜ 记录于 2026-09-10 ｜ 用户确认登记

### 4.1 背景与目标

现状分享只有「复制链接」一种形态（`v3.js:581/593/770/1338`、`export.js:109-121`），没有系统分享面板；`AndroidManifest.xml` 只注册了 `MAIN`/`LAUNCHER`，**不能接收分享**。

两个方向：

| 方向 | 目标 |
|---|---|
| **正向** | 点分享 → 唤起系统分享面板（Android 走原生桥），分享**真实 B 站链接** |
| **反向** | 在 B 站 App 点分享 → 系统面板里出现 BiliMusic → 一步入库 |

### 4.2 边界（必须写清，避免误解）

1. **别人通过微信/QQ 发来的 B 站链接，不会自动用 BiliMusic 打开。** 拦截 `bilibili.com` 需要 App Links（该域名下放 `assetlinks.json` 授权），域名归 B 站，拿不到；自定义 scheme 微信/QQ 基本不唤起。
2. 反向能力**仅限**：同一台手机、用户在系统分享面板里**主动选择** BiliMusic。
3. 点 B 站链接仍然进 B 站 App 或浏览器——这是**预期行为，不是 bug**。
4. **不做视觉仿冒**：不把分享卡片做成 B 站品牌样式（README 已声明与 Bilibili 无官方关联，冒用标识有商标与平台条款风险）。分享真链接即可获得 B 站预览卡。

### 4.3 现状与代码定位

| 现状 | 位置 |
|---|---|
| 单曲分享（复制链接） | `v3.js:1338-1345`（clipboard + toast，**无 execCommand 回退**） |
| 歌单分享 | `v3.js:586-593` → `GET /api/playlists/{pid}/share-link` |
| UP 主页分享 | `v3.js:770-773` |
| 导出弹窗复制 | `export.js:109-121`（**有** execCommand 回退） |
| 无 `navigator.share` | 全仓 grep 无 |
| Android 桥 8 个方法，无分享 | `MainActivity.java:160-196` |
| 无分享 intent-filter | `AndroidManifest.xml` 仅 MAIN/LAUNCHER |

### 4.4 方案

**正向（分享出去）**

1. Android 加桥方法 `shareText(title, text, url)`：`Intent.ACTION_SEND` + `Intent.createChooser`（沿用现有 `@JavascriptInterface` 模式）。
2. 前端能力探测降级链：`BiliMusicNative.shareText` → `navigator.share` → `navigator.clipboard` → `execCommand` 兜底。
3. 分享内容映射：

| 对象 | 分享什么 |
|---|---|
| 单曲 | `https://www.bilibili.com/video/{bvid}`（真链接，自带 B 站预览卡） |
| 歌单 | B 站收藏夹链接（`/api/playlists/{pid}/share-link` 已有） |
| 专辑（paged） | 该多 P 视频链接 |
| 系列（series） | ⚠️ 当前拼不出，见 4.5 缺口 1 |
| 曲库整体 | 主夹链接 |

**反向（收进来）**

4. `AndroidManifest.xml` 加 intent-filter：`ACTION_SEND` + `text/plain`（可选 `text/*`）。
5. `MainActivity` 读 `EXTRA_TEXT` → 交给 WebView 或直接 `POST /api/imports/batch`。
6. **后端已具备**：`POST /api/imports/batch` 能处理完整分享文本（`【标题】 https://b23.tv/xxx`），`link_parser` 会跟随 `b23.tv` 短链跳转，识别单视频/收藏夹/系列三种形态（`app/services/batch.py:29-63`）。

### 4.5 已知缺口

| # | 缺口 | 位置 | 处理 |
|---|---|---|---|
| 1 | **系列合集分享链接拼不出**：`Album` 无 `mid` 字段，`source_bvid` 存的是 `sid:<id>`，前端无法拼 `collectiondetail?sid=` 链接 | `app/db/models.py:21-30`、`app/api/routes.py:191-196` | ✅ 已修：`Album.mid` + 幂等迁移（`app/db/session.py:_migrate`）；`_album_out` 直接下发 `mid`/`shareUrl`；新增 `GET /api/albums/{id}/share-link`，老容器用任一曲目 bvid 反查 UP 并回填 |
| 2 | 局域网 `http://192.168.x.x` 非安全上下文 → `navigator.clipboard` 不可用，`v3.js` 无 execCommand 回退（只有 `export.js` 有） | `v3.js:1338-1345` | ✅ 已修：统一到 `app/web/static/share.js` 的 `__copyText`（clipboard → execCommand），`export.js` 也改用它 |
| 3 | `EXTRA_TEXT` 形态多样（纯文本/短链/带标题/多段） | — | ✅ 已处理：复用 `submit_any` 解析；前端先做一次「有没有 B 站链接/BV/av」预检（无则直接说清），`/api/imports/batch` 的 `ValueError` 改回 400 可读原因 |
| 4 | 分享图片卡需要 FileProvider + 临时文件 + 读权限授权 | — | 列为 Phase 3，可选（未做） |

### 4.5.1 实现落点（2026-09-10 落地）

| 层 | 文件 | 内容 |
|---|---|---|
| 后端 | `app/core/share_links.py` | 纯函数拼链接：`video_link` / `fav_folder_link` / `series_link` / `series_sid` / `album_share_url`（缺字段返回空串，绝不拼半截链接） |
| 后端 | `app/api/routes.py` | `_album_out` 增 `mid`/`shareUrl`；`GET /api/albums/{id}/share-link`（系列缺 mid 时懒回填）；`POST /api/imports/batch` 的 `ValueError/BiliApiError/httpx` → 400 |
| 后端 | `app/bili/client.py` | `video_owner_mid(bvid)`：反查 UP mid（失败静默返回 0） |
| 后端 | `app/services/importer.py` | 系列容器导入时写入 `mid`；老容器若这次拿到 mid 就补上 |
| 前端 | `app/web/static/share.js` | `__share` 降级链 + `__copyText` + `__receiveShare`（反向入库，未登录先说清并弹登录） |
| 前端 | `v3.js` / `export.js` | 单曲菜单、歌单/专辑详情、UP 主页、导出复制 4 处入口全部改走 `__share`/`__copyText` |
| Android | `MainActivity.java` / `AndroidManifest.xml` | 桥方法 `shareText(title,text,url)`（ACTION_SEND + chooser）；`SEND text/plain` intent-filter + `launchMode=singleTop`；`onCreate`/`onNewIntent` 取 `EXTRA_TEXT` → 页面就绪后 `window.__receiveShare()` |

### 4.6 验收标准（操作 → 期望）

| # | 操作 | 期望 |
|---|---|---|
| 1 | Android 曲库单曲菜单点「分享」 | 系统分享面板出现；选微信后对方收到可点开的 B 站链接 |
| 2 | 在 B 站 App 分享一个视频并选择 BiliMusic | BiliMusic 打开并提示已入库（收藏夹/系列链接同样可识别） |
| 3 | 浏览器 HTTPS / localhost 点分享 | 走 `navigator.share` |
| 4 | 局域网 http 访问点分享 | 降级为复制或显示链接，**不报错、不静默失败** |
| 5 | 分享系列合集 | 产出可用的 B 站链接（依赖缺口 1 修复） |
| 6 | 微信里点 B 站链接 | 进浏览器/B 站 App，**不会**进 BiliMusic（预期行为） |

### 4.7 风险

| 风险 | 说明 |
|---|---|
| `b23.tv` 跳转依赖 B 站服务可用 | 后端已有跟随跳转能力；失败时按解析失败提示 |
| 分享目标不出现 | 需 App 已安装且被系统索引；部分 ROM 要求 App 曾被启动过 |
| 微信对第三方 App 唤起的拦截策略 | 正向分享走系统面板不受影响；反向仅在面板内选择，不涉及唤起 |
| 品牌风险 | 不做视觉仿冒，避免商标/平台条款问题 |

### 4.8 里程碑

| 阶段 | 内容 | 预估 | 状态 |
|---|---|---|---|
| Phase 1 | 正向：Android 桥 `shareText` + 前端降级链 | ~0.5 天 | ✅ 代码完成；Web/桌面实测通过（见 4.6 验证记录） |
| Phase 2 | 反向：intent-filter + 读 `EXTRA_TEXT` + 入库 | ~0.5 天 | ✅ 代码完成；需重新打包 APK 后真机验收 |
| Phase 3 | 可选：分享卡片图（FileProvider + `image/*`） | ~1 天 | 未做 |

### 4.8.1 验证记录（2026-09-10）

| 项 | 证据 |
|---|---|
| 链接拼装 | `tests/test_share.py` 7 例：单曲/歌单/系列链接、`sid:` 解析、系列缺 mid **不产生** `video/sid:...` 废链、老库 `album.mid` 迁移幂等、mid 懒回填与跳过 |
| 降级链 | `tests/test_share.js` 13 例：原生桥优先、`navigator.share`、用户取消（静默）、share 失败→剪贴板→execCommand→弹窗兜底、无链接不空发、反向入库/未登录/无链接预检 |
| 接口实测（真实库 398522315） | `GET /api/albums/1/share-link` → `https://www.bilibili.com/video/BV1yN4y1H7XX`；`/api/albums` 列表带 `mid`+`shareUrl`；临时库：系列带 mid → `collectiondetail?sid=777` 200、缺 mid 且反查失败 → **409 可读文案**、不存在 → 404 |
| 页面实测（无头 Chrome 驱动真实页面） | `__share`/`__copyText`/`__receiveShare` 均就位；单曲菜单 → 真链接 + 歌名/UP 名；专辑详情 → `shareUrl`；歌单详情 → `space.bilibili.com/{mid}/favlist?fid=...`；垃圾文本 → 「没识别到 B 站链接」；未登录 → 「请先登录…」+ 弹登录；headless 下 share/clipboard 全失败时最终**弹窗展示链接**（不静默） |
| 回归 | `pytest` **163 passed, 2 skipped**；`node --test tests/*.js` **35 passed** |

---

## 5. 维护约定

1. 新增条目从 **#26** 继续编号，类型标注 `功能` / `缺陷` / `架构`。
2. 条目状态取值：`提案` → `待排期` → `进行中` → `已完成` / `已否决`。
3. 条目落地后，同步在 `docs/acceptance-manual.md` 补对应的「操作 → 期望」验收步骤。
4. 缺陷类条目：线上故障、真机实测确认的问题优先记入 `docs/bugs.md`；命名/展示/架构级且不涉及线上故障的，直接记入本文件（如 #24），本文件同时承担索引职责。
