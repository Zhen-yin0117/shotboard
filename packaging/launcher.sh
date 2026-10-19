#!/bin/bash
# Shotboard.app 的启动程序：确认后台服务在运行，然后打开一个独立窗口。
# （由「安装到应用程序.command」复制进 Shotboard.app/Contents/MacOS/Shotboard）

PORT=8765
URL="http://127.0.0.1:$PORT"
HOME_DIR="$HOME/Library/Application Support/Shotboard"
AGENT="com.shotboard.server"
PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
LOG_DIR="$HOME/Library/Logs/Shotboard"
DOMAIN="gui/$(id -u)"

is_up() { curl -s -m 1 -o /dev/null "$URL/api/settings"; }

wait_up() {
  i=0
  while [ $i -lt 60 ]; do
    is_up && return 0
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

if ! is_up; then
  # 1) 让系统重新拉起后台服务
  launchctl kickstart -k "$DOMAIN/$AGENT" >/dev/null 2>&1 \
    || launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1
  # 2) 后台服务被关掉了（比如在「登录项」里关了）：直接启动一次
  if ! wait_up; then
    mkdir -p "$LOG_DIR"
    cd "$HOME_DIR" 2>/dev/null && \
      nohup "$HOME_DIR/.venv/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port $PORT --log-level warning \
        >>"$LOG_DIR/server.log" 2>&1 &
    wait_up
  fi
fi

if ! is_up; then
  osascript -e "display alert \"Shotboard 没能启动\" message \"后台服务启动失败。可以把下面这个日志文件发给开发者：\n~/Library/Logs/Shotboard/server.log\n\n或者重新运行一次「安装到应用程序.command」。\" as critical" >/dev/null 2>&1
  exit 1
fi

# 用独立窗口打开（没有地址栏和标签页，像一个单独的 App）
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  for dir in "/Applications" "$HOME/Applications"; do
    if [ -d "$dir/$app.app" ]; then
      open -na "$dir/$app.app" --args --app="$URL" --new-window
      exit 0
    fi
  done
done
open "$URL"   # 没有 Chrome 类浏览器：用默认浏览器打开
