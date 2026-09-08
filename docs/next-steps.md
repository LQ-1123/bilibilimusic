# BiliMusic 下一步计划（Next Steps）

> 维护日期：2026-09-08 晚 ｜ 配套：`docs/issue-ledger.md`（问题台账）、`docs/acceptance-manual.md`（验收手册）
> 当前基线：**台账 25 组验收，代码侧全部完成**（模拟器 + 桌面 + 浏览器实测）；本地 3 笔提交待推送（GitHub 网络恢复后 `git push`）。

---

## 0. 今日全景（2026-09-08）

| 类别 | 完成项 |
|---|---|
| 快赢批 | F0 cid 流路由、#8 空格、#15 三键顺序、#19 滑条填充、#12 收尾、#13 走马灯、#16 蓝框、#7 建歌单 |
| 壳与导航 | #1 返回语义（含 WebView pushState 桥）、#2 系统栏沉浸（方案 A+B + insets 单位修复）、#5 后台零轮询、#17 移动路由、#9 双端品牌启动 |
| 原生播放 | #3 第一段+升级（前台服务 + MediaSession 系统媒体卡片：封面/进度/三键/线控）、#4 音频焦点 + 耳机拔出 |
| 内容 | #10 网易云源 + 重试换源 + 来源角标、#14 专辑一期全量（迁移/导入/播放/歌词/删除语义/懒物化/标题清洗）、#18 浏览器登录兜底、#21 对比度、#22 hover 关闭钮、#11 下拉刷新 |
| 桌面 | #20 Overlay 原生窗框（三版迭代定稿：自绘→透明否决→Overlay） |

## 1. 立即可做：真机抽查（唯一挡在"全部验收"前的环节）

按 `acceptance-manual.md` §9 清单，用实体手机装 debug APK 过一遍：

1. **拔耳机自动暂停**（#4 终验）——播放中拔有线/蓝牙耳机
2. **来电暂停**（#4）——播放中来电话，挂断后按规范停暂停态
3. **手势导航返回手感**（#1）——全面屏手势逐层返回，与三键行为一致
4. **锁屏 30 分钟不断播**（#3）——锁屏挂后台半小时
5. **蓝牙耳机按键**（#3）——播放/暂停/上下曲（MediaSession 回调）
6. **逐 P 听音对照**（F0/#14）——播放多分 P 专辑第 3 首，与 B 站 App 第 3 分 P 对照
7. **专辑收藏粒度核对**（#14）——删专辑后 B 站收藏夹该视频应消失（网页端核对）
8. **横向刘海**（#2）——横屏内容不被挖孔遮挡
9. **性能手感**（#6 预筛）——曲库长列表滚动；如卡顿用 chrome://inspect Performance 录制回填台账

## 2. 下一大项（推荐）：#14 series 二期（跨视频合集）

**目标**：B 站"合集/系列"（多个视频组成的歌单型合集）导入为一张专辑，语义按台账 #14 语义矩阵 series 列。

**拆解（按依赖顺序）**：
1. **链接解析**：`link_parser` 识别 `space.bilibili.com/{mid}/channel/collectiondetail?sid=` 与分享文本；产出 `SeriesRef(sid)`。
2. **数据**：复用 Album 表（`kind="series"`，`source_bvid` 存 `sid:<id>` 或加列）；曲目行 = 各视频（每个视频可再是多分 P，递归 paged）。
3. **拉取**：合集视频列表接口（`/x/polymer/web-space/seasons_archives_list`，注意风控限速）；>100 视频分页。
4. **导入**：逐视频建 Song（复用现有多分 P 路径）；频控（合集可能几百个视频，串行 + 间隔）。
5. **语义**（与 paged 不同点）：收藏=逐视频各收藏一次；删专辑=批量取消收藏（失败后台自愈）；换设备恢复=sid 重建 + 与收藏夹合并，sid 失效退化为散曲不丢歌。
6. **UI**：专辑卡复用；详情页标注「合集」；导入进度按视频数展示。
7. **验收**：手册 §6 #14 二期清单。

**预估**：1~2 周（频控和 sid 失效恢复是主要工作量）。

## 3. 可选跟进（按需）

| 项 | 说明 | 触发条件 |
|---|---|---|
| #3 Media3 迁移 | androidx.media → Media3（现方案已满足锁屏/通知/线控） | 需要 seekbar 联动/后台播放平滑迁移时 |
| #10 QQ 音乐源 | 网易云覆盖不足时的第二外部源 | 真机用一段时间看命中率 |
| #6 性能定点 | 封面缩略、backdrop-filter 审计 | 真机 profile 出热点后 |
| 通知点击深链 | contentIntent 目前只回 Activity，可带"展开歌词页" | 产品需要 |

## 4. 发版建议（功能已齐，值得切版本）

真机抽查完成后建议发 **v0.3.0**（变更量大，值得 minor 版）：
1. `android/app/build.gradle`：versionCode 3→4、versionName 0.1.2→0.3.0
2. `desktop/src-tauri/tauri.conf.json` 与 `desktop/package.json`：0.2.1→0.3.0
3. 跑 `packaging/` 打包脚本出双端产物（smoke 脚本已具备）
4. release notes 汇总台账 ✅ 项（用户可见口径）

## 5. 工程事项

- [ ] **push 3 笔待推提交**（GitHub 网络恢复后）
- [ ] 真机抽查结果回填 acceptance-manual §9
- [ ] 台账 §H 与本文档同步收尾
- [ ] 会话结束前按需关闭：模拟器 / 桌面 App / dev server

## 6. 环境速查（验收配方）

- 模拟器：AVD `BM35`（API 35 arm64，三键导航）；构建需 `python@3.11`（Chaquopy buildPython）+ 阿里云 pip 镜像 + JAVA_HOME=homebrew openjdk；`cd android && ./gradlew assembleDebug`
- WebView 调试：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`，websocket 需 `suppress_origin=True`；驱动脚本 `.dsh-paste/cdp_eval.py`
- 桌面端：改 Web 资源后必须 `python packaging/build-backend.py` 重打 bundle 再启动（PyInstaller 内嵌静态资源）
- 种子数据：`adb push` DB/cookies → `run-as io.github.lq1123.bilimusic` 拷入 `files/data/`
