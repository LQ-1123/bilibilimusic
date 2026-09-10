## BiliMusic v1.2.0: 手机端 11 项体验修复 + PC 排版统一 / mobile fixes and desktop layout

Desktop v1.2.0 and Android v1.2.0 are a polish release on top of v1.1.0.

v1.2.0 在 v1.1.0 基础上修掉 11 项手机端/桌面端体验问题（每条都在台账 `docs/bugs.md` 的 BUG-010 ~ BUG-020 有实测记录）。

### 搜索 / Search

- **删到最后一个字不再关闭搜索框**：以前输入清空会把整个搜索胶囊收掉，得重新点底部圆钮；现在只清结果、保留面板与焦点。 / Clearing the query no longer dismisses the search bar.
- **UP 作品页也能搜出结果**：搜索胶囊原本待在 `.main` 里，压不过作品页那一层，表现为「有结果、没搜索框」；现在搜索态把胶囊提到最上层。 / Search now shows on the artist page (a stacking-context fix).
- **结果不被输入法盖住**：键盘高度写进 CSS 变量，结果面板与搜索框据此整体上移。 / Results stay above the on-screen keyboard.
- **播放条让位**：搜索时顺序固定为「播放条 → 结果面板 → 搜索框」，播放条被顶到面板上方。 / The player bar moves above the results panel while searching.
- **搜索框与播放条左右齐平**。 / Search bar aligns with the player bar.
- 顺手修掉一条重复的 `.search-drop` 规则（它盖掉了键盘避让的高度计算）。 / Removed a duplicated rule that broke the keyboard offset.

### 手机端 / Mobile

- **导航条选中块点击时缓慢变形**（0.15s 时间常数，约 0.3s 走完），不再是「一点就到位」。 / The liquid-glass nav pill now eases into its shape instead of snapping.
- **UP 作品页「全部音乐」恒定两列**，列宽封顶 220px，宽屏不会把封面撑成大图。 / Artist page music list is always two columns.
- **「加载更多」不再被播放条压住**（原来滚到底还差 12px）。 / Fixed the "load more" button being covered by the player bar.
- **账号页补上「退出登录」**（桌面侧栏与手机共用同一套逻辑，带二次确认），并去掉行尾那些解释性小字。 / Added a log-out row on the account page and dropped the trailing caption texts.

### 收藏 / Favourites

- **修掉「只听专辑却显示已收藏」**：收藏状态以前只按视频号记，同一个多分 P 视频里各分集互相串台；现在按「视频+分集」判定，点星只收藏当前这一集。 / Fixed a false "collected" state on multi-part videos: collection is now tracked per part.

### 桌面端 / Desktop

- **歌曲详情页左列与手机版统一**：封面、歌名行、进度条、控制行、底行共用同一条列宽；控制行只留上一首/暂停/下一首，底行两端是播放模式与播放列表（原来播放列表键没有样式、实际不可见）。 / Unified the song detail page's left column with the mobile layout.
- **UP 主视图右侧列表重排**：一行只留歌名与收藏星。 / The artist view's song list now shows only the title and a favourite star.

### 安装 / Installers

- macOS: `BiliMusic-1.2.0-mac-arm64.dmg` / `BiliMusic-1.2.0-mac-x64.dmg`
- Windows: `BiliMusic-1.2.0-win-x64.exe`
- Android: `BiliMusic-1.2.0-android.apk` (arm64-v8a / x86_64)
- `SHA256SUMS.txt` for verification

> 数据目录沿用旧版本；老库启动时自动补 `album.mid` 列。 / Data directories are reused; older databases get the new `album.mid` column on startup.
