# BiliMusic 真实 Bug 记录（生产实测）

> 只记录**用户真机实测确认**的问题：现象 → 根因（代码定位）→ 修复 → 验证。
> 每条都对应一次可复现的线上行为，不是推测。

---

## BUG-001 收藏夹同步只拿到子集（多设备数量各不相同）｜ P0 ｜ v1.0.1 已修

**现象**：同一 B 站账号在多台设备登录，App 曲库数量各不相同（用户实测 11 / 18），而 B 站 `bilimusic` 收藏夹实际有 **30** 个视频。

**根因**：`app/bili/client.py` 的 `get_fav_videos()` 用响应里的 `media_count` 当翻页终止条件：

```python
total = int(data.get("media_count") or 0)      # 该接口顶层没有 media_count → 恒为 0
...
if not medias or (total is not None and len(out) >= total): break   # 20 >= 0 → 第一页就 break
```

`/x/v3/fav/resource/list` 把 `media_count` 放在 `data.info` 里，**顶层为 None**，于是 `total=0`，循环永远只翻第一页（ps=20）。收藏夹按收藏时间排序，新收藏会把旧视频挤出前 20 —— 所以每台设备各自停在「当时的前 20 条」，表现为不同子集。

**修复**：终止条件改用响应里的 **`has_more`**；页数上限由 `cap` 计算（不再硬编码 50 页）。`submit_fav`（收藏夹链接批量导入）走同一函数，一并修复。

**验证**（用用户账号真实 cookie 实测）：

| 收藏夹 | 修复前 | 修复后 |
|---|---|---|
| `bilimusic`（30 个） | 20 ❌ | **30** ✅ |
| `默认收藏夹`（28 个） | 20 ❌ | **28** ✅ |

用户真机确认：多设备曲库数量与 B 站收藏夹一致。

---

## BUG-002 移动端短信登录：极验滑块不渲染 ｜ P1 ｜ v1.0.0 修，v1.0.1 改为下线

**现象**：Android 上填手机号点「获取验证码」，极验验证窗口不出现（或出现但不可见），无法完成短信登录。

**根因**：`MainActivity` 的 WebView 只开了 `setJavaScriptEnabled` + `setDomStorageEnabled`，缺两样极验必需项：
1. 默认 UA 含 `; wv` → 被风控识别为 WebView，不下发滑块；
2. 跨站脚本（`static.geetest.com`）的第三方 Cookie 被拦 → 极验会话拿不到。

**修复**：伪装成手机 Chrome UA（`Mobile Safari/537.36`）、`setAcceptThirdPartyCookies(true)`、`setDatabaseEnabled(true)`、`setMixedContentMode(ALWAYS_ALLOW)`。页面布局走 CSS 视口断点，不受 UA 影响。

**后续**：短信登录体验仍不理想（依赖极验 CDN，跨境线路慢），v1.0.1 整体下线，改为二维码方案（见 FEAT-001）。

---

## BUG-003 验证参数接口偶发超时，前端只显示笼统失败 ｜ P1 ｜ v1.0.1 已修

**现象**：手机端点「获取验证码」直接提示「验证参数获取失败」，无法排查。

**根因**：`passport.bilibili.com/x/passport-login/captcha` 实测 **3 次里 1 次 ConnectTimeout**（经代理/VPN 更明显）；后端异常未转成可读响应，前端 `r.ok ? r.json() : null` 拿到 null，统一显示笼统文案。

**修复**：`captcha_get()` 网络类错误重试 3 次 + 单次超时 20s→5s（失败也快）；`/api/auth/captcha` 把 `BiliApiError`/`httpx` 错误转成 `502 + detail`；前端直接展示 detail。实测 5/5 成功、耗时 0.8~1.6s。

---

## BUG-004 曲库计数与 B 站收藏夹口径不一致 ｜ P1 ｜ v1.0.0 已修

**现象**：本地「我的曲库」显示 12，但 B 站收藏夹有 20+，歌单详情页又显示 13，三处对不上。

**根因**：本地计数是「已收藏的**歌曲**数」（`collected=1`），B 站是「收藏的**视频**数」；一个多 P 合集在 B 站算 1 条、在本地算 0~N 首（取决于是否逐曲收藏）。收藏后侧边栏还没刷新，进一步放大了偏差。

**修复**：计数改为**视频级**——收藏单曲 1 条 + 合集容器 1 条；曲库详情页新增「合集」货架，让计数与内容一致；收藏/移出时触发 `playlistsChanged` 刷新侧栏。

---

## BUG-005 推荐歌单卡片右下角多余播放按钮 ｜ P2 ｜ v1.0.1 已修

**现象**：推荐歌单卡片右下角悬浮一个白色圆形播放钮，视觉突兀。

**根因**：`partials/rec_playlists.html` 的 `<span class="fab">`。

**修复**：删除该元素（`partials/playlist_rack.html` 的「我的歌单」卡片上同款按钮保留，按需再定）。

---

## BUG-006 音频流按 id 取最大选档，放开高音质后会选错 ｜ P1 ｜ `[待修]`（用户要求先记不修）

**现象**：目前无感。一旦支持杜比/Hi-Res，会**挑到 192K 而不是 Hi-Res**。

**根因**：`app/bili/quality.py` 的 `pick_best_audio()` 用 `max(streams, key=lambda s: s.quality_id)`，
但 B 站音质 id 的**数字大小 ≠ 音质高低**：

| id | 档位 |
|---|---|
| 30216 | 64K |
| 30232 | 132K |
| 30280 | **192K** |
| 30250 | 杜比全景声 |
| 30251 | **Hi-Res 无损** |

`max(id)` 在所有档位里会选到 **30280（192K）**，把 30251（Hi-Res）/ 30250（杜比）排在后面。

**当前为何不炸**：`client.py` 请求 playurl 用的是 `fnval=16`（仅基础 DASH），B 站只返回
30216/30232/30280 三条 AAC 流，`max(id)` 恰好等于 192K —— 属于「巧合正确」。

**修复方向**（用户要求暂缓）：
1. 改为按 `bandwidth` 降序（同码率再用质量优先级 tie-break）——`AudioStream` 已经存了 `bandwidth`；
2. 若后续放开 `fnval=4048`，另需处理 `dash.flac.audio`（无损）与 `dash.dolby.audio[]`，
   优先 flac → dolby → dash.audio 按带宽取最高；
3. 注意 FLAC/Hi-Res 码率约 1000+ kbps，本服务是**实时代理不落地**，建议 Wi-Fi 优先无损、蜂窝自动降档。

**参考**：`wood3n/biu` 的 `src/common/utils/audio.ts`（`sortAudio` 主键 bandwidth 降序 +
`audioQualitySort` 优先级）与 `electron/ipc/api/audio-stream-url.ts`（带 Cookie/Referer/UA +
按会员状态选 quality）。

---

## FEAT-001 登录方式改为「点二维码 → 存相册 + 拉起 B 站 App」｜ v1.0.1

**背景**：短信登录依赖极验（见 BUG-002/003），体验差；扫码在单手机上又不方便（没法用同一台机器扫自己的屏幕）。

**方案**：登录弹窗改为**单列扫码**，点二维码后：
1. Android 经原生桥 `saveQrToGallery` 写入系统相册（API 29+ 走 scoped storage 免权限；≤28 申请 `WRITE_EXTERNAL_STORAGE`）；
2. `openBilibiliApp` 拉起 B 站 App；
3. 用户在 B 站 App「扫一扫 → 相册」选中该二维码即可确认登录，后端轮询到确认自动进入；
4. 浏览器/桌面回退为直接下载 PNG。

**前提**：B 站 App 的「扫一扫」需有相册入口（用户侧确认）。
