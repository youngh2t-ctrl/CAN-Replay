"""Persist last session (log, multi-DBC library, UI) under local app data."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from session_manager import SessionManager

STATE_VERSION = 2
LOG_CACHE = "log.cache"
DBC_CACHE = "dbc.cache"  # legacy single-file cache
STATE_FILE = "workspace.json"
META_LOG = "log.meta.json"
META_DBC = "dbc.meta.json"
DBC_LIB_DIR = "dbc_lib"
DBC_LIB_INDEX = "dbc_lib.json"
GROUPS_FILE = "signal_groups.json"
CALC_FILE = "calc_signals.json"


def default_data_dir() -> Path:
    env = os.environ.get("CAN_REPLAY_DATA")
    if env:
        return Path(env)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "CAN-Replay"
    return Path.home() / ".can-replay"


class WorkspaceStore:
    def __init__(self, data_dir: Path | None = None) -> None:
        self.data_dir = data_dir or default_data_dir()
        self.cache_dir = self.data_dir / "cache"
        self.state_path = self.data_dir / STATE_FILE
        self.dbc_lib_dir = self.cache_dir / DBC_LIB_DIR
        self.dbc_lib_index = self.cache_dir / DBC_LIB_INDEX

    def ensure_dirs(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.dbc_lib_dir.mkdir(parents=True, exist_ok=True)

    def save_log(self, filename: str, content: bytes) -> None:
        self.ensure_dirs()
        (self.cache_dir / LOG_CACHE).write_bytes(content)
        (self.cache_dir / META_LOG).write_text(
            json.dumps({"filename": filename}, ensure_ascii=False),
            encoding="utf-8",
        )

    def save_dbc(self, filename: str, content: bytes) -> None:
        """Legacy single-DBC save; also used when only one active file is needed."""
        self.ensure_dirs()
        (self.cache_dir / DBC_CACHE).write_bytes(content)
        (self.cache_dir / META_DBC).write_text(
            json.dumps({"filename": filename}, ensure_ascii=False),
            encoding="utf-8",
        )

    def save_dbc_library(self, session: SessionManager) -> None:
        """Persist all DBCs in library + active id."""
        self.ensure_dirs()
        # Clear old library files
        if self.dbc_lib_dir.is_dir():
            for p in self.dbc_lib_dir.glob("*"):
                if p.is_file():
                    p.unlink(missing_ok=True)

        items: list[dict[str, str]] = []
        for entry in session._dbc_library.values():
            path = self.dbc_lib_dir / f"{entry.id}.dbc"
            path.write_bytes(entry.content)
            items.append({"id": entry.id, "name": entry.name})

        index = {
            "active_id": session.active_dbc_id,
            "items": items,
        }
        self.dbc_lib_index.write_text(
            json.dumps(index, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # Keep legacy single cache in sync with active DBC
        if session.active_dbc_id and session.active_dbc_id in session._dbc_library:
            active = session._dbc_library[session.active_dbc_id]
            self.save_dbc(active.name, active.content)

    def _read_meta_name(self, meta_file: str, default: str) -> str:
        path = self.cache_dir / meta_file
        if not path.is_file():
            return default
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return str(data.get("filename") or default)
        except (json.JSONDecodeError, OSError):
            return default

    def restore_into(self, session: SessionManager) -> dict[str, Any]:
        """Load cached log/DBC library into session. Returns UI state dict."""
        ui: dict[str, Any] = {}
        log_path = self.cache_dir / LOG_CACHE

        # Prefer multi-DBC library
        restored_lib = False
        if self.dbc_lib_index.is_file():
            try:
                index = json.loads(self.dbc_lib_index.read_text(encoding="utf-8"))
                items = index.get("items") or []
                active_id = index.get("active_id")
                for item in items:
                    eid = str(item.get("id") or "")
                    name = str(item.get("name") or f"{eid}.dbc")
                    path = self.dbc_lib_dir / f"{eid}.dbc"
                    if not eid or not path.is_file():
                        continue
                    activate = eid == active_id
                    session.add_dbc_bytes(
                        name, path.read_bytes(), activate=activate or not session.has_dbc
                    )
                if active_id and active_id in session._dbc_library:
                    session.set_active_dbc(active_id)
                restored_lib = bool(session._dbc_library)
            except Exception:
                restored_lib = False

        # Fallback: legacy single DBC cache
        if not restored_lib:
            dbc_path = self.cache_dir / DBC_CACHE
            if dbc_path.is_file():
                try:
                    session.load_dbc_bytes(
                        self._read_meta_name(META_DBC, "network.dbc"),
                        dbc_path.read_bytes(),
                    )
                    self.save_dbc_library(session)
                except Exception:
                    pass

        if log_path.is_file():
            try:
                session.load_log_bytes(
                    self._read_meta_name(META_LOG, "log.asc"),
                    log_path.read_bytes(),
                )
            except Exception:
                pass

        if self.state_path.is_file():
            try:
                raw = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    ui = raw.get("ui") or {}
            except (json.JSONDecodeError, OSError):
                ui = {}

        return ui if isinstance(ui, dict) else {}

    def save_ui_state(self, ui: dict[str, Any]) -> None:
        self.ensure_dirs()
        payload = {"version": STATE_VERSION, "ui": ui}
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    def _read_list(self, filename: str) -> list[dict[str, Any]]:
        path = self.data_dir / filename
        if not path.is_file():
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
        items = raw.get("items") if isinstance(raw, dict) else raw
        return [x for x in items if isinstance(x, dict)] if isinstance(items, list) else []

    def _write_list(self, filename: str, items: list[dict[str, Any]]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / filename
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"version": 1, "items": items}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)

    def load_groups(self) -> list[dict[str, Any]]:
        return self._read_list(GROUPS_FILE)

    def save_groups(self, groups: list[dict[str, Any]]) -> None:
        self._write_list(GROUPS_FILE, groups)

    def load_calc_defs(self) -> list[dict[str, Any]]:
        return self._read_list(CALC_FILE)

    def save_calc_defs(self, defs: list[dict[str, Any]]) -> None:
        self._write_list(CALC_FILE, defs)

    def get_ui_state(self) -> dict[str, Any]:
        if not self.state_path.is_file():
            return {}
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            ui = raw.get("ui") if isinstance(raw, dict) else {}
            return ui if isinstance(ui, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {}

    def clear(self) -> None:
        if self.data_dir.is_dir():
            shutil.rmtree(self.data_dir, ignore_errors=True)
