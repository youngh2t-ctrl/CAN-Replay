"""CAN log offline replay API."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
from starlette.concurrency import run_in_threadpool

from bus_load import analyze_session_bus_load
from calc_engine import FUNCTION_NAMES, CalcError
from session_manager import SessionManager
from sessions import SessionRegistry, UserContext

APP_VERSION = "1.1.0"
STATIC_DIR = Path(__file__).parent / "static"
UID_COOKIE = "canreplay_uid"
UID_COOKIE_MAX_AGE = 400 * 86400
MAX_UPLOAD_MB = float(os.environ.get("CAN_REPLAY_MAX_UPLOAD_MB", "") or 200)

app = FastAPI(title="CAN Replay", version=APP_VERSION)
registry = SessionRegistry()

if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def revalidate_ui_assets(request: Request, call_next):
    """Browsers must revalidate UI files so a server update shows up on refresh."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _issue_uid_cookie(response: Response, uid: str) -> None:
    response.set_cookie(
        UID_COOKIE, uid, max_age=UID_COOKIE_MAX_AGE, httponly=True, samesite="lax"
    )


async def current_user(request: Request, response: Response) -> AsyncIterator[UserContext]:
    """Resolve the caller's session; requests of one user run one at a time."""
    uid, is_new = registry.resolve_uid(request.cookies.get(UID_COOKIE))
    if is_new:
        _issue_uid_cookie(response, uid)
    await registry.purge_stale_dirs()
    ctx = registry.get(uid)
    async with ctx.lock:
        loaded = await run_in_threadpool(registry.ensure_loaded, ctx)
        registry.unload_idle(force=loaded)
        yield ctx


User = Annotated[UserContext, Depends(current_user)]


def _session(ctx: UserContext) -> SessionManager:
    assert ctx.session is not None
    return ctx.session


async def _read_upload(file: UploadFile) -> bytes:
    limit = int(MAX_UPLOAD_MB * 1024 * 1024)
    if file.size is not None and file.size > limit:
        raise HTTPException(status_code=413, detail=f"文件过大（上限 {MAX_UPLOAD_MB:g} MB）")
    content = await file.read()
    if len(content) > limit:
        raise HTTPException(status_code=413, detail=f"文件过大（上限 {MAX_UPLOAD_MB:g} MB）")
    return content


class DecodeRequest(BaseModel):
    keys: list[str]


class ViewportRequest(BaseModel):
    keys: list[str]
    t_start: float
    t_end: float
    max_points: int = 2000


class StatsRequest(BaseModel):
    keys: list[str]
    t: float | None = None


class WorkspaceUiState(BaseModel):
    model_config = ConfigDict(extra="allow")

    selected_keys: list[str] = []
    view_start: float | None = None
    view_end: float | None = None
    cursor_time: float | None = None
    measure_b: float | None = None
    measure_mode: bool = False
    chart_heights: dict[str, int] = {}
    global_chart_h: int | None = None
    sidebar_width: int | None = None
    show_points: bool = False
    points_panel_open: bool = False
    active_group_id: str | None = None
    stats_panel_open: bool = False
    stats_range: str | None = None


class SignalGroup(BaseModel):
    id: str
    name: str
    keys: list[str] = []
    created_at: str | None = None


class GroupsBody(BaseModel):
    groups: list[SignalGroup]


class CalcDef(BaseModel):
    id: str | None = None
    name: str = ""
    expr: str = ""
    vars: dict[str, str] = {}
    unit: str = ""


class CalcDefsBody(BaseModel):
    defs: list[CalcDef]


class RangeStatsRequest(BaseModel):
    keys: list[str]
    t_start: float | None = None
    t_end: float | None = None


@app.get("/")
def index(request: Request) -> FileResponse:
    index_file = STATIC_DIR / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=404, detail="UI 未找到")
    response = FileResponse(index_file)
    uid, is_new = registry.resolve_uid(request.cookies.get(UID_COOKIE))
    if is_new:
        _issue_uid_cookie(response, uid)
    return response


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": APP_VERSION, **registry.stats()}


@app.get("/api/session")
def get_session(ctx: User) -> dict:
    session = _session(ctx)
    t0, t1 = session.time_range
    return {
        "log": session.log_name,
        "dbc": session.dbc_name,
        "has_log": session.has_log,
        "has_dbc": session.has_dbc,
        "frame_count": len(session.frames),
        "t_start": t0,
        "t_end": t1,
        "duration": t1 - t0 if session.has_log else 0,
        "restored": bool(ctx.restored_ui),
        "dbcs": session.list_dbcs(),
        "active_dbc_id": session.active_dbc_id,
        "has_wall_time": session.has_wall_time,
        "log_start_text": session.log_start_text,
        "timezone_note": (
            "ASC/多数工具的 date 不含时区，按本机本地时区显示；无法从文件判定原始时区"
            if session.has_wall_time
            else None
        ),
        "multi_user": registry.multi_user,
        "version": APP_VERSION,
    }


@app.get("/api/workspace")
def get_workspace(ctx: User) -> dict:
    session = _session(ctx)
    ui = ctx.workspace.get_ui_state() or ctx.restored_ui
    return {
        "ui": ui,
        "has_log": session.has_log,
        "has_dbc": session.has_dbc,
        "data_dir": None if registry.multi_user else str(ctx.workspace.data_dir),
        "dbcs": session.list_dbcs(),
        "active_dbc_id": session.active_dbc_id,
    }


@app.post("/api/workspace")
def save_workspace(body: WorkspaceUiState, ctx: User) -> dict:
    ctx.workspace.save_ui_state(body.model_dump())
    return {"ok": True}


def _load_and_cache_log(ctx: UserContext, name: str, content: bytes) -> dict:
    result = _session(ctx).load_log_bytes(name, content)
    ctx.workspace.save_log(name, content)
    return result


@app.post("/api/log")
async def upload_log(ctx: User, file: UploadFile = File(...)) -> dict:
    content = await _read_upload(file)
    name = file.filename or "log.asc"
    try:
        return await run_in_threadpool(_load_and_cache_log, ctx, name, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class DbcActiveRequest(BaseModel):
    id: str


def _add_dbcs(ctx: UserContext, items: list[tuple[str, bytes]]) -> dict:
    session = _session(ctx)
    last: dict = {}
    for name, content in items:
        last = session.add_dbc_bytes(name, content, activate=True)
    ctx.workspace.save_dbc_library(session)
    return last


@app.post("/api/dbc")
async def upload_dbc(ctx: User, file: UploadFile = File(...)) -> dict:
    """Add one DBC into library and activate it."""
    content = await _read_upload(file)
    name = file.filename or "network.dbc"
    try:
        return await run_in_threadpool(_add_dbcs, ctx, [(name, content)])
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"DBC 解析失败: {exc}") from exc


@app.post("/api/dbc/batch")
async def upload_dbc_batch(ctx: User, files: list[UploadFile] = File(...)) -> dict:
    """Import multiple DBCs; last one becomes active."""
    if not files:
        raise HTTPException(status_code=400, detail="未选择 DBC 文件")
    items = [
        (file.filename or f"network_{i}.dbc", await _read_upload(file))
        for i, file in enumerate(files)
    ]
    try:
        return await run_in_threadpool(_add_dbcs, ctx, items)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"DBC 解析失败: {exc}") from exc


@app.get("/api/dbc/list")
def dbc_list(ctx: User) -> dict:
    session = _session(ctx)
    return {
        "dbcs": session.list_dbcs(),
        "active_dbc_id": session.active_dbc_id,
    }


@app.post("/api/dbc/active")
def set_active_dbc(body: DbcActiveRequest, ctx: User) -> dict:
    session = _session(ctx)
    try:
        result = session.set_active_dbc(body.id)
        ctx.workspace.save_dbc_library(session)
        return result
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/api/dbc/{dbc_id}")
def delete_dbc(dbc_id: str, ctx: User) -> dict:
    session = _session(ctx)
    try:
        result = session.remove_dbc(dbc_id)
        ctx.workspace.save_dbc_library(session)
        return result
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/dbc/tree")
def dbc_tree(ctx: User) -> dict:
    session = _session(ctx)
    if not session.has_dbc:
        raise HTTPException(status_code=400, detail="请先加载 DBC 文件")
    return {
        "ecus": session.get_dbc_tree(),
        "dbcs": session.list_dbcs(),
        "active_dbc_id": session.active_dbc_id,
        "filename": session.dbc_name,
    }


def _require(session: SessionManager, *, dbc: bool = True) -> None:
    if not session.has_log:
        raise HTTPException(status_code=400, detail="请先加载日志文件")
    if dbc and not session.has_dbc:
        raise HTTPException(status_code=400, detail="请先加载 DBC 文件")


@app.post("/api/signals/decode")
def decode_signals(body: DecodeRequest, ctx: User) -> dict:
    session = _session(ctx)
    _require(session)
    return {"series": session.decode_signals(body.keys)}


@app.post("/api/signals/viewport")
def signals_viewport(body: ViewportRequest, ctx: User) -> dict:
    session = _session(ctx)
    _require(session, dbc=False)
    series = session.downsample_series(
        body.keys, body.t_start, body.t_end, body.max_points
    )
    return {"series": series}


@app.get("/api/signals/at-time")
def signals_at_time(
    ctx: User,
    keys: str = Query(..., description="逗号分隔的信号 key"),
    t: float = Query(...),
) -> dict:
    key_list = [k.strip() for k in keys.split(",") if k.strip()]
    values = _session(ctx).values_at_time(key_list, t)
    return {"t": t, "values": values}


@app.get("/api/signals/stats")
def signals_stats(
    ctx: User,
    keys: str = Query(..., description="逗号分隔的信号 key"),
    t: float | None = Query(None, description="游标时刻，用于当前值"),
) -> dict:
    session = _session(ctx)
    _require(session, dbc=False)
    key_list = [k.strip() for k in keys.split(",") if k.strip()]
    return {"stats": session.signal_stats(key_list, t)}


@app.post("/api/signals/stats")
def signals_stats_post(body: StatsRequest, ctx: User) -> dict:
    session = _session(ctx)
    _require(session)
    return {"stats": session.signal_stats(body.keys, body.t)}


@app.post("/api/stats/range")
def stats_range(body: RangeStatsRequest, ctx: User) -> dict:
    session = _session(ctx)
    _require(session)
    return {"stats": session.range_stats(body.keys, body.t_start, body.t_end)}


@app.get("/api/groups")
def get_groups(ctx: User) -> dict:
    return {"groups": ctx.workspace.load_groups()}


@app.put("/api/groups")
def put_groups(body: GroupsBody, ctx: User) -> dict:
    groups = []
    for g in body.groups:
        name = g.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="信号组名称不能为空")
        groups.append({**g.model_dump(), "name": name})
    ctx.workspace.save_groups(groups)
    return {"groups": groups}


@app.get("/api/calc")
def get_calc_defs(ctx: User) -> dict:
    return {"defs": _session(ctx).list_calc_defs(), "functions": FUNCTION_NAMES}


@app.put("/api/calc")
def put_calc_defs(body: CalcDefsBody, ctx: User) -> dict:
    try:
        defs = _session(ctx).set_calc_defs([d.model_dump() for d in body.defs], strict=True)
    except CalcError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ctx.workspace.save_calc_defs(defs)
    return {"defs": defs, "functions": FUNCTION_NAMES}


@app.post("/api/calc/preview")
def preview_calc(body: CalcDef, ctx: User) -> dict:
    session = _session(ctx)
    if not session.has_log or not session.has_dbc:
        raise HTTPException(status_code=400, detail="请先加载日志和 DBC")
    try:
        return session.preview_calc(body.model_dump())
    except CalcError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class BusLoadRequest(BaseModel):
    bitrate: int = 500_000
    window_sec: float = 1.0
    stuffing: str = "estimate"
    t_start: float | None = None
    t_end: float | None = None


@app.post("/api/busload")
def bus_load_query(body: BusLoadRequest, ctx: User) -> dict:
    """Query bus load for the currently loaded log (optional DBC for ECU names)."""
    session = _session(ctx)
    _require(session, dbc=False)
    stuffing = body.stuffing if body.stuffing in ("estimate", "none", "max") else "estimate"
    try:
        return analyze_session_bus_load(
            session,
            bitrate=body.bitrate,
            window_sec=body.window_sec,
            stuffing=stuffing,
            t_start=body.t_start,
            t_end=body.t_end,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
