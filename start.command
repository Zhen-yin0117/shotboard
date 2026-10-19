#!/bin/bash
# Shotboard 片板 —— 双击启动（macOS）
cd "$(dirname "$0")"
PORT=8765

echo ""
echo "  ● Shotboard 片板"
echo "  ─────────────────────────────"

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import sys" >/dev/null 2>&1; then
  echo "  没有找到 Python 3。"
  echo "  macOS 会弹出安装「命令行开发者工具」的窗口，点「安装」，装好后再双击本文件。"
  xcode-select --install 2>/dev/null
  read -p "  按回车键关闭…"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "  第一次启动，正在准备运行环境（大约 1 分钟）…"
  python3 -m venv .venv || { echo "  创建环境失败"; read -p "  按回车键关闭…"; exit 1; }
fi
source .venv/bin/activate
if [ ! -f ".venv/.installed" ] || [ requirements.txt -nt .venv/.installed ]; then
  echo "  正在安装依赖…"
  pip install -q --upgrade pip >/dev/null 2>&1
  pip install -q -r requirements.txt || { echo "  安装依赖失败，请检查网络后重试"; read -p "  按回车键关闭…"; exit 1; }
  touch .venv/.installed
fi

# 如果已经在运行，直接打开
if curl -s "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1; then
  echo "  已经在运行了，正在打开浏览器…"
  open "http://127.0.0.1:$PORT"
  exit 0
fi

echo "  启动中…  地址：http://127.0.0.1:$PORT"
echo "  使用期间请不要关闭这个窗口；关掉窗口就会停止。"
echo ""
(sleep 2 && open "http://127.0.0.1:$PORT") &
python -m uvicorn app.main:app --host 127.0.0.1 --port $PORT --log-level warning
