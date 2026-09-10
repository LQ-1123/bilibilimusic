## BiliMusic v1.3.0: 跨端接力播放 + 弱网与后台卡顿修复 / cross-device handoff and playback reliability

Desktop v1.3.0 and Android v1.3.0 are a feature release on top of v1.2.0.

v1.3.0 带来对标 Spotify Connect 的**跨端接力**（同账号多设备共享一份播放会话），并集中修掉真机播放卡顿。

### 跨端接力 / Cross-device handoff

- **设备列表**：同一个 B 站账号的多台设备（电脑 / 手机 / 桌面壳）互相可见，能直接看到对方在放什么、放到哪（进度实时外推，误差 ±1s）。入口在播放队列面板底部的「设备 · 同账号跨端」。 / Devices on the same account see each other's playback with a live position.
- **打开即续播**：新设备打开页面就能看到「另一台设备正在播放 X · 3:42」，点一下「继续」即从同一进度接着放。 / Resume from another device's position with one tap.
- **远端遥控**：手机可以当遥控器——暂停/播放、上一首、下一首，点进度条任意位置让对端跳过去。 / Remote control: play/pause, prev/next, and tap-to-seek on the other device.
- **移交播放**：点「转到此设备播放」，播放会**无缝接过来**——接收端先预加载（点击后立刻开始缓冲）、到达 `canplay` 后从发送端**现场读取**的精确进度继续，两端音量在同一个 350ms 窗口里一个淡入一个淡出，中间不留静音缝；移交失败或自动播放被拦时发送端继续播，接收端给一个「点一下继续播放」，不会两头都没声音。 / Handoff is seamless: the receiver preloads immediately, seeks to the sender's live position, and the two ends cross-fade in the same 350 ms window; on failure the sender simply keeps playing.

> 边界（与设计一致）：同账号之间的会话互相可见，不同账号严格隔离；跨网络（手机 4G + 电脑在家）需要自行做 HTTPS/内网穿透，本期只覆盖同一局域网；浏览器关掉标签页就无法继续出声（Android 前台服务是唯一能后台播放的端）。

### 播放稳定性 / Playback reliability

- **锁屏 / 后台不再断流**：Android 播放期间持有 CPU 与 Wi-Fi 锁（`PARTIAL_WAKE_LOCK` + `WIFI_MODE_FULL_HIGH_PERF`），息屏后系统降频不再掐断音频流；暂停/停止立即释放。 / Android now holds CPU and Wi-Fi locks while playing, so screen-off no longer starves the stream.
- **CDN 自动换源**：取流失败（连接失败或 4xx/5xx）会按 B 站给的备用镜像依次重试，只在首字节之前换源，全挂才报错。 / Automatic CDN mirror failover while streaming.
- **卡顿自愈**：前端检测到缓冲停住（3 秒仍未恢复）会在当前进度重开一次，带冷却与次数上限；`<audio>` 改为提前预缓冲。 / Stalls now self-heal by reloading at the current position.
- **启动更稳**：后端启动时到 B 站的网络抖动会自动重试（1.5s / 3s 退避），不再出现「打开后所有接口 401、必须重启一次」的情况。 / Startup login restore retries transient network errors.

### 其它 / Other

- PC「UP 主视图」右侧列表改为一行只留歌名 + 收藏星；移动端播放队列面板新增设备区。
- 上一版（v1.2.0）的 11 项手机端体验修复与桌面排版统一一并包含在本版内。

### 安装 / Installers

- macOS: `BiliMusic-1.3.0-mac-arm64.dmg` / `BiliMusic-1.3.0-mac-x64.dmg`
- Windows: `BiliMusic-1.3.0-win-x64.exe`
- Android: `BiliMusic-1.3.0-android.apk` (arm64-v8a / x86_64)
- `SHA256SUMS.txt` for verification

> 数据目录沿用旧版本；老库启动时自动补 `album.mid` 列。跨端接力为进程内会话，后端重启即重建（客户端会自动重新注册设备）。 / Data directories are reused. Cross-device sessions live in memory and are rebuilt automatically after a backend restart.
