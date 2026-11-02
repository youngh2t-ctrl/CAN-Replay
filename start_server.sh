#!/usr/bin/env sh
# Linux 服务器（不用 Docker 时）：首次自动建虚拟环境并安装依赖，然后启动网页版服务。
set -e
cd "$(dirname "$0")/backend"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip -q
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python run_server.py
