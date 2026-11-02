"""Desktop launcher: start API server and open browser."""

from __future__ import annotations

import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}/"


def main() -> int:
    backend = Path(__file__).resolve().parent
    venv_python = backend / ".venv" / "Scripts" / "python.exe"
    python = venv_python if venv_python.is_file() else Path(sys.executable)

    if not (backend / ".venv").is_dir():
        print("未找到 .venv，请先在 backend 目录执行: python -m venv .venv && pip install -r requirements.txt")
        input("按回车退出…")
        return 1

    env = os.environ.copy()
    if "CAN_REPLAY_DATA" not in env:
        local = os.environ.get("LOCALAPPDATA")
        if local:
            env["CAN_REPLAY_DATA"] = str(Path(local) / "CAN-Replay")

    print(f"数据目录: {env.get('CAN_REPLAY_DATA', '(默认)')}")
    print(f"启动服务 {URL}")



#erergerbgeg




    proc = subprocess.Popen(
        [
            str(python),
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            HOST,
            "--port",
            str(PORT),
        ],
        cwd=str(backend),
        env=env,
    )

    time.sleep(1.2)
    webbrowser.open(URL)

    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
