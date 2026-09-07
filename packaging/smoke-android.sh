#!/usr/bin/env bash
set -euo pipefail
adb install -r android/app/build/outputs/apk/release/app-release.apk
adb logcat -c
adb shell am start -W -n io.github.lq1123.bilimusic/.MainActivity
for attempt in $(seq 1 120); do
  if adb logcat -d -s AndroidRuntime:E BiliMusic:E | grep -Eq 'FATAL EXCEPTION|Startup failed'; then
    adb logcat -d -s BiliMusic python.stderr AndroidRuntime
    exit 1
  fi
  if adb logcat -d -s BiliMusic:I | grep -q BILIMUSIC_WEB_READY; then
    echo 'Standalone Android backend and WebView are ready'
    exit 0
  fi
  sleep 2
done
adb logcat -d -s BiliMusic python.stderr AndroidRuntime
exit 1
