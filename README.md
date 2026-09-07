<p align="center"><img src="app/web/static/logo.png" width="100" alt="BiliMusic 标志"></p>
<h1 align="center">BiliMusic</h1>
<p align="center">把 B 站里的音乐，放进自己的播放器。</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

BiliMusic 是基于 Bilibili 的个人音乐 Web 播放器。搜索歌曲、发现推荐、整理收藏夹，在电脑和手机浏览器里在线收听。后端使用 FastAPI，界面采用服务端渲染，无需前端构建。

![桌面界面](docs/images/desktop.png)

## 功能

| 功能 | 说明 |
| --- | --- |
| 在线播放 | 后端代理 B 站音频流，支持进度拖动，正常播放不保存整首音频 |
| 搜索与发现 | 搜索视频和 UP 主，浏览每日精选、风格推荐及 UP 主作品 |
| 连续收听 | 推荐和搜索列表建立在线队列，支持上一首、下一首及自动续播 |
| 收藏与歌单 | 粘贴视频或收藏夹链接导入，与 B 站 `bilimusic` 系列收藏夹同步 |
| 歌词 | 支持带时间轴的滚动歌词，可用性取决于字幕或歌词源 |
| 多端界面 | 桌面侧栏、手机底部导航、亮暗主题、粉色玻璃选中动效 |
| 账号隔离 | 扫码登录，按账号保存曲库，登录凭据保存在本机 |

## 手机体验

<p align="center"><img src="docs/images/mobile.png" width="320" alt="手机曲库与粉色玻璃导航"></p>

手机浏览器直接访问同一服务。底部玻璃高亮随选中栏目滑动，支持系统“减少动态效果”设置。歌曲列表点击 X 即时移除，删除请求失败时恢复并提示。

## 快速开始

### 安装独立客户端

前往 [GitHub Releases](https://github.com/LQ-1123/bilibilimusic/releases) 下载 DMG、EXE 或 APK。安装包内置 Python 后端，不需要另行启动服务器。

| 系统 | 安装包 |
| --- | --- |
| macOS Apple Silicon | `*-mac-arm64.dmg` |
| macOS Intel | `*-mac-x64.dmg` |
| Windows 64 位 | `*-win-x64.exe` |
| Android 8 及以上，ARM64 / x86_64 | `*-android.apk` |

桌面版暂未使用开发者证书签名或公证，系统可能显示安全提示。APK 使用项目固定签名；首版不保证后台播放和锁屏控制。所有平台仍需联网访问 B 站。详细构建步骤见 [打包说明](docs/packaging.md)。

### 从源码启动

推荐 Python 3.13。服务器需要能访问 Bilibili API 和音频 CDN。

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

打开 **http://127.0.0.1:8000**。Windows 使用 `.venv\Scripts\activate` 激活环境。

1. 在账号入口扫码登录 B 站。
2. 搜索歌曲，或粘贴 B 站视频、收藏夹分享链接。
3. 点击歌曲在线播放，在推荐和搜索列表内可直接切换下一首。
4. 将歌曲加入歌单，或导出 B 站收藏夹链接分享。

**删除歌曲也会尝试取消对应的 B 站收藏。**

### 手机访问

让电脑和手机连接同一局域网，使用以下命令启动：

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

手机打开 `http://电脑局域网IP:8000`。默认配置面向个人本机或可信局域网；远程部署需自行配置 HTTPS 和访问控制。

## 配置与数据

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BM_DATA_DIR` | 项目下的 `data/` | 数据库、账号凭据及缓存目录 |
| `BM_API_TOKEN` | 空 | `/api/*` 的可选 Bearer Token 鉴权，媒体也支持 `?token=` |
| `BM_ALLOW_ORIGINS` | `*` | CORS 来源，多个来源用逗号分隔 |
| `BM_HOST` / `BM_PORT` | `0.0.0.0` / `8000` | 使用 `python -m app.main` 启动时的监听配置 |

显式使用 Uvicorn 时以 `--host`、`--port` 为准。API Token 不等于整个网页的访问控制。

备份时保留 `data/`；不要提交其中的数据库或 Cookie。当前版本以在线播放为主，不提供离线音乐库。旧版本本地音频会在启动迁移时尝试转为在线记录，迁移成功后移除旧文件。

## 开发

技术栈：Python · FastAPI · SQLite / SQLModel · httpx · Jinja2 · htmx · 原生 JavaScript。

```text
app/
  api/          API、音频流代理
  bili/         B 站客户端、签名与链接解析
  db/           SQLite 数据模型
  services/     账号、导入、同步、推荐与歌词
  web/          页面路由、模板、CSS 与 JavaScript
tests/          Python 与 JavaScript 回归测试
docs/images/    README 界面截图
```

运行测试（JavaScript 测试需要 Node.js）：

```bash
python -m pytest -q
node --test tests/test_*.js
```

启动后访问 **http://127.0.0.1:8000/docs** 查看交互式 API 文档。

## 常见问题

**视频在 B 站能播放，为什么这里提示失效？**

“视频可能已失效”是通用媒体错误提示，不一定代表视频下架。先检查后端是否运行，再检查终端日志、B 站登录状态及网络连接。API 或 CDN 连接失败也会导致播放失败。

**为什么部分歌曲没有歌词或无法播放？**

歌词来源、视频权限、地区限制、内容下架及 B 站接口变化都会影响可用性。在线播放需要持续联网。

## 使用说明

本项目与 Bilibili 无官方关联，仅供个人学习与使用。音视频及封面权利归各自权利人所有，请遵守平台规则和内容授权。截图内容仅用于展示界面。
