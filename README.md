# can-replay-tool

Offline CAN log replay and analysis tool (ASC / BLF + DBC).

Load a vehicle network log, decode signals with a DBC, and inspect them on
compact multi-signal charts — similar to a lightweight CANoe Graphics window.
Runs as a local desktop app or as a multi-user intranet web service. The same
static UI is shared by both modes.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- Import **Vector ASC** / **BLF** logs (classic CAN, DLC ≤ 8)
- Load one or more **DBC** files; browse **ECU → message → signal** tree
- Chinese / English signal search with highlight
- Per-signal charts with distinct colors; global chart height (30–150 px)
- Shared sticky time ruler (does not steal space from the last chart)
- Measure cursors (A / B, Δt), hover X/Y tooltip
- Message cycle time from DBC `GenMsgCycleTime`
- Signal groups (save / switch / import / export)
- Virtual calculated signals (`+ − × ÷`, `diff`, `integ`, `mavg`, …)
- Range statistics and classic-CAN bus-load estimate
- Desktop single-user mode + intranet multi-user web mode
- Vendored **uPlot** (works offline / on intranet without CDN)

## Requirements

- **Python 3.10+**
- Optional: Node.js 18+ only if you develop the React frontend under `frontend/`
  (the built-in UI in `backend/static/` needs no Node)

## Quick start (desktop)

Windows:

1. Double-click **`首次安装.bat`** once (creates `.venv` and installs dependencies).
2. Double-click **`启动 CAN 回放.bat`**.

The browser opens at `http://127.0.0.1:8000/`. Closing the window stops the server.
Workspace (last log / DBC / selection) is restored from `%LOCALAPPDATA%\CAN-Replay\`.

Command line (any OS):

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
# source .venv/bin/activate

pip install -r requirements.txt
python launch.py
# or: uvicorn main:app --host 127.0.0.1 --port 8000
```

### Try the sample

1. **Load log** → `samples/demo.asc`
2. **Load DBC** → `samples/demo.dbc`
3. Select `EngineSpeed`, `ThrottlePos`, `VehicleSpeed`
4. Zoom with the mouse wheel (Alt/Shift + wheel for Y); use the top bar for fit / overview

## Intranet web mode (multi-user)

Colleagues only need a browser. Logs are uploaded and parsed on the server;
each browser gets an isolated session (cookie).

**Windows server**

1. Copy this project to the server and run **`首次安装.bat`**.
2. Right-click **`设置服务器开机自启.bat`** → Run as administrator  
   (firewall port 8000 + auto-start), or temporarily use **`启动网页版服务器.bat`**.
3. Share the project folder (write access) if you want one-click updates via
   **`发布更新到服务器.bat`**.

**Linux**

```bash
# Docker
docker compose up -d --build

# or without Docker
sh start_server.sh
```

Open `http://<server-hostname-or-ip>:8000/`.

| Environment variable | Default | Meaning |
|----------------------|---------|---------|
| `CAN_REPLAY_PORT` | `8000` | Listen port |
| `CAN_REPLAY_DATA` | `server-data` | Data directory |
| `CAN_REPLAY_MULTI_USER` | `1` (via `run_server.py`) | Per-browser isolation |
| `CAN_REPLAY_MAX_UPLOAD_MB` | `200` | Upload size limit |
| `CAN_REPLAY_IDLE_MIN` | `30` | Unload idle sessions from memory |
| `CAN_REPLAY_MAX_LOADED` | `20` | Max in-memory sessions |
| `CAN_REPLAY_KEEP_DAYS` | `30` | Delete unused user data |

ASC timestamps without a time zone are interpreted in the **server local time zone**
(Docker image defaults to `Asia/Shanghai`).

## Project layout

```
can-replay-tool/
  backend/              # FastAPI + cantools + python-can
    static/             # Production UI (desktop + web)
    launch.py           # Desktop launcher (127.0.0.1)
    run_server.py       # Intranet server (0.0.0.0, multi-user)
    sessions.py         # Per-browser session registry
  frontend/             # Optional React + Vite UI (dev)
  samples/              # Tiny demo ASC / DBC (synthetic)
  Dockerfile
  docker-compose.yml
  LICENSE               # MIT
```

## License

This project is licensed under the [MIT License](LICENSE).

Third-party notice: charting uses [uPlot](https://github.com/leeoniya/uPlot) (MIT),
vendored under `backend/static/vendor/`.

## Limitations

- Logs are loaded fully into memory (compact storage ~21 bytes/frame;
  ~50 MB ASC ≈ 800k frames ≈ ~17 MB resident)
- Classic CAN only (no CAN FD)
- Not a bus interface tool (no real-time TX/RX / hardware)

## Contributing

Issues and pull requests are welcome. Please do not commit:

- `.venv/`, `node_modules/`
- `server-data/` (runtime user sessions / uploaded logs)
- Real vehicle DBC / logs or any proprietary OEM data — keep using `samples/` for demos
