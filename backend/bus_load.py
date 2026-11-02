"""Bus load analysis for in-memory CAN session frames."""

from __future__ import annotations

import bisect
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from session_manager import SessionManager

# Avoid huge JSON / UI freezes on long logs (e.g. 16h @ 1s windows).
_MAX_WINDOWS_RETURNED = 500


def classic_frame_bits(dlc: int, extended: bool = False, stuffing: str = "estimate") -> int:
    dlc = max(0, min(8, int(dlc)))
    if extended:
        stuffable = 1 + 11 + 1 + 1 + 18 + 1 + 1 + 1 + 4 + 8 * dlc + 15
    else:
        stuffable = 1 + 11 + 1 + 1 + 1 + 4 + 8 * dlc + 15
    fixed = 1 + 1 + 1 + 7 + 3
    base = stuffable + fixed
    if stuffing == "none":
        return base
    if stuffing == "max":
        return stuffable + (stuffable - 1) // 4 + fixed
    return stuffable + max(0, (stuffable - 10) // 5) + fixed


def build_id_map(session: SessionManager) -> dict[int, tuple[str, str]]:
    mapping: dict[int, tuple[str, str]] = {}
    if not session.db:
        return mapping
    for msg in session.db.messages:
        senders = list(msg.senders) if msg.senders else []
        ecu = senders[0] if senders else "未分类"
        mapping[msg.frame_id] = (ecu, msg.name)
    return mapping


@dataclass
class FrameAgg:
    frame_id: int
    ecu: str
    name: str
    count: int = 0
    bits: int = 0


def _ecu_rows_from_aggs(
    aggs: dict[tuple[str, int], FrameAgg],
    capacity: float,
) -> list[dict[str, Any]]:
    by_ecu: dict[str, list[FrameAgg]] = defaultdict(list)
    for agg in aggs.values():
        by_ecu[agg.ecu].append(agg)

    ecu_rows: list[dict[str, Any]] = []
    for ecu in sorted(by_ecu.keys()):
        frame_list = sorted(by_ecu[ecu], key=lambda a: a.frame_id)
        ecu_bits = sum(a.bits for a in frame_list)
        ecu_count = sum(a.count for a in frame_list)
        frames_out = [
            {
                "frame_id": a.frame_id,
                "frame_id_hex": f"0x{a.frame_id:X}",
                "name": a.name or f"ID_0x{a.frame_id:X}",
                "count": a.count,
                "bits": a.bits,
                "load_pct": round(100.0 * a.bits / capacity, 4) if capacity else 0.0,
            }
            for a in frame_list
        ]
        ecu_rows.append(
            {
                "ecu": ecu,
                "bits": ecu_bits,
                "frame_count": ecu_count,
                "load_pct": round(100.0 * ecu_bits / capacity, 4) if capacity else 0.0,
                "frames": frames_out,
            }
        )
    return ecu_rows


def _empty_window(ws: float, we: float, bitrate: int) -> dict[str, Any]:
    wdur = max(we - ws, 1e-9)
    capacity = bitrate * wdur
    return {
        "t_start": ws,
        "t_end": we,
        "duration": wdur,
        "capacity_bits": capacity,
        "total_bits": 0,
        "total_load_pct": 0.0,
        "frame_count": 0,
        "ecus": [],
    }


def _window_summary(
    ws: float,
    we: float,
    bitrate: int,
    total_bits: int,
    frame_count: int,
) -> dict[str, Any]:
    wdur = max(we - ws, 1e-9)
    capacity = bitrate * wdur
    return {
        "t_start": ws,
        "t_end": we,
        "duration": wdur,
        "capacity_bits": capacity,
        "total_bits": total_bits,
        "total_load_pct": round(100.0 * total_bits / capacity, 4) if capacity else 0.0,
        "frame_count": frame_count,
    }


def analyze_session_bus_load(
    session: SessionManager,
    *,
    bitrate: int = 500_000,
    window_sec: float = 1.0,
    stuffing: str = "estimate",
    t_start: float | None = None,
    t_end: float | None = None,
) -> dict[str, Any]:
    """Single-pass bus load over session frames.

    Returns overall ECU/frame breakdown plus optional per-window totals.
    Window list is capped when there are too many buckets.
    """
    if not session.has_log:
        raise ValueError("请先加载日志")
    if bitrate <= 0:
        raise ValueError("波特率必须 > 0")

    store = session.frames
    if not store:
        raise ValueError("日志中无帧数据")
    all_ts, all_ids, all_dlc = store.ts, store.ids, store.dlc

    t0 = float(t_start) if t_start is not None else all_ts[0]
    t1 = float(t_end) if t_end is not None else all_ts[-1]
    if t1 < t0:
        raise ValueError("t_end 必须 >= t_start")

    id_map = build_id_map(session)
    use_windows = window_sec is not None and float(window_sec) > 0
    w = float(window_sec) if use_windows else 0.0

    overall_aggs: dict[tuple[str, int], FrameAgg] = {}
    overall_bits = 0
    overall_count = 0

    n_windows = 1
    if use_windows:
        n_windows = max(1, int((t1 - t0) / w + 0.999999999))
    win_bits = [0] * n_windows
    win_counts = [0] * n_windows

    bits_by_dlc = [classic_frame_bits(d, False, stuffing) for d in range(9)]
    for i in range(bisect.bisect_left(all_ts, t0), bisect.bisect_right(all_ts, t1)):
        ts = all_ts[i]
        fid = all_ids[i]
        ecu, name = id_map.get(fid, ("未分类", ""))
        bits = bits_by_dlc[all_dlc[i]]
        overall_bits += bits
        overall_count += 1
        key = (ecu, fid)
        agg = overall_aggs.get(key)
        if agg is None:
            overall_aggs[key] = FrameAgg(frame_id=fid, ecu=ecu, name=name, count=1, bits=bits)
        else:
            agg.count += 1
            agg.bits += bits

        if use_windows:
            idx = int((ts - t0) / w)
            if idx >= n_windows:
                idx = n_windows - 1
            elif idx < 0:
                idx = 0
            win_bits[idx] += bits
            win_counts[idx] += 1

    overall_dur = max(t1 - t0, 1e-9)
    overall_cap = bitrate * overall_dur
    overall = {
        "t_start": t0,
        "t_end": t1,
        "duration": overall_dur,
        "capacity_bits": overall_cap,
        "total_bits": overall_bits,
        "total_load_pct": round(100.0 * overall_bits / overall_cap, 4) if overall_cap else 0.0,
        "frame_count": overall_count,
        "ecus": _ecu_rows_from_aggs(overall_aggs, overall_cap),
    }

    windows: list[dict[str, Any]] = []
    peak: dict[str, Any]
    if not use_windows:
        peak = dict(overall)
        windows = [_window_summary(t0, t1, bitrate, overall_bits, overall_count)]
        windows[0]["ecus"] = overall["ecus"]
    else:
        peak = _empty_window(t0, min(t0 + w, t1), bitrate)
        peak_idx = 0
        for i in range(n_windows):
            ws = t0 + i * w
            we = min(ws + w, t1)
            summary = _window_summary(ws, we, bitrate, win_bits[i], win_counts[i])
            if summary["total_load_pct"] >= peak["total_load_pct"]:
                peak = summary
                peak_idx = i
            windows.append(summary)

        windows_truncated = False
        if len(windows) > _MAX_WINDOWS_RETURNED:
            windows_truncated = True
            # Keep peak + evenly sampled neighbors for trend glance.
            keep = {0, len(windows) - 1, peak_idx}
            step = max(1, len(windows) // (_MAX_WINDOWS_RETURNED - 3))
            keep.update(range(0, len(windows), step))
            windows = [windows[i] for i in sorted(keep)[:_MAX_WINDOWS_RETURNED]]
        else:
            windows_truncated = False

        return {
            "bitrate": bitrate,
            "stuffing": stuffing,
            "window_sec": w,
            "t_start": t0,
            "t_end": t1,
            "duration": t1 - t0,
            "overall": overall,
            "peak": peak,
            "windows": windows,
            "window_count": n_windows,
            "windows_truncated": windows_truncated,
            "has_dbc": session.has_dbc,
            "log": session.log_name,
            "dbc": session.dbc_name,
        }

    return {
        "bitrate": bitrate,
        "stuffing": stuffing,
        "window_sec": None,
        "t_start": t0,
        "t_end": t1,
        "duration": t1 - t0,
        "overall": overall,
        "peak": peak,
        "windows": windows,
        "window_count": 1,
        "windows_truncated": False,
        "has_dbc": session.has_dbc,
        "log": session.log_name,
        "dbc": session.dbc_name,
    }
