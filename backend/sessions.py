"""Per-browser session registry.

Desktop mode: one shared user ("local") stored directly in the data dir.
Server mode (``CAN_REPLAY_MULTI_USER=1``): each browser gets an anonymous id
cookie, its own data dir under ``users/<id>`` and its own in-memory session.
Idle sessions are dropped from memory (and restored from disk on next visit);
user dirs not visited for ``keep_days`` are deleted.
"""

from __future__ import annotations

import asyncio
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from starlette.concurrency import run_in_threadpool

from session_manager import SessionManager
from workspace_store import WorkspaceStore, default_data_dir

LOCAL_UID = "local"
_UID_RE = re.compile(r"^[0-9a-f]{32}$")
_SEEN_FILE = ".last_seen"
_SEEN_WRITE_INTERVAL = 600.0
_SWEEP_INTERVAL = 60.0
_PURGE_INTERVAL = 3600.0


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


class UserContext:
    def __init__(self, uid: str, workspace: WorkspaceStore) -> None:
        self.uid = uid
        self.workspace = workspace
        self.session: SessionManager | None = None
        self.restored_ui: dict[str, Any] = {}
        self.last_access = time.time()
        self.seen_written = 0.0
        self.lock = asyncio.Lock()


class SessionRegistry:
    def __init__(
        self,
        base_dir: Path | None = None,
        *,
        multi_user: bool | None = None,
        idle_minutes: float | None = None,
        max_loaded: int | None = None,
        keep_days: float | None = None,
    ) -> None:
        self.base_dir = base_dir or default_data_dir()
        self.multi_user = _env_flag("CAN_REPLAY_MULTI_USER") if multi_user is None else multi_user
        self.idle_seconds = 60.0 * (
            _env_num("CAN_REPLAY_IDLE_MIN", 30) if idle_minutes is None else idle_minutes
        )
        self.max_loaded = int(
            _env_num("CAN_REPLAY_MAX_LOADED", 20) if max_loaded is None else max_loaded
        )
        self.keep_seconds = 86400.0 * (
            _env_num("CAN_REPLAY_KEEP_DAYS", 30) if keep_days is None else keep_days
        )
        self._contexts: dict[str, UserContext] = {}
        self._last_sweep = time.monotonic()
        self._last_purge = 0.0

    @property
    def users_dir(self) -> Path:
        return self.base_dir / "users"

    def resolve_uid(self, cookie_value: str | None) -> tuple[str, bool]:
        """Return (uid, is_new). New ids must be sent back as a cookie."""
        if not self.multi_user:
            return LOCAL_UID, False
        if cookie_value and _UID_RE.match(cookie_value):
            return cookie_value, False
        return secrets.token_hex(16), True

    def _user_dir(self, uid: str) -> Path:
        return self.users_dir / uid if self.multi_user else self.base_dir

    def get(self, uid: str) -> UserContext:
        ctx = self._contexts.get(uid)
        if ctx is None:
            ctx = UserContext(uid, WorkspaceStore(self._user_dir(uid)))
            self._contexts[uid] = ctx
        ctx.last_access = time.time()
        return ctx

    def ensure_loaded(self, ctx: UserContext) -> bool:
        """Blocking; call in a worker thread while holding ``ctx.lock``."""
        loaded = False
        if ctx.session is None:
            session = SessionManager()
            ctx.restored_ui = ctx.workspace.restore_into(session)
            session.set_calc_defs(ctx.workspace.load_calc_defs(), strict=False)
            ctx.session = session
            loaded = True
        if self.multi_user and time.time() - ctx.seen_written > _SEEN_WRITE_INTERVAL:
            try:
                ctx.workspace.data_dir.mkdir(parents=True, exist_ok=True)
                (ctx.workspace.data_dir / _SEEN_FILE).write_text(str(int(time.time())))
                ctx.seen_written = time.time()
            except OSError:
                pass
        return loaded

    def unload_idle(self, *, force: bool = False) -> int:
        """Drop idle / least-recent sessions from memory. Must run on the event loop."""
        if not self.multi_user:
            return 0
        now_mono = time.monotonic()
        if not force and now_mono - self._last_sweep < _SWEEP_INTERVAL:
            return 0
        self._last_sweep = now_mono
        now = time.time()
        dropped = 0
        loaded = [c for c in self._contexts.values() if c.session is not None]
        for ctx in loaded:
            if now - ctx.last_access > self.idle_seconds and not ctx.lock.locked():
                ctx.session = None
                dropped += 1
        loaded = sorted(
            (c for c in self._contexts.values() if c.session is not None),
            key=lambda c: c.last_access,
        )
        excess = len(loaded) - self.max_loaded
        for ctx in loaded:
            if excess <= 0:
                break
            if not ctx.lock.locked():
                ctx.session = None
                dropped += 1
                excess -= 1
        return dropped

    async def purge_stale_dirs(self) -> int:
        """Delete user dirs not visited for ``keep_days``."""
        if not self.multi_user or self.keep_seconds <= 0:
            return 0
        now_mono = time.monotonic()
        if self._last_purge and now_mono - self._last_purge < _PURGE_INTERVAL:
            return 0
        self._last_purge = now_mono
        busy = {uid for uid, c in self._contexts.items() if c.session is not None or c.lock.locked()}
        removed = await run_in_threadpool(self._purge_dirs, busy)
        for uid in removed:
            ctx = self._contexts.get(uid)
            if ctx is not None and ctx.session is None and not ctx.lock.locked():
                del self._contexts[uid]
        return len(removed)

    def _purge_dirs(self, busy: set[str]) -> list[str]:
        if not self.users_dir.is_dir():
            return []
        cutoff = time.time() - self.keep_seconds
        removed: list[str] = []
        for d in self.users_dir.iterdir():
            if not d.is_dir() or d.name in busy or not _UID_RE.match(d.name):
                continue
            marker = d / _SEEN_FILE
            try:
                seen = marker.stat().st_mtime if marker.exists() else d.stat().st_mtime
            except OSError:
                continue
            if seen < cutoff:
                shutil.rmtree(d, ignore_errors=True)
                removed.append(d.name)
        return removed

    def stats(self) -> dict[str, Any]:
        return {
            "multi_user": self.multi_user,
            "known_users": len(self._contexts),
            "loaded_sessions": sum(1 for c in self._contexts.values() if c.session is not None),
            "max_loaded": self.max_loaded,
            "idle_minutes": self.idle_seconds / 60,
        }
