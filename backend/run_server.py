"""Intranet web server entry: multi-user, listens on all interfaces.

Runs uvicorn in a child process and supervises it: the child is restarted when
backend ``*.py`` files change (code published to the server) or when it crashes.
Static UI files need no restart; browsers revalidate them on every refresh.

Environment overrides:
  CAN_REPLAY_PORT          listening port (default 8000)
  CAN_REPLAY_DATA          data dir (default <project>/server-data)
  CAN_REPLAY_AUTO_RELOAD   1 = restart when backend .py files change (default 1)
  CAN_REPLAY_IDLE_MIN / CAN_REPLAY_MAX_LOADED / CAN_REPLAY_KEEP_DAYS / CAN_REPLAY_MAX_UPLOAD_MB
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
POLL_SEC = 1.0
SETTLE_SEC = 2.0
CRASH_BACKOFF_SEC = 3.0


def _lan_addresses() -> list[str]:
    addrs: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                addrs.add(ip)
    except OSError:
        pass
    return sorted(addrs)


def _log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def _code_snapshot() -> dict[str, tuple[int, int]]:
    snap: dict[str, tuple[int, int]] = {}
    for p in BACKEND.glob("*.py"):
        try:
            st = p.stat()
        except OSError:
            continue
        snap[p.name] = (st.st_mtime_ns, st.st_size)
    return snap


def _wait_settled(snap: dict[str, tuple[int, int]]) -> None:
    """Wait until a multi-file copy has finished."""
    while True:
        time.sleep(SETTLE_SEC)
        nxt = _code_snapshot()
        if nxt == snap:
            return
        snap = nxt


def _stop(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _supervise(cmd: list[str]) -> None:
    while True:
        snap = _code_snapshot()
        proc = subprocess.Popen(cmd, cwd=str(BACKEND))
        try:
            while True:
                time.sleep(POLL_SEC)
                code = proc.poll()
                if code is not None:
                    _log(f"服务进程退出（代码 {code}），{CRASH_BACKOFF_SEC:g} 秒后重启")
                    time.sleep(CRASH_BACKOFF_SEC)
                    break
                cur = _code_snapshot()
                if cur != snap:
                    _wait_settled(cur)
                    _log("检测到代码更新，重启服务…")
                    _stop(proc)
                    break
        except KeyboardInterrupt:
            _stop(proc)
            return


def main() -> None:
    os.environ.setdefault("CAN_REPLAY_MULTI_USER", "1")
    os.environ.setdefault("CAN_REPLAY_DATA", str(BACKEND.parent / "server-data"))
    port = int(os.environ.get("CAN_REPLAY_PORT", "8000"))
    reload = os.environ.get("CAN_REPLAY_AUTO_RELOAD", "1").strip() not in ("0", "false", "no")

    print("=" * 56)
    print("  CAN 回放 — 网页版服务器")
    print("=" * 56)
    print(f"数据目录: {os.environ['CAN_REPLAY_DATA']}")
    print(f"代码更新自动生效: {'是' if reload else '否'}")
    print("同事在浏览器打开以下任一地址即可使用：")
    print(f"  http://{socket.gethostname()}:{port}/")
    for ip in _lan_addresses():
        print(f"  http://{ip}:{port}/")
    print("关闭本窗口即停止服务。")
    print("=" * 56, flush=True)

    os.environ.setdefault("FORWARDED_ALLOW_IPS", "*")
    uvicorn_args = ["main:app", "--host", "0.0.0.0", "--port", str(port), "--proxy-headers"]
    if reload:
        _supervise([sys.executable, "-m", "uvicorn", *uvicorn_args])
    else:
        os.chdir(BACKEND)
        sys.path.insert(0, str(BACKEND))
        import uvicorn

        uvicorn.main(uvicorn_args)


if __name__ == "__main__":
    main()
