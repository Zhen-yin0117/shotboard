#!/bin/bash
# Shotboard 片板 —— 安装成 Mac 应用（第一次右键 → 打开）
#
# 做的事情：
#   1. 把程序复制到 ~/Library/Application Support/Shotboard
#      （第一次安装时，把这个文件夹里的样片数据也复制过去；原文件夹不动，留作备份）
#   2. 注册成后台服务：开机自动运行，不需要终端窗口，浏览器插件随时能用
#   3. 在「应用程序」里生成 Shotboard.app
#
# 以后有新版本：解压新版本，再运行一次这个文件就行，样片数据不会被覆盖。

set -u
RUNNING_DIR=""
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Shotboard"
LOG_DIR="$HOME/Library/Logs/Shotboard"
AGENT="com.shotboard.server"
PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
DOMAIN="gui/$(id -u)"
PORT=8765

say()  { printf "  %s\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() {
  printf "\n  \033[31m✕ %s\033[0m\n\n" "$*"
  read -r -p "  按回车键关闭…" _
  exit 1
}

count_images() { find "$1/images" -type f 2>/dev/null | wc -l | tr -d ' '; }

# 找之前的样片库：① 解压的这个文件夹里 ② 正在运行的旧版本所在的文件夹 ③ 用 Spotlight 搜。有多个时选图最多的
find_old_data() {
  {
    printf '%s\n' "$SRC/data/library.db"
    [ -n "$RUNNING_DIR" ] && printf '%s\n' "$RUNNING_DIR/data/library.db"
    mdfind "kMDItemFSName == 'library.db'" 2>/dev/null
  } | while IFS= read -r db; do
    [ -f "$db" ] || continue
    dir=$(dirname "$db")
    case "$dir" in "$DEST"*|*/.Trash/*) continue ;; esac
    [ -f "$dir/config.json" ] || [ -d "$dir/images" ] || continue   # 确认是 Shotboard 的数据
    printf '%s\t%s\n' "$(count_images "$dir")" "$dir"
  done | sort -rn | head -1 | cut -f2-
}

echo ""
echo "  ● Shotboard 片板 · 安装到应用程序"
echo "  ─────────────────────────────────"

# ---------- 0. 检查 ----------
[ -f "$SRC/app/main.py" ] || fail "找不到程序文件。请在解压后的 shotboard 文件夹里运行这个文件。"
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import sys" >/dev/null 2>&1; then
  say "需要先安装 Python。macOS 会弹出安装「命令行开发者工具」的窗口，点「安装」，装好后再运行一次本文件。"
  xcode-select --install >/dev/null 2>&1
  fail "还没有 Python"
fi
PY_OK=$(python3 -c 'import sys; print(1 if sys.version_info >= (3, 9) else 0)')
[ "$PY_OK" = "1" ] || fail "Python 版本太旧（需要 3.9 或更新），请先更新「命令行开发者工具」。"
ok "检查环境"

# ---------- 1. 停掉正在运行的旧版本 ----------
launchctl bootout "$DOMAIN/$AGENT" >/dev/null 2>&1
if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/settings"; then
  # 用 start.command 打开的旧窗口还在运行
  PIDS=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)
  for pid in $PIDS; do   # 记下旧版本在哪个文件夹运行，用来找你的样片库
    RUNNING_DIR=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  done
  if [ -n "$PIDS" ]; then
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null
    sleep 1
  fi
fi
if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/settings"; then
  fail "端口 $PORT 被占用。请先关掉运行 start.command 的那个终端窗口，再运行一次本文件。"
fi
ok "已停止正在运行的旧版本"

# ---------- 2. 复制程序和数据 ----------
mkdir -p "$DEST" "$LOG_DIR" || fail "无法创建 $DEST"
if [ "$SRC" != "$DEST" ]; then
  # 先清掉旧版本的程序文件（保留 data 样片库和 .venv 运行环境），再复制新版本
  for f in "$DEST"/* "$DEST"/.[!.]*; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in data|.venv) continue ;; esac
    rm -rf "$f"
  done
  for f in "$SRC"/* "$SRC"/.[!.]*; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in data|.venv|.DS_Store) continue ;; esac
    cp -Rp "$f" "$DEST/" || fail "复制程序文件失败"
  done
  find "$DEST" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null
  ok "程序已复制到 ~/Library/Application Support/Shotboard"

  if [ -d "$DEST/data" ] && [ -f "$DEST/data/library.db" ]; then
    ok "保留已有的样片库（$(count_images "$DEST/data") 张）"
  else
    OLD_DATA=$(find_old_data)
    if [ -z "$OLD_DATA" ]; then
      echo ""
      say "没有自动找到之前的样片库。"
      say "如果你之前用过 Shotboard：把旧的 shotboard 文件夹拖进这个窗口，再按回车。"
      read -r -p "  全新使用的话直接按回车：" DROPPED
      DROPPED=$(printf '%s' "${DROPPED:-}" | sed -e "s/^[[:space:]]*['\"]//" -e "s/['\"][[:space:]]*$//" -e 's/[[:space:]]*$//' -e 's/\\ / /g')
      if [ -n "$DROPPED" ]; then
        if [ -f "$DROPPED/data/library.db" ]; then OLD_DATA="$DROPPED/data"
        elif [ -f "$DROPPED/library.db" ]; then OLD_DATA="$DROPPED"
        else fail "这个文件夹里没有样片库（找不到 data/library.db）：$DROPPED"; fi
      fi
    fi
    if [ -n "$OLD_DATA" ]; then
      say "找到样片库：${OLD_DATA/#$HOME/~}"
      say "正在复制（$(count_images "$OLD_DATA") 张），图多的话要等一会儿…"
      rm -rf "$DEST/data"
      cp -Rp "$OLD_DATA" "$DEST/data" || fail "复制样片库失败（原来的数据没有动过）"
      ok "样片库已复制（原来的文件夹没有动，留作备份，确认没问题后可以删掉）"
    else
      ok "这是全新安装，还没有样片"
    fi
  fi
fi

# ---------- 3. 运行环境 ----------
cd "$DEST" || fail "无法进入 $DEST"
if [ ! -x ".venv/bin/python" ]; then
  say "准备运行环境（第一次大约 1 分钟）…"
  python3 -m venv .venv || fail "创建运行环境失败"
fi
if [ ! -f ".venv/.installed" ] || [ requirements.txt -nt .venv/.installed ]; then
  say "安装依赖…"
  .venv/bin/python -m pip install -q --upgrade pip >/dev/null 2>&1
  .venv/bin/python -m pip install -q -r requirements.txt || fail "安装依赖失败，请检查网络后重试"
  touch .venv/.installed
fi
.venv/bin/python -c "import fastapi, uvicorn, PIL, httpx" 2>/dev/null || fail "运行环境不完整，删掉 $DEST/.venv 后重新运行本文件"
ok "运行环境就绪"

# ---------- 4. 后台服务 ----------
mkdir -p "$HOME/Library/LaunchAgents"
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
D_X=$(xml_escape "$DEST"); L_X=$(xml_escape "$LOG_DIR")
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$D_X/.venv/bin/python</string>
    <string>-m</string><string>uvicorn</string><string>app.main:app</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$PORT</string>
    <string>--log-level</string><string>warning</string>
  </array>
  <key>WorkingDirectory</key><string>$D_X</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONUNBUFFERED</key><string>1</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$L_X/server.log</string>
  <key>StandardErrorPath</key><string>$L_X/server.log</string>
</dict>
</plist>
PLISTEOF
plutil -lint "$PLIST" >/dev/null 2>&1 || fail "后台服务配置文件有误"
launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || launchctl load -w "$PLIST" >/dev/null 2>&1
i=0
until curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/settings"; do
  i=$((i + 1))
  [ $i -gt 60 ] && fail "后台服务没有启动成功。日志：~/Library/Logs/Shotboard/server.log"
  sleep 0.5
done
ok "后台服务已启动（开机自动运行，不需要终端）"

# ---------- 5. 生成 Shotboard.app ----------
if [ -w "/Applications" ]; then APPS="/Applications"; else APPS="$HOME/Applications"; mkdir -p "$APPS"; fi
APP="$APPS/Shotboard.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$DEST/packaging/launcher.sh" "$APP/Contents/MacOS/Shotboard"
chmod +x "$APP/Contents/MacOS/Shotboard"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DEST/extension/manifest.json" | head -1)
cat > "$APP/Contents/Info.plist" <<INFOEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Shotboard</string>
  <key>CFBundleDisplayName</key><string>Shotboard 片板</string>
  <key>CFBundleIdentifier</key><string>com.shotboard.app</string>
  <key>CFBundleExecutable</key><string>Shotboard</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION:-1.0}</string>
  <key>CFBundleVersion</key><string>${VERSION:-1.0}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
INFOEOF

# 图标：用 sips + iconutil 生成 .icns（失败也不影响使用）
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$DEST/packaging/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
  d=$((s * 2))
  sips -z $d $d "$DEST/packaging/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
done
if iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1; then
  ok "图标已生成"
fi
rm -rf "$(dirname "$ICONSET")"
touch "$APP"   # 让 Finder / 程序坞刷新图标
ok "已生成 $APP"

# ---------- 6. 插件位置 ----------
EXT="$DEST/extension"
printf '%s' "$EXT" | pbcopy 2>/dev/null

echo ""
echo "  ─────────────────────────────────"
echo "  安装完成！以后从「启动台」或「应用程序」打开 Shotboard 就行。"
echo ""
echo "  · 关掉 Shotboard 窗口后，后台还在运行：插件随时能存图，打标也会继续。"
echo "  · macOS 可能会提示「已添加后台项目」，这是正常的。"
echo ""
echo "  浏览器插件（只需要做一次）："
echo "    插件的新位置已经复制到剪贴板："
echo "    $EXT"
echo "    1. 打开 chrome://extensions，删掉旧的 Shotboard 插件"
echo "    2. 点「加载已解压的扩展程序」，在弹出的窗口里按 ⌘⇧G，⌘V 粘贴，回车，再点「选择」"
echo "    这样以后更新插件，只要在扩展页点一下刷新。"
echo ""
open "$APP"
read -r -p "  按回车键关闭这个窗口…" _
