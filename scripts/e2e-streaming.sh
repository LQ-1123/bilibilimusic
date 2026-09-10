#!/bin/zsh
# #27 跨端串流端到端：起测试后端(8123，用 data/ 的副本) + 无头 Chrome(9333) → 跑 e2e-streaming.mjs
# 用法：scripts/e2e-streaming.sh   （需要本机装了 Google Chrome；不必停掉正在跑的 8000 实例）
set -u
SCRIPT_DIR="${0:A:h}"
cd /Users/sunyulin/Documents/vscode/bilibilimusic
echo "== cleanup stale =="
pkill -f 'remote-debugging-port=9333' 2>/dev/null
pkill -f 'uvicorn app.main:app --host 127.0.0.1 --port 8123' 2>/dev/null
rm -rf /tmp/bm-e2e-chrome
sleep 1

echo "== start backend :8123 =="
rm -rf /tmp/bm-e2e
cp -R data /tmp/bm-e2e
BM_DATA_DIR=/tmp/bm-e2e nohup .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8123 > /tmp/bm-e2e-backend.log 2>&1 &
BPID=$!
for i in {1..40}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/ || true)
  [[ "$code" == "200" ]] && break
  sleep 0.5
done
echo "backend pid=$BPID http=$code"

echo "== start headless chrome :9333 =="
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/bm-e2e-chrome \
  --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required \
  --mute-audio --disable-gpu --window-size=1280,900 about:blank > /tmp/bm-e2e-chrome.log 2>&1 &
CPID=$!
for i in {1..40}; do
  v=$(curl -s http://127.0.0.1:9333/json/version || true)
  [[ -n "$v" ]] && break
  sleep 0.5
done
echo "chrome pid=$CPID version=${v:0:60}"

echo "== run e2e =="
node "$SCRIPT_DIR/e2e-streaming.mjs"
RC=$?
echo "== e2e exit=$RC =="
echo "---- backend log tail ----"
tail -20 /tmp/bm-e2e-backend.log
exit $RC
