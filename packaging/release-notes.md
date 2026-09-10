## BiliMusic v2.0.0: 跨端串流重做——手机一点就走 / streaming, reimagined

Desktop v2.0.0 and Android v2.0.0 are a major feature release on top of v1.3.0.

v2.0.0 把 v1.3.0 的「跨端接力」做成了一套**不用学的手势**：手机打开就自动连上同一账号的电脑，
播放条本身就是状态显示和遥控器，往上一拖就能把声音丢给另一台设备。

### 串流 / Streaming

- **零点击自动连接**：手机冷启动 1.5s 后自动扫局域网，按账号指纹（`sha256("bilimusic-lan:" + mid)`，不传明文 mid）命中同一账号的电脑就自动切过去；正在放歌的那台会被优先选中。找不到就安静地用本机，不弹错、不卡。 / Zero-tap auto-connect: the phone finds the machine on the same account, preferring the one currently playing.
- **播放条即遥控器**：打开任意设备，播放条直接显示另一台正在放的那首（封面/歌名/歌手 + 进度实时追随）。中键**短按＝遥控对面**播放/暂停，上一首/下一首、拖进度、拖音量全部作用在**在放的那台**上。 / The player bar mirrors the other device and becomes its remote.
- **手势串流（手机）**：把播放条**往上拖**——条子缩成一颗小团跟手、整屏背景糊掉、设备变成页面中央的**球阵**（在放的那台是粉圈球 + 远端音量条）；手指丢到哪颗球就串到哪台。**往下拉**＝回到本机播放。设备不在列表里就取消，条子归位。 / Drag the bar up to grab a device out of the orb field; drag down to bring playback home.
- **桌面端**：播放条上的**设备图标**打开设备列表（点一行即切换）；长按在桌面不绑。 / Desktop keeps an explicit device list.
- **串流态点歌＝对面换歌**：手机当遥控时点歌（含**未收藏的试听**、主页推荐、最近播放），声音在电脑那边响，手机自己不出声——不会两头一起放。 / Tapping a song while mirroring hands the queue to the active device.
- **详情页/歌词页跟着远端走**：镜像态进歌曲详情页看到的是**远端正在放的那首**（歌词、进度、播放键、上下曲全部遥控对面），不再是空白或上一首。 / Song detail follows the remote track.
- **粉色光晕 = 串流标识**：镜像态播放条走一圈沿边游走的粉色光点；歌手位回归**歌手名**（设备名只放在 hover 里），点歌手＝跳远端那首的 UP 主页。 / A pink rim-light marks mirror mode; the artist slot shows the artist again.
- **串流零提示**：切换设备的成功与进度**全部不弹胶囊**——结果只由播放条（镜像 + 粉光）体现；只有失败才出声（设备未响应 / 拿不到队列 / 接管失败 / 浏览器拦了自动播放）。 / No toasts for successful streaming actions.

### 其它 / Other

- 手机底部导航的「设备」整页已删除（Tab＝3 + 搜索圆钮），跨端入口全部收进播放条手势/图标；播放条与底栏严格等长。
- 手机端歌曲详情页的歌手点击判定范围收回到**文字本身**（390px 下约 97px），不再整行可点。
- 修掉「在途旧快照把刚接管的设备打回暂停」（点了串流却不出声）与「串流回来后再点另一首＝两首一起放」。
- Android 侧内嵌后端修掉 pydantic v1 不兼容（v1.3.0 的 CI 里 android job 挂在这里）。

> 已知问题（已记录、本期不修）：PC 播放条歌名 ≤15 字符时两侧磨砂遮罩仍会吃掉首尾（台账 #28）。

### 安装 / Installers

- macOS: `BiliMusic-2.0.0-mac-arm64.dmg` / `BiliMusic-2.0.0-mac-x64.dmg`
- Windows: `BiliMusic-2.0.0-win-x64.exe`
- Android: `BiliMusic-2.0.0-android.apk` (arm64-v8a / x86_64)
- `SHA256SUMS.txt` for verification

> 数据目录沿用旧版本；跨端会话为进程内状态，后端重启即重建（客户端会自动重新注册设备）。自动连接要求两端在**同一局域网**且登录**同一个 B 站账号**。 / Data directories are reused. Sessions live in memory and rebuild themselves after a restart.
