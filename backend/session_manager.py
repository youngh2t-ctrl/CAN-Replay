"""In-memory CAN log session with DBC-backed signal decode."""

from __future__ import annotations

import bisect
import io
import math
import uuid
from array import array
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cantools
from can.io import ASCReader, BLFReader

from calc_engine import CalcError, evaluate, normalize_definition

CALC_PREFIX = "calc:"

_DBC_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "gbk", "cp1252", "latin-1")


def _decode_dbc_bytes(content: bytes) -> str:
    """Decode DBC bytes; automotive DBC files are often GBK/GB18030, not UTF-8."""
    if content.startswith(b"\xef\xbb\xbf"):
        return content.decode("utf-8-sig")

    best_text: str | None = None
    best_score: tuple[int, int] | None = None
    for enc in _DBC_ENCODINGS:
        try:
            text = content.decode(enc)
        except UnicodeDecodeError:
            continue
        score = (text.count("\ufffd"), sum(1 for ch in text if ord(ch) in range(0x80, 0xA0)))
        if best_score is None or score < best_score:
            best_score = score
            best_text = text
    if best_text is not None:
        return best_text
    return content.decode("latin-1", errors="replace")


class FrameStore:
    """Columnar classic-CAN frame storage (~21 bytes/frame instead of ~250 for objects).

    Payloads are zero-padded to 8 bytes; ``dlc`` keeps the real length.
    """

    __slots__ = ("ts", "ids", "dlc", "data")

    def __init__(self) -> None:
        self.ts = array("d")
        self.ids = array("I")
        self.dlc = array("B")
        self.data = bytearray()

    def __len__(self) -> int:
        return len(self.ts)

    def __bool__(self) -> bool:
        return len(self.ts) > 0

    def append(self, timestamp: float, arbitration_id: int, payload: bytes) -> None:
        self.ts.append(timestamp)
        self.ids.append(arbitration_id)
        self.dlc.append(len(payload))
        self.data += payload.ljust(8, b"\x00")

    def payload(self, i: int, length: int | None = None) -> bytes:
        """Payload of frame ``i``; ``length`` pads/truncates like a DBC message length."""
        o = i * 8
        if length is None:
            return bytes(self.data[o : o + self.dlc[i]])
        raw = bytes(self.data[o : o + min(length, 8)])
        return raw.ljust(length, b"\x00") if length > 8 else raw

    def clear(self) -> None:
        self.ts = array("d")
        self.ids = array("I")
        self.dlc = array("B")
        self.data = bytearray()

    def sort_by_time(self) -> None:
        ts = self.ts
        if all(ts[i] <= ts[i + 1] for i in range(len(ts) - 1)):
            return
        order = sorted(range(len(ts)), key=ts.__getitem__)
        data = self.data
        self.ts = array("d", (ts[i] for i in order))
        self.ids = array("I", (self.ids[i] for i in order))
        self.dlc = array("B", (self.dlc[i] for i in order))
        self.data = bytearray(b"".join(bytes(data[i * 8 : i * 8 + 8]) for i in order))


@dataclass
class SignalSeries:
    key: str
    name: str
    unit: str
    choices: dict[str, str] | None = None
    timestamps: list[float] = field(default_factory=list)
    values: list[float] = field(default_factory=list)


@dataclass
class DbcLibraryEntry:
    id: str
    name: str
    content: bytes
    db: Any


class SessionManager:
    def __init__(self) -> None:
        self.frames = FrameStore()
        self.log_name: str | None = None
        self.log_start_text: str | None = None
        self.has_wall_time: bool = False
        self.db: cantools.database.Database | None = None
        self.dbc_name: str | None = None
        self.active_dbc_id: str | None = None
        self._dbc_library: dict[str, DbcLibraryEntry] = {}
        self._series_cache: dict[str, SignalSeries] = {}
        self._calc_defs: dict[str, dict[str, Any]] = {}

    @property
    def has_log(self) -> bool:
        return bool(self.frames)

    @property
    def has_dbc(self) -> bool:
        return self.db is not None

    @property
    def time_range(self) -> tuple[float, float]:
        if not self.frames:
            return 0.0, 0.0
        return self.frames.ts[0], self.frames.ts[-1]

    def clear_log(self) -> None:
        self.frames.clear()
        self.log_name = None
        self.log_start_text = None
        self.has_wall_time = False
        self._series_cache.clear()

    def clear_dbc(self) -> None:
        self.db = None
        self.dbc_name = None
        self.active_dbc_id = None
        self._dbc_library.clear()
        self._series_cache.clear()

    def list_dbcs(self) -> list[dict[str, Any]]:
        return [
            {
                "id": e.id,
                "name": e.name,
                "active": e.id == self.active_dbc_id,
                "message_count": len(e.db.messages) if e.db else 0,
            }
            for e in self._dbc_library.values()
        ]

    def _activate_entry(self, entry: DbcLibraryEntry) -> dict[str, Any]:
        self.active_dbc_id = entry.id
        self.dbc_name = entry.name
        self.db = entry.db
        self._series_cache.clear()
        return self._build_tree_payload(entry.name)

    def add_dbc_bytes(self, filename: str, content: bytes, *, activate: bool = True) -> dict[str, Any]:
        """Add DBC to library. Same filename replaces existing entry."""
        db = cantools.database.load_string(_decode_dbc_bytes(content))
        existing = next((e for e in self._dbc_library.values() if e.name == filename), None)
        entry_id = existing.id if existing else uuid.uuid4().hex[:12]
        entry = DbcLibraryEntry(id=entry_id, name=filename, content=content, db=db)
        self._dbc_library[entry_id] = entry
        if activate or self.active_dbc_id is None:
            tree = self._activate_entry(entry)
        else:
            tree = self._build_tree_payload(self.dbc_name or "")
        return {
            **tree,
            "id": entry.id,
            "dbcs": self.list_dbcs(),
            "active_dbc_id": self.active_dbc_id,
        }

    def set_active_dbc(self, dbc_id: str) -> dict[str, Any]:
        entry = self._dbc_library.get(dbc_id)
        if not entry:
            raise KeyError(f"DBC 不存在: {dbc_id}")
        tree = self._activate_entry(entry)
        return {
            **tree,
            "id": entry.id,
            "dbcs": self.list_dbcs(),
            "active_dbc_id": self.active_dbc_id,
        }

    def remove_dbc(self, dbc_id: str) -> dict[str, Any]:
        if dbc_id not in self._dbc_library:
            raise KeyError(f"DBC 不存在: {dbc_id}")
        was_active = dbc_id == self.active_dbc_id
        del self._dbc_library[dbc_id]
        if was_active:
            self._series_cache.clear()
            if self._dbc_library:
                first = next(iter(self._dbc_library.values()))
                tree = self._activate_entry(first)
            else:
                self.db = None
                self.dbc_name = None
                self.active_dbc_id = None
                tree = {
                    "filename": None,
                    "message_count": 0,
                    "messages": [],
                    "ecus": [],
                }
        else:
            tree = self._build_tree_payload(self.dbc_name or "") if self.db else {
                "filename": None,
                "message_count": 0,
                "messages": [],
                "ecus": [],
            }
        return {
            **tree,
            "dbcs": self.list_dbcs(),
            "active_dbc_id": self.active_dbc_id,
        }

    def load_log_bytes(self, filename: str, content: bytes) -> dict[str, Any]:
        suffix = Path(filename).suffix.lower()
        if suffix not in (".asc", ".blf"):
            raise ValueError("仅支持 .asc 与 .blf 文件")

        self.clear_log()
        self.log_name = filename

        if suffix == ".asc":
            text = io.TextIOWrapper(io.BytesIO(content), encoding="utf-8", errors="replace")
            # relative_timestamp=False：把 ASC 头 date + 行内时间合成绝对时间戳
            # date 无时区，按「本机本地时区」解释（与 python-can / 常见 Vector 工具一致）
            reader = ASCReader(text, relative_timestamp=False)
        else:
            reader = BLFReader(io.BytesIO(content))

        frames = self.frames
        for msg in reader:
            if msg.is_error_frame or msg.is_remote_frame:
                continue
            data = bytes(msg.data)
            if len(data) > 8:
                continue
            frames.append(float(msg.timestamp), int(msg.arbitration_id), data)

        if not frames:
            raise ValueError("日志中未解析到有效 CAN 帧")
        frames.sort_by_time()

        t0, t1 = self.time_range
        # Unix 量级（约 2001 年后）视为墙上时钟；否则仍是相对秒
        self.has_wall_time = t0 > 1_000_000_000
        if suffix == ".asc":
            raw_date = getattr(reader, "date", None)
            self.log_start_text = str(raw_date).strip() if raw_date else None
        elif self.has_wall_time:
            from datetime import datetime

            self.log_start_text = datetime.fromtimestamp(t0).strftime("%Y-%m-%d %H:%M:%S")

        return {
            "filename": filename,
            "frame_count": len(self.frames),
            "t_start": t0,
            "t_end": t1,
            "duration": t1 - t0,
            "has_wall_time": self.has_wall_time,
            "log_start_text": self.log_start_text,
            "timezone_note": (
                "ASC/多数工具的 date 不含时区，按本机本地时区显示；无法从文件判定原始时区"
                if self.has_wall_time
                else None
            ),
        }

    def load_dbc_bytes(self, filename: str, content: bytes) -> dict[str, Any]:
        """Add to library and activate (same-name replaces)."""
        return self.add_dbc_bytes(filename, content, activate=True)

    def _build_tree_payload(self, filename: str) -> dict[str, Any]:
        if not self.db:
            return {
                "filename": filename,
                "message_count": 0,
                "messages": [],
                "ecus": [],
            }
        ecu_map: dict[str, list[dict[str, Any]]] = {}
        messages: list[dict[str, Any]] = []

        for msg in self.db.messages:
            signals = [self._signal_entry(msg.frame_id, sig) for sig in msg.signals]
            senders = list(msg.senders) if msg.senders else []
            ecu_name = senders[0] if senders else "未分类"
            entry = {
                "name": msg.name,
                "frame_id": msg.frame_id,
                "frame_id_hex": f"0x{msg.frame_id:X}",
                "length": msg.length,
                "ecu": ecu_name,
                "cycle_time": msg.cycle_time,
                "signals": signals,
            }
            msg_comment = self._dbc_comment(msg)
            if msg_comment:
                entry["comment"] = msg_comment
            messages.append(entry)
            ecu_map.setdefault(ecu_name, []).append(entry)

        ecus = [
            {"name": name, "messages": msgs}
            for name, msgs in sorted(ecu_map.items(), key=lambda x: x[0])
        ]
        return {
            "filename": filename,
            "message_count": len(messages),
            "messages": messages,
            "ecus": ecus,
        }

    def get_dbc_tree(self) -> list[dict[str, Any]]:
        if not self.db:
            return []
        return self._build_ecu_tree_from_db()

    def _build_ecu_tree_from_db(self) -> list[dict[str, Any]]:
        assert self.db is not None
        ecu_map: dict[str, list[dict[str, Any]]] = {}
        for msg in self.db.messages:
            signals = [self._signal_entry(msg.frame_id, sig) for sig in msg.signals]
            senders = list(msg.senders) if msg.senders else []
            ecu_name = senders[0] if senders else "未分类"
            msg_entry: dict[str, Any] = {
                "name": msg.name,
                "frame_id": msg.frame_id,
                "frame_id_hex": f"0x{msg.frame_id:X}",
                "cycle_time": msg.cycle_time,
                "signals": signals,
            }
            msg_comment = self._dbc_comment(msg)
            if msg_comment:
                msg_entry["comment"] = msg_comment
            ecu_map.setdefault(ecu_name, []).append(msg_entry)
        return [
            {"name": name, "messages": msgs}
            for name, msgs in sorted(ecu_map.items(), key=lambda x: x[0])
        ]

    @staticmethod
    def _signal_key(frame_id: int, signal_name: str) -> str:
        return f"0x{frame_id:X}:{signal_name}"

    @staticmethod
    def _clean_choice_name(text: str) -> str:
        return str(text).replace("\ufffd", "").strip()

    @staticmethod
    def _serialize_choices(sig: Any) -> dict[str, str] | None:
        raw = getattr(sig, "choices", None)
        if not raw:
            return None
        out: dict[str, str] = {}
        for k, v in raw.items():
            if hasattr(v, "name"):
                text = SessionManager._clean_choice_name(str(v.name))
            else:
                text = SessionManager._clean_choice_name(str(v))
            if text:
                out[str(int(k))] = text
        return out or None

    @staticmethod
    def _dbc_comment(obj: Any) -> str:
        """Prefer plain comment; fall back to multilingual comments dict."""
        text = getattr(obj, "comment", None)
        if text:
            return SessionManager._clean_choice_name(str(text))
        comments = getattr(obj, "comments", None)
        if isinstance(comments, dict):
            for key in (None, "FOR-ALL", "ZH", "CN", "zh", "cn", "EN", "en"):
                if key in comments and comments[key]:
                    return SessionManager._clean_choice_name(str(comments[key]))
            for v in comments.values():
                if v:
                    return SessionManager._clean_choice_name(str(v))
        return ""

    def _signal_entry(self, frame_id: int, sig: Any) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "name": sig.name,
            "unit": self._normalize_unit(sig.unit),
            "key": self._signal_key(frame_id, sig.name),
        }
        comment = self._dbc_comment(sig)
        if comment:
            entry["comment"] = comment
        choices = self._serialize_choices(sig)
        if choices:
            entry["choices"] = choices
        return entry

    @staticmethod
    def _choice_label(choices: dict[str, str] | None, value: float | None) -> str | None:
        if not choices or value is None:
            return None
        iv = int(round(value))
        for key in (
            str(iv),
            str(int(value)),
            f"0x{iv:X}",
            f"0x{iv:x}",
            str(value),
        ):
            label = choices.get(key)
            if label:
                return SessionManager._clean_choice_name(label)
        return None

    def _parse_key(self, key: str) -> tuple[int, str]:
        frame_part, name = key.split(":", 1)
        frame_id = int(frame_part, 16)
        return frame_id, name

    @staticmethod
    def _coerce_float(val: Any) -> float | None:
        if isinstance(val, bool):
            return None
        if isinstance(val, (int, float)):
            f = float(val)
            return f if f == f else None
        if hasattr(val, "value"):
            return SessionManager._coerce_float(getattr(val, "value"))
        try:
            f = float(val)
            return f if f == f else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _normalize_unit(unit: str | None) -> str:
        if not unit:
            return ""
        u = str(unit).strip()
        if u in ("—", "-", "??", "?"):
            return ""
        u = u.replace("\ufffd", "").strip()
        return u

    def _signal_meta(self, key: str) -> tuple[str, str, dict[str, str] | None]:
        frame_id, sig_name = self._parse_key(key)
        try:
            msg_def = self.db.get_message_by_frame_id(frame_id)  # type: ignore[union-attr]
            sig_def = msg_def.get_signal_by_name(sig_name)
            return (
                sig_name,
                self._normalize_unit(sig_def.unit),
                self._serialize_choices(sig_def),
            )
        except (KeyError, AttributeError):
            return sig_name, "", None

    # ---- virtual (calculated) signals ----

    def list_calc_defs(self) -> list[dict[str, Any]]:
        return list(self._calc_defs.values())

    def set_calc_defs(self, defs: list[dict[str, Any]], *, strict: bool = True) -> list[dict[str, Any]]:
        """Replace all definitions. ``strict=False`` silently drops invalid ones."""
        clean: dict[str, dict[str, Any]] = {}
        for i, raw in enumerate(defs or []):
            try:
                d = normalize_definition(raw, uuid.uuid4().hex[:10])
            except CalcError as exc:
                if strict:
                    name = raw.get("name") if isinstance(raw, dict) else None
                    raise CalcError(f"{name or f'第 {i + 1} 个'}: {exc}") from exc
                continue
            clean[d["id"]] = d
        self._calc_defs = clean
        for k in [k for k in self._series_cache if k.startswith(CALC_PREFIX)]:
            del self._series_cache[k]
        return self.list_calc_defs()

    def _compute_calc(self, definition: dict[str, Any]) -> tuple[list[float], list[float]]:
        src_keys = list(definition["vars"].values())
        self._ensure_dbc_decoded(src_keys)
        variables: dict[str, tuple[list[float], list[float]]] = {}
        for var, key in definition["vars"].items():
            s = self._series_cache.get(key)
            variables[var] = (s.timestamps, s.values) if s else ([], [])
        return evaluate(definition["expr"], variables, t_base=self.time_range[0])

    def preview_calc(self, raw: dict[str, Any]) -> dict[str, Any]:
        d = normalize_definition({**raw, "name": raw.get("name") or "preview"}, "preview")
        ts, vs = self._compute_calc(d)
        return {
            "count": len(vs),
            "min": min(vs) if vs else None,
            "max": max(vs) if vs else None,
            "t_start": ts[0] if ts else None,
            "t_end": ts[-1] if ts else None,
        }

    def ensure_decoded(self, keys: list[str]) -> None:
        if not self.db or not self.frames:
            return
        base = [k for k in keys if not k.startswith(CALC_PREFIX)]
        self._ensure_dbc_decoded(base)
        for key in keys:
            if not key.startswith(CALC_PREFIX) or key in self._series_cache:
                continue
            d = self._calc_defs.get(key[len(CALC_PREFIX):])
            series = SignalSeries(
                key=key,
                name=d["name"] if d else key,
                unit=d["unit"] if d else "",
            )
            if d:
                try:
                    series.timestamps, series.values = self._compute_calc(d)
                except CalcError:
                    pass
            self._series_cache[key] = series

    def _ensure_dbc_decoded(self, keys: list[str]) -> None:
        if not self.db or not self.frames:
            return
        missing = [k for k in keys if k not in self._series_cache]
        if not missing:
            return

        needed: dict[int, list[str]] = {}
        for key in missing:
            frame_id, sig_name = self._parse_key(key)
            needed.setdefault(frame_id, []).append(sig_name)
            name, unit, choices = self._signal_meta(key)
            self._series_cache[key] = SignalSeries(
                key=key, name=name, unit=unit, choices=choices
            )

        targets: dict[int, tuple[Any, list[tuple[str, SignalSeries]]]] = {}
        for frame_id, sig_names in needed.items():
            try:
                message = self.db.get_message_by_frame_id(frame_id)
            except KeyError:
                continue
            outs = [
                (name, self._series_cache[self._signal_key(frame_id, name)])
                for name in sig_names
            ]
            targets[frame_id] = (message, outs)
        if not targets:
            return

        store = self.frames
        ts, ids = store.ts, store.ids
        coerce = self._coerce_float
        for i in range(len(store)):
            target = targets.get(ids[i])
            if target is None:
                continue
            message, outs = target
            try:
                decoded = message.decode(
                    store.payload(i, message.length), decode_choices=False
                )
            except Exception:
                continue
            t = ts[i]
            for sig_name, series in outs:
                raw = decoded.get(sig_name)
                if raw is None:
                    continue
                val = coerce(raw)
                if val is None:
                    continue
                series.timestamps.append(t)
                series.values.append(val)

    def decode_signals(self, keys: list[str]) -> list[dict[str, Any]]:
        self.ensure_decoded(keys)
        return [
            self._series_to_dict(self._series_cache[k])
            for k in keys
            if k in self._series_cache
        ]

    def signal_stats(self, keys: list[str], t_cursor: float | None = None) -> list[dict[str, Any]]:
        if not keys:
            return []
        self.ensure_decoded(keys)
        out: list[dict[str, Any]] = []
        for key in keys:
            series = self._series_cache.get(key)
            if not series or not series.values:
                out.append(
                    {
                        "key": key,
                        "name": series.name if series else key,
                        "unit": self._normalize_unit(series.unit if series else ""),
                        "min": None,
                        "max": None,
                        "avg": None,
                        "value": None,
                        "value_label": None,
                    }
                )
                continue
            vals = series.values
            vmin = min(vals)
            vmax = max(vals)
            vavg = sum(vals) / len(vals)
            vcur = vals[-1]
            if t_cursor is not None and series.timestamps:
                idx = self._nearest_index(series.timestamps, t_cursor)
                vcur = series.values[idx]
            item: dict[str, Any] = {
                "key": key,
                "name": series.name,
                "unit": self._normalize_unit(series.unit),
                "min": vmin,
                "max": vmax,
                "avg": vavg,
                "value": vcur,
                "value_label": self._choice_label(series.choices, vcur),
            }
            if series.choices:
                item["choices"] = series.choices
            out.append(item)
        return out

    def range_stats(
        self, keys: list[str], t_start: float | None, t_end: float | None
    ) -> list[dict[str, Any]]:
        """Full-resolution statistics of each signal inside [t_start, t_end]."""
        if not keys:
            return []
        self.ensure_decoded(keys)
        lo_t = -math.inf if t_start is None else t_start
        hi_t = math.inf if t_end is None else t_end
        out: list[dict[str, Any]] = []
        for key in keys:
            series = self._series_cache.get(key)
            item: dict[str, Any] = {
                "key": key,
                "name": series.name if series else key,
                "unit": series.unit if series else "",
                "count": 0,
            }
            if series and series.timestamps:
                i0 = bisect.bisect_left(series.timestamps, lo_t)
                i1 = bisect.bisect_right(series.timestamps, hi_t)
                vals = series.values[i0:i1]
                n = len(vals)
                if n:
                    avg = sum(vals) / n
                    var = sum((v - avg) ** 2 for v in vals) / n
                    item.update(
                        count=n,
                        min=min(vals),
                        max=max(vals),
                        avg=avg,
                        std=math.sqrt(var),
                        rms=math.sqrt(sum(v * v for v in vals) / n),
                        first=vals[0],
                        last=vals[-1],
                        delta=vals[-1] - vals[0],
                        t_first=series.timestamps[i0],
                        t_last=series.timestamps[i1 - 1],
                    )
            out.append(item)
        return out

    def values_at_time(self, keys: list[str], t: float) -> list[dict[str, Any]]:
        if not keys:
            return []
        self.ensure_decoded(keys)

        out: list[dict[str, Any]] = []
        for key in keys:
            series = self._series_cache.get(key)
            if not series or not series.timestamps:
                out.append({"key": key, "name": key, "value": None, "unit": ""})
                continue
            idx = self._nearest_index(series.timestamps, t)
            out.append(
                {
                    "key": key,
                    "name": series.name,
                    "value": series.values[idx],
                    "unit": series.unit,
                    "timestamp": series.timestamps[idx],
                }
            )
        return out

    @staticmethod
    def _nearest_index(timestamps: list[float], t: float) -> int:
        lo, hi = 0, len(timestamps) - 1
        if t <= timestamps[0]:
            return 0
        if t >= timestamps[hi]:
            return hi
        while lo < hi:
            mid = (lo + hi) // 2
            if timestamps[mid] < t:
                lo = mid + 1
            else:
                hi = mid
        if lo > 0 and abs(timestamps[lo - 1] - t) <= abs(timestamps[lo] - t):
            return lo - 1
        return lo

    @staticmethod
    def _series_to_dict(series: SignalSeries) -> dict[str, Any]:
        d: dict[str, Any] = {
            "key": series.key,
            "name": series.name,
            "unit": series.unit,
            "timestamps": series.timestamps,
            "values": series.values,
        }
        if series.choices:
            d["choices"] = series.choices
        return d

    def downsample_series(
        self, keys: list[str], t_start: float, t_end: float, max_points: int = 2000
    ) -> list[dict[str, Any]]:
        if not keys:
            return []
        self.ensure_decoded(keys)

        out: list[dict[str, Any]] = []
        for key in keys:
            series = self._series_cache.get(key)
            if not series:
                continue
            i0 = bisect.bisect_left(series.timestamps, t_start)
            i1 = bisect.bisect_right(series.timestamps, t_end)
            ts = series.timestamps[i0:i1]
            vs = series.values[i0:i1]
            if len(ts) > max_points:
                ts, vs = self._minmax_downsample(ts, vs, max_points)
            item: dict[str, Any] = {
                "key": series.key,
                "name": series.name,
                "unit": series.unit,
                "timestamps": ts,
                "values": vs,
            }
            if series.choices:
                item["choices"] = series.choices
            out.append(item)
        return out

    @staticmethod
    def _minmax_downsample(
        timestamps: list[float], values: list[float], max_points: int
    ) -> tuple[list[float], list[float]]:
        bucket = max(1, len(timestamps) // (max_points // 2))
        ts_out: list[float] = []
        vs_out: list[float] = []
        for i in range(0, len(timestamps), bucket):
            chunk_t = timestamps[i : i + bucket]
            chunk_v = values[i : i + bucket]
            if not chunk_t:
                continue
            min_i = min(range(len(chunk_v)), key=lambda j: chunk_v[j])
            max_i = max(range(len(chunk_v)), key=lambda j: chunk_v[j])
            if min_i <= max_i:
                ts_out.append(chunk_t[min_i])
                vs_out.append(chunk_v[min_i])
                if min_i != max_i:
                    ts_out.append(chunk_t[max_i])
                    vs_out.append(chunk_v[max_i])
            else:
                ts_out.append(chunk_t[max_i])
                vs_out.append(chunk_v[max_i])
                ts_out.append(chunk_t[min_i])
                vs_out.append(chunk_v[min_i])
        return ts_out, vs_out
