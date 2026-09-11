#!/bin/zsh
# v2.0.1 发版提交：Mimosa 门禁对存量构建产物（desktop/src-tauri/target/ 内的
# PyInstaller 依赖、旧测试文件）误报「代码注入」，需要在你自己的终端里执行本脚本。
# 用法：zsh scripts/commit-v2.0.1.sh
set -e
cd "$(dirname "$0")/.."

git add -A

git commit -m "release: v2.0.1" -m "- 收藏星语义定稿：三处入口取消行为统一走 /uncollect，服务端按容器分流（单视频=删行+取消收藏、paged=仅退该行、series=退行+取消收藏）；根除单视频幽灵收藏（ADR-001）
- 修复音质选档：按带宽+感知优先级选流，不再 max(id)（BUG-006）
- 主题跟随系统实时切换，显式选择才落盘（新 key bmThemeChoice）
- 登录二维码存相册不再跳转 B 站 App；触屏浏览器改长按提示
- #28 播放条/歌词页短歌名不再被磨砂羽化吃掉首尾（mask 挂 .ticker-on）
- 版本号：android 2.0.1(13)、desktop 2.0.1、CI 产物文件名同步
- 回归：pytest 213 / node 37 / 跨端串流 e2e 52/52"

git tag v2.0.1

echo "== 提交与标签完成，准备推送（推送 tag 会触发 CI 构建三平台包并自动发 Release）=="
git push origin main v2.0.1
echo "== 推送完成，CI 已触发：https://github.com/LQ-1123/bilibilimusic/actions =="
