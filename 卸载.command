#!/bin/bash
# Shotboard 片板 —— 卸载（停止后台服务、删除 Shotboard.app）。样片数据默认保留。
AGENT="com.shotboard.server"
PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
DEST="$HOME/Library/Application Support/Shotboard"

echo ""
echo "  ● Shotboard 片板 · 卸载"
echo "  ─────────────────────────────────"
launchctl bootout "gui/$(id -u)/$AGENT" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1
rm -f "$PLIST"
echo "  ✓ 已停止后台服务"
for APP in "/Applications/Shotboard.app" "$HOME/Applications/Shotboard.app"; do
  [ -d "$APP" ] && rm -rf "$APP" && echo "  ✓ 已删除 $APP"
done
echo ""
if [ -d "$DEST" ]; then
  N=$(ls "$DEST/data/images" 2>/dev/null | wc -l | tr -d ' ')
  echo "  你的样片库（$N 张）还保存在："
  echo "  $DEST"
  read -r -p "  要把样片库也一起删掉吗？删掉后无法恢复。输入 yes 确认，直接回车则保留：" ans
  if [ "$ans" = "yes" ]; then
    rm -rf "$DEST" && echo "  ✓ 已删除样片库"
  else
    echo "  已保留。以后重新安装会自动用上这些数据。"
  fi
fi
echo ""
read -r -p "  按回车键关闭…" _
