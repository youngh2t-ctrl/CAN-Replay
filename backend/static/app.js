/* CAN Replay v8 - CANoe-like offline viewer */
(() => {
  const $ = (id) => document.getElementById(id);

  const DEFAULT_CHART_H = 80;
  const MIN_CHART_H = 30;
  const MAX_CHART_H = 150;
  const DEFAULT_SIDEBAR_W = 300;

  let session = null;
  let ecus = [];
  let dbcList = [];
  let selectedOrder = [];
  let views = [];
  let activeViewId = null;
  let collapsedEcu = new Set();
  let collapsedMsg = new Set();
  let cursorTime = null;
  let measureB = null;
  let measureMode = false;
  let viewStart = 0;
  let viewEnd = 0;
  let seriesCache = new Map();
  let statsCache = new Map();
  let nextViewId = 1;
  let dragKey = null;
  let xZoomRefreshTimer = null;
  let showDataPoints = false;
  let workspaceSaveTimer = null;
  let globalChartH = DEFAULT_CHART_H;
  let calcDefs = [];
  let calcFunctions = [];
  let groups = [];
  let activeGroupId = null;
  let statsPanelOpen = false;
  let statsRange = "view";
  let statsRefreshTimer = null;
  let calcEditingId = null;
  const CALC_PREFIX = "calc:";
  const CALC_VARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const ZOOM_WHEEL_STEP = 1.03;
  const PINCH_POWER = 0.22;

  const CHART = {
    grid: "#e8ecf0",
    axis: "#656d76",
    cursor: "#cf222e",
    measure: "#8250df",
  };

  /** Distinct stroke colors per signal (CANoe-like) */
  const SIGNAL_COLORS = [
    "#0969da",
    "#cf222e",
    "#1a7f37",
    "#bf8700",
    "#8250df",
    "#0550ae",
    "#a40e26",
    "#0d9488",
    "#e16b16",
    "#6639ba",
    "#218bff",
    "#db61a2",
    "#116329",
    "#9a6700",
    "#57606a",
  ];

  function signalColor(key) {
    const idx = selectedOrder.indexOf(key);
    if (idx >= 0) return SIGNAL_COLORS[idx % SIGNAL_COLORS.length];
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return SIGNAL_COLORS[h % SIGNAL_COLORS.length];
  }

  function selectedSet() {
    return new Set(selectedOrder);
  }

  const showErr = (m) => {
    const e = $("err");
    if (!e) return;
    e.style.display = m ? "block" : "none";
    e.textContent = m || "";
  };

  function apiErrorMessage(data, fallback) {
    const d = data?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) {
      return d.map((x) => x.msg || JSON.stringify(x)).join("; ");
    }
    return fallback;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(data, res.statusText));
    return data;
  }

  function fmtRel(t, spanSec) {
    const r = t - (session?.t_start || 0);
    const sign = r < 0 ? "-" : "";
    const abs = Math.abs(r);
    const span = spanSec == null ? abs : Math.max(spanSec, 0);
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;

    if (span >= 3600 * 6) {
      return `${sign}${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
    }
    if (span >= 120) {
      const mm = Math.floor(abs / 60);
      return `${sign}${mm}:${String(Math.floor(s)).padStart(2, "0")}`;
    }
    if (span >= 10) {
      const mm = Math.floor(abs / 60);
      return `${sign}${mm}:${s.toFixed(1).padStart(4, "0")}`;
    }
    if (span >= 1) {
      const mm = Math.floor(abs / 60);
      return `${sign}${mm}:${s.toFixed(2).padStart(5, "0")}`;
    }
    const mm = Math.floor(abs / 60);
    return `${sign}${mm}:${s.toFixed(3).padStart(6, "0")}`;
  }

  function hasWallTime() {
    return !!(session?.has_wall_time || (session?.t_start != null && session.t_start > 1e9));
  }

  function currentViewSpan() {
    if (viewStart != null && viewEnd != null && viewEnd > viewStart) {
      return viewEnd - viewStart;
    }
    return Math.max((session?.t_end || 0) - (session?.t_start || 0), 0);
  }

  /**
   * X 轴刻度：按当前视口跨度自适应精度，避免标签重叠。
   * spanSec = 当前视口时长（秒）；游标可用更小的 span 保留精度。
   */
  function fmtAxisTime(t, spanSec) {
    if (t == null || Number.isNaN(t)) return "—";
    const span = spanSec == null ? currentViewSpan() : Math.max(spanSec, 0);
    if (!hasWallTime()) return fmtRel(t, span);

    const d = new Date(t * 1000);
    if (Number.isNaN(d.getTime())) return fmtRel(t, span);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const hms = `${hm}:${p(d.getSeconds())}`;

    // 视口越大，刻度越粗；精度随缩放自动提高
    if (span >= 86400 * 2) return `${md} ${hm}`;
    if (span >= 3600 * 12) return span >= 86400 ? `${md} ${hm}` : hm;
    if (span >= 3600 * 2) return hm;
    if (span >= 600) return hm;
    if (span >= 120) return hms;
    if (span >= 30) return `${hm}:${p(d.getSeconds())}`;
    if (span >= 5) return `${hms}.${Math.floor(d.getMilliseconds() / 100)}`;
    if (span >= 1) return `${hms}.${p(Math.floor(d.getMilliseconds() / 10), 2)}`;
    return `${hms}.${p(d.getMilliseconds(), 3)}`;
  }

  /** 游标 / 顶栏：保留可读细节，不跟轴刻度一样粗 */
  function fmtDetailTime(t) {
    if (t == null || Number.isNaN(t)) return "—";
    if (!hasWallTime()) return fmtRel(t, 0.5);
    const d = new Date(t * 1000);
    if (Number.isNaN(d.getTime())) return fmtRel(t, 0.5);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const span = currentViewSpan();
    const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    if (span >= 86400) {
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hms}`;
    }
    return hms;
  }

  /** 轴标签最小间距（px）：视口越大、标签越短，间距可略紧；毫秒级则拉开 */
  function xAxisTickSpace(_self, _axisIdx, scaleMin, scaleMax, plotDim) {
    const span = Math.max((scaleMax ?? 0) - (scaleMin ?? 0), 1e-9);
    const w = Math.max(plotDim || 400, 200);
    // 目标：大约 4～8 个刻度
    const targetTicks = span >= 3600 ? 5 : span >= 60 ? 6 : 7;
    const byCount = Math.floor(w / targetTicks);
    if (span >= 600) return Math.max(52, Math.min(byCount, 96));
    if (span >= 30) return Math.max(64, Math.min(byCount, 110));
    if (span >= 1) return Math.max(72, Math.min(byCount, 120));
    return Math.max(84, Math.min(byCount, 140));
  }

  function fmtNum(v) {
    if (v == null || Number.isNaN(v)) return "";
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(1);
    if (a >= 100) return v.toFixed(2);
    return v.toFixed(4);
  }

  function cleanLabel(s) {
    return String(s).replace(/\uFFFD/g, "").trim();
  }

  function choiceLabel(choices, value) {
    if (!choices || value == null || Number.isNaN(value)) return "";
    const iv = Math.round(value);
    const keys = [
      String(iv),
      String(parseInt(value, 10)),
      `0x${iv.toString(16).toUpperCase()}`,
      `0x${iv.toString(16)}`,
      String(value),
    ];
    for (const k of keys) {
      const label = choices[k];
      if (label) return cleanLabel(label);
    }
    return "";
  }

  /** 已选信号栏「值」：有枚举定义则只显示名称，否则显示数字 */
  function fmtSelectedValueOnly(v, choices, valueLabel) {
    if (v == null || Number.isNaN(v)) return "";
    if (choices && Object.keys(choices).length) {
      const label = cleanLabel(valueLabel || choiceLabel(choices, v));
      if (label) return esc(label);
    }
    return fmtNum(v);
  }

  function fmtHex(v) {
    if (v == null || Number.isNaN(v)) return "\u2014";
    const iv = Math.round(v);
    if (iv < 0) return `-0x${Math.abs(iv).toString(16).toUpperCase()}`;
    return `0x${iv.toString(16).toUpperCase()}`;
  }

  function syncActiveHighlight() {
    const activeKey = getView(activeViewId)?.key || null;
    document.querySelectorAll("#selected-list .selected-item").forEach((item) => {
      item.classList.toggle("active", !!activeKey && item.dataset.key === activeKey);
    });
    document.querySelectorAll("#views-area .view-panel").forEach((panel) => {
      const view = getView(panel.dataset.vid);
      panel.classList.toggle("active", !!activeKey && view?.key === activeKey);
    });
  }

  function focusChartForKey(key) {
    const view = views.find((v) => v.key === key);
    if (!view) return;
    activeViewId = view.id;
    const panel = document.querySelector(`#views-area .view-panel[data-vid="${view.id}"]`);
    if (panel) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    syncActiveHighlight();
  }

  function revealSelectedItem(key) {
    const item = [...document.querySelectorAll("#selected-list .selected-item")].find(
      (n) => n.dataset.key === key
    );
    if (!item) return;
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    item.classList.remove("flash");
    void item.offsetWidth;
    item.classList.add("flash");
  }

  function clampChartH(h) {
    const n = Number(h);
    if (!Number.isFinite(n)) return DEFAULT_CHART_H;
    return Math.min(MAX_CHART_H, Math.max(MIN_CHART_H, Math.round(n)));
  }

  function syncChartHeightControl() {
    const range = $("chartHeightRange");
    const label = $("chartHeightVal");
    if (range) range.value = String(globalChartH);
    if (label) label.textContent = `${globalChartH}px`;
  }

  function applyGlobalChartHeight(h, { redraw = true } = {}) {
    globalChartH = clampChartH(h);
    syncChartHeightControl();
    views.forEach((v) => {
      v.heightPx = globalChartH;
      const wrap = $(`chart-${v.id}`)?.parentElement;
      if (wrap) wrap.style.height = `${v.heightPx}px`;
      if (redraw && v.plot) drawView(v);
    });
    document.querySelectorAll("#views-area .view-chart-wrap").forEach((wrap) => {
      wrap.style.height = `${globalChartH}px`;
    });
    scheduleWorkspaceSave();
  }

  function buildWorkspaceUi() {
    const heights = {};
    views.forEach((v) => {
      heights[v.key] = v.heightPx || globalChartH;
    });
    const sidebar = $("sidebar");
    return {
      selected_keys: [...selectedOrder],
      view_start: viewStart,
      view_end: viewEnd,
      cursor_time: cursorTime,
      measure_b: measureB,
      measure_mode: measureMode,
      chart_heights: heights,
      global_chart_h: globalChartH,
      sidebar_width: sidebar?.offsetWidth || DEFAULT_SIDEBAR_W,
      show_points: showDataPoints,
      active_group_id: activeGroupId,
      stats_panel_open: statsPanelOpen,
      stats_range: statsRange,
    };
  }

  function scheduleWorkspaceSave() {
    if (!session?.has_log && !session?.has_dbc) return;
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = setTimeout(() => {
      api("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildWorkspaceUi()),
      }).catch(() => {});
    }, 600);
  }

  function flushWorkspaceSave() {
    if (!session?.has_log && !session?.has_dbc) return;
    const payload = JSON.stringify(buildWorkspaceUi());
    fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }

  function restoreWorkspaceUi(ui) {
    if (!ui || typeof ui !== "object") return;
    if (ui.view_start != null && ui.view_end != null && session?.has_log) {
      // 旧缓存可能是相对秒，新日志是绝对时间戳时忽略并重置
      if (hasWallTime() && ui.view_start < 1e9) {
        viewStart = session.t_start;
        viewEnd = session.t_end;
      } else {
        viewStart = ui.view_start;
        viewEnd = ui.view_end;
      }
    } else if (session?.has_log) {
      viewStart = session.t_start;
      viewEnd = session.t_end;
    }
    cursorTime = ui.cursor_time ?? null;
    measureB = ui.measure_b ?? null;
    measureMode = !!ui.measure_mode;
    $("btnMeasure")?.classList.toggle("active", measureMode);
    if (ui.sidebar_width) {
      const sb = $("sidebar");
      if (sb) sb.style.width = `${Math.min(520, Math.max(200, ui.sidebar_width))}px`;
    }
    selectedOrder = Array.isArray(ui.selected_keys) ? [...ui.selected_keys] : [];
    views = [];
    nextViewId = 1;
    activeViewId = null;
    seriesCache.clear();
    statsCache.clear();
    if (ui.global_chart_h != null) {
      globalChartH = clampChartH(ui.global_chart_h);
    } else if (ui.chart_heights && typeof ui.chart_heights === "object") {
      const vals = Object.values(ui.chart_heights).map(Number).filter(Number.isFinite);
      if (vals.length) globalChartH = clampChartH(vals[0]);
    }
    syncChartHeightControl();
    for (const key of selectedOrder) {
      addView(key);
      const v = views.find((x) => x.key === key);
      if (v) v.heightPx = globalChartH;
    }
    showDataPoints = !!(ui.show_points ?? ui.points_panel_open);
    $("btnTogglePoints")?.classList.toggle("active", showDataPoints);
    activeGroupId = ui.active_group_id || null;
    statsPanelOpen = !!ui.stats_panel_open;
    statsRange = ui.stats_range === "ab" ? "ab" : "view";
  }

  function updateTopBar() {
    const vp = $("topbarViewport");
    const cur = $("topbarCursor");
    const meas = $("topbarMeasure");
    const span = currentViewSpan();
    if (vp && session?.has_log) {
      vp.textContent = `视口 ${fmtAxisTime(viewStart, span)} — ${fmtAxisTime(viewEnd, span)}`;
    } else if (vp) {
      vp.textContent = "";
    }
    if (cur) {
      cur.textContent =
        cursorTime != null ? `A: ${fmtDetailTime(cursorTime)}` : "A: —";
    }
    if (meas) {
      if (cursorTime != null && measureB != null) {
        const dt = Math.abs(measureB - cursorTime);
        meas.textContent = `B: ${fmtDetailTime(measureB)} · Δt ${fmtDelta(dt)}`;
      } else if (measureB != null) {
        meas.textContent = `B: ${fmtDetailTime(measureB)} · Δt —`;
      } else if (measureMode) {
        meas.textContent = "标尺: 点击放置 A/B";
      } else {
        meas.textContent = "Δt: —";
      }
    }
  }

  function fmtDelta(sec) {
    if (sec == null || Number.isNaN(sec)) return "—";
    const a = Math.abs(sec);
    if (a >= 60) {
      const m = Math.floor(a / 60);
      const s = a % 60;
      return `${m}m ${s.toFixed(3)}s`;
    }
    if (a >= 1) return `${a.toFixed(3)} s`;
    if (a >= 0.001) return `${(a * 1000).toFixed(2)} ms`;
    return `${(a * 1e6).toFixed(1)} µs`;
  }

  function fmtUnitDisplay(unit) {
    const u = String(unit || "")
      .replace(/\uFFFD/g, "")
      .trim();
    if (!u || u === "—" || u === "-" || u === "??" || u === "?") return "";
    return esc(u);
  }

  function isCalcKey(key) {
    return String(key).startsWith(CALC_PREFIX);
  }

  function findCalcDef(key) {
    const id = String(key).slice(CALC_PREFIX.length);
    return calcDefs.find((d) => d.id === id) || null;
  }

  function findSignalMeta(key) {
    if (isCalcKey(key)) {
      const d = findCalcDef(key);
      return {
        ecu: "\u8ba1\u7b97",
        msg: d ? d.expr : "",
        name: d ? d.name : key,
        unit: d?.unit || "",
        choices: null,
        cycle_time: null,
        calc: true,
        key,
      };
    }
    for (const ecu of ecus) {
      for (const msg of ecu.messages || []) {
        for (const sig of msg.signals || []) {
          if (sig.key === key) {
            return {
              ecu: ecu.name,
              msg: msg.name,
              frame_id: msg.frame_id,
              cycle_time: msg.cycle_time ?? null,
              ...sig,
            };
          }
        }
      }
    }
    const [, name] = key.split(":");
    return { ecu: "", msg: "", name: name || key, unit: "", choices: null, cycle_time: null, key };
  }

  function allSignalKeySet() {
    const set = new Set();
    for (const ecu of ecus) {
      for (const msg of ecu.messages || []) {
        for (const sig of msg.signals || []) set.add(sig.key);
      }
    }
    for (const d of calcDefs) set.add(`${CALC_PREFIX}${d.id}`);
    return set;
  }

  function fmtCycle(ms) {
    if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return "";
    return `${Number(ms)}ms`;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 2600);
  }

  function msgKey(ecu, frameId) {
    return `${ecu}|${String(frameId)}`;
  }

  function normalizeEcus(r) {
    if (r.ecus?.length) {
      return r.ecus.map((ecu) => ({ name: ecu.name, messages: ecu.messages || [] }));
    }
    if (!r.messages?.length) return [];
    const map = new Map();
    for (const m of r.messages) {
      const name = m.ecu || "\u672a\u5206\u7c7b";
      if (!map.has(name)) map.set(name, { name, messages: [] });
      map.get(name).messages.push(m);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function attrEsc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }

  function collapseAllTree() {
    collapsedEcu.clear();
    collapsedMsg.clear();
    for (const ecu of ecus) {
      collapsedEcu.add(ecu.name);
      for (const m of ecu.messages || []) {
        collapsedMsg.add(msgKey(ecu.name, m.frame_id));
      }
    }
  }

  function expandPathForKey(key) {
    const meta = findSignalMeta(key);
    if (meta.ecu) collapsedEcu.delete(meta.ecu);
    if (meta.frame_id != null) collapsedMsg.delete(msgKey(meta.ecu, meta.frame_id));
  }

  function isEcuExpanded(name, q) {
    return q ? true : !collapsedEcu.has(name);
  }

  function isMsgExpanded(ecu, frameId, q) {
    return q ? true : !collapsedMsg.has(msgKey(ecu, frameId));
  }

  function textIncludes(hay, q) {
    if (!q) return true;
    return String(hay || "").toLowerCase().includes(q);
  }

  function signalSearchText(sig) {
    const parts = [sig.name, sig.unit, sig.comment || ""];
    if (sig.choices) {
      for (const v of Object.values(sig.choices)) parts.push(v);
    }
    return parts.join(" ");
  }

  function highlightMatch(text, q) {
    const s = String(text ?? "");
    if (!q) return esc(s);
    const lower = s.toLowerCase();
    const qi = q.toLowerCase();
    let out = "";
    let from = 0;
    let i = lower.indexOf(qi, from);
    if (i < 0) return esc(s);
    while (i >= 0) {
      out += esc(s.slice(from, i));
      out += `<mark class="search-hit">${esc(s.slice(i, i + qi.length))}</mark>`;
      from = i + qi.length;
      i = lower.indexOf(qi, from);
    }
    out += esc(s.slice(from));
    return out;
  }

  function messageMatches(msg, q) {
    if (!q) return true;
    if (textIncludes(`${msg.name} ${msg.frame_id_hex} ${msg.comment || ""}`, q)) return true;
    return (msg.signals || []).some((s) => textIncludes(signalSearchText(s), q));
  }

  function ecuMatches(ecu, q) {
    if (!q) return true;
    if (textIncludes(ecu.name, q)) return true;
    return (ecu.messages || []).some((m) => messageMatches(m, q));
  }

  function signalMatchesQuery(sig, msg, q) {
    if (!q) return true;
    if (textIncludes(signalSearchText(sig), q)) return true;
    // parent message matched → still show signal, but only highlight if signal itself matches
    return textIncludes(`${msg.name} ${msg.frame_id_hex} ${msg.comment || ""}`, q);
  }

  function buildTreeHtml(filterId) {
    const q = ($(filterId)?.value || "").trim().toLowerCase();
    if (!ecus.length) return '<div class="empty">\u52a0\u8f7d DBC \u540e\u9009\u62e9</div>';
    let html = "";
    const sel = selectedSet();
    for (const ecu of ecus) {
      const messages = ecu.messages || [];
      if (!ecuMatches({ ...ecu, messages }, q)) continue;
      const ecuExp = isEcuExpanded(ecu.name, q);
      const ecuHit = q && textIncludes(ecu.name, q);
      html += `<div class="tree-ecu${ecuHit ? " hit" : ""}" role="button" data-ecu="${attrEsc(ecu.name)}">${ecuExp ? "\u25BC" : "\u25B6"} ${highlightMatch(ecu.name, q)}</div>`;
      if (!ecuExp) continue;
      for (const msg of messages) {
        if (!messageMatches(msg, q)) continue;
        const mExp = isMsgExpanded(ecu.name, msg.frame_id, q);
        const msgHit = q && textIncludes(`${msg.name} ${msg.frame_id_hex} ${msg.comment || ""}`, q);
        html += `<div class="tree-msg${msgHit ? " hit" : ""}" role="button" data-ecu="${attrEsc(ecu.name)}" data-frame-id="${msg.frame_id}">${mExp ? "\u25BC" : "\u25B6"} ${highlightMatch(msg.name, q)} (${highlightMatch(msg.frame_id_hex, q)})</div>`;
        if (!mExp) continue;
        for (const sig of msg.signals || []) {
          if (q && !signalMatchesQuery(sig, msg, q)) continue;
          const on = sel.has(sig.key);
          const sigHit = q && textIncludes(signalSearchText(sig), q);
          const commentHtml =
            sig.comment && q && textIncludes(sig.comment, q)
              ? `<span class="sig-comment">${highlightMatch(sig.comment, q)}</span>`
              : sig.comment
                ? `<span class="sig-comment">${esc(sig.comment)}</span>`
                : "";
          html += `<label class="tree-sig${on ? " selected-path" : ""}${sigHit ? " hit" : ""}"><input type="checkbox" data-key="${attrEsc(sig.key)}" ${on ? "checked" : ""}/> ${highlightMatch(sig.name, q)}${sig.unit ? ` [${highlightMatch(sig.unit, q)}]` : ""}${commentHtml}</label>`;
        }
      }
    }
    return html || '<div class="empty">\u65e0\u5339\u914d</div>';
  }

  function renderPickerTree() {
    const el = $("picker-tree");
    if (el) el.innerHTML = buildTreeHtml("pickerFilter");
  }

  function statsFromSeries(ser, key) {
    if (!ser?.values?.length) return null;
    const vals = ser.values;
    let vmin = vals[0];
    let vmax = vals[0];
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
      sum += v;
    }
    let value = vals[vals.length - 1];
    if (cursorTime != null && ser.timestamps?.length) {
      const pt = nearestPoint(ser, cursorTime);
      if (pt) value = pt.v;
    }
    const choices = ser.choices || null;
    return {
      key,
      name: ser.name || key,
      unit: ser.unit || "",
      choices,
      min: vmin,
      max: vmax,
      avg: sum / vals.length,
      value,
      value_label: choiceLabel(choices, value),
    };
  }

  function applyLocalStatsFallback() {
    let ok = false;
    for (const key of selectedOrder) {
      const local = statsFromSeries(seriesCache.get(key), key);
      if (local) {
        statsCache.set(key, local);
        ok = true;
      }
    }
    return ok;
  }

  async function fetchStatsRemote() {
    const body = { keys: selectedOrder };
    if (cursorTime != null) body.t = cursorTime;
    try {
      return await api("/api/signals/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = String(err.message || "");
      if (!/not\s*found/i.test(msg)) throw err;
      const q = new URLSearchParams({ keys: selectedOrder.join(",") });
      if (cursorTime != null) q.set("t", String(cursorTime));
      return await api(`/api/signals/stats?${q}`);
    }
  }

  async function refreshStats() {
    if (!selectedOrder.length) {
      statsCache.clear();
      return;
    }
    if (!session?.has_log || !session?.has_dbc) {
      return;
    }
    try {
      const data = await fetchStatsRemote();
      const stats = data.stats;
      if (!Array.isArray(stats)) {
        throw new Error("统计接口返回格式异常");
      }
      stats.forEach((s) => statsCache.set(s.key, s));
      for (const key of selectedOrder) {
        const st = statsCache.get(key);
        if (st?.min != null && st?.max != null) continue;
        const local = statsFromSeries(seriesCache.get(key), key);
        if (local) statsCache.set(key, local);
      }
      showErr("");
    } catch (err) {
      if (applyLocalStatsFallback()) {
        showErr("");
      } else {
        showErr(err.message || String(err));
      }
    }
  }

  function renderSelectedList() {
    const el = $("selected-list");
    if (!el) return;
    if (!selectedOrder.length) {
      el.innerHTML = '<span class="meta">\u4ece\u4fe1\u53f7\u5e93\u52fe\u9009</span>';
      return;
    }
    let html = "";
    const activeKey = getView(activeViewId)?.key || null;
    for (const key of selectedOrder) {
      const meta = findSignalMeta(key);
      const st = statsCache.get(key) || {};
      const unitDisp = fmtUnitDisplay(st.unit || meta.unit);
      const choices = st.choices || meta.choices || null;
      const valueDisp = fmtSelectedValueOnly(st.value, choices, st.value_label);
      const hexDisp = esc(fmtHex(st.value));
      const isActive = key === activeKey;
      const color = signalColor(key);
      const pathText = `${meta.ecu || "—"} / ${meta.msg || "—"}`;
      html += `<div class="selected-item${isActive ? " active" : ""}" data-key="${attrEsc(key)}">
        <span class="drag-handle" draggable="true" title="\u62d6\u62fd\u6392\u5e8f">\u2630</span>
        <span class="sig-swatch" style="background:${color}"></span>
        <div class="sig-row-scroll">
          <div class="sig-row-inner">
            <div class="sig-jump" title="\u70b9\u51fb\u8df3\u8f6c\u5230\u5bf9\u5e94\u66f2\u7ebf">
              <span class="sig-name">${esc(meta.name)}</span>
              <span class="sig-value sig-copyable" title="\u53ef\u9009\u4e2d\u590d\u5236">${valueDisp || "\u2014"}</span>
            </div>
            ${meta.calc ? "" : `<span class="sig-extra">Hex<strong class="sig-copyable">${hexDisp}</strong></span>`}
            <span class="sig-extra">\u5355\u4f4d<strong>${unitDisp || "\u2014"}</strong></span>
            <span class="sig-extra">${meta.calc ? "\u8868\u8fbe\u5f0f" : "\u8def\u5f84"}<strong>${esc(meta.calc ? meta.msg : pathText)}</strong></span>
            ${fmtCycle(meta.cycle_time) ? `<span class="sig-extra">\u5468\u671f<strong>${esc(fmtCycle(meta.cycle_time))}</strong></span>` : ""}
            ${meta.comment ? `<span class="sig-extra">\u6ce8\u91ca<strong>${esc(meta.comment)}</strong></span>` : ""}
            ${st.min != null ? `<span class="sig-extra">Min<strong>${fmtNum(st.min)}</strong></span>` : ""}
            ${st.max != null ? `<span class="sig-extra">Max<strong>${fmtNum(st.max)}</strong></span>` : ""}
          </div>
        </div>
        <button type="button" class="btn-remove" data-key="${attrEsc(key)}">\u00d7</button>
      </div>`;
    }
    el.innerHTML = html;

    el.querySelectorAll(".btn-remove").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleSignal(btn.dataset.key, false);
      };
    });

    el.querySelectorAll(".sig-copyable").forEach((node) => {
      const stop = (e) => e.stopPropagation();
      node.addEventListener("mousedown", stop);
      node.addEventListener("click", stop);
      node.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
    });

    el.querySelectorAll(".sig-row-scroll").forEach((row) => {
      row.addEventListener(
        "wheel",
        (e) => {
          if (row.scrollWidth <= row.clientWidth + 1) return;
          // Vertical wheel → horizontal pan (CANoe-like dense row)
          if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
            e.preventDefault();
            row.scrollLeft += e.deltaY;
          } else {
            row.scrollLeft += e.deltaX;
          }
        },
        { passive: false }
      );
    });

    el.querySelectorAll(".selected-item").forEach((item) => {
      item.querySelector(".sig-jump")?.addEventListener("click", (e) => {
        e.stopPropagation();
        focusChartForKey(item.dataset.key);
      });
      const handle = item.querySelector(".drag-handle");
      handle?.addEventListener("dragstart", (e) => {
        dragKey = item.dataset.key;
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      handle?.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        dragKey = null;
        el.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (item.dataset.key !== dragKey) item.classList.add("drag-over");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("drag-over");
        const targetKey = item.dataset.key;
        if (!dragKey || dragKey === targetKey) return;
        const from = selectedOrder.indexOf(dragKey);
        const to = selectedOrder.indexOf(targetKey);
        if (from < 0 || to < 0) return;
        selectedOrder.splice(from, 1);
        selectedOrder.splice(to, 0, dragKey);
        reorderViews();
        renderSelectedList();
        renderViews();
        refreshCharts();
      });
    });
    scheduleWorkspaceSave();
  }

  function reorderViews() {
    const map = new Map(views.map((v) => [v.key, v]));
    views = selectedOrder.map((k) => map.get(k)).filter(Boolean);
  }

  function bindTreeContainer(el) {
    if (!el || el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("click", (e) => {
      if (e.target.closest('input[type="checkbox"]')) return;
      const msgNode = e.target.closest(".tree-msg");
      if (msgNode) {
        const k = msgKey(msgNode.dataset.ecu, msgNode.dataset.frameId);
        if (collapsedMsg.has(k)) collapsedMsg.delete(k);
        else collapsedMsg.add(k);
        renderPickerTree();
        return;
      }
      const ecuNode = e.target.closest(".tree-ecu");
      if (ecuNode?.dataset.ecu) {
        const name = ecuNode.dataset.ecu;
        if (collapsedEcu.has(name)) collapsedEcu.delete(name);
        else collapsedEcu.add(name);
        renderPickerTree();
      }
    });
    el.addEventListener("change", (e) => {
      const cb = e.target;
      if (cb instanceof HTMLInputElement && cb.type === "checkbox" && cb.dataset.key) {
        toggleSignal(cb.dataset.key, cb.checked);
      }
    });
  }

  function toggleSignal(key, on) {
    if (on) {
      if (!selectedOrder.includes(key)) selectedOrder.push(key);
      expandPathForKey(key);
      addView(key);
    } else {
      selectedOrder = selectedOrder.filter((k) => k !== key);
      removeView(key);
    }
    renderPickerTree();
    renderViews();
    if (selectedOrder.length && session?.has_log) {
      refreshCharts();
    } else {
      renderSelectedList();
      scheduleStatsPanelRefresh();
    }
    scheduleWorkspaceSave();
  }

  function addView(key) {
    if (views.some((v) => v.key === key)) return;
    const meta = findSignalMeta(key);
    views.push({
      id: `v${nextViewId++}`,
      key,
      label: `${meta.ecu} / ${meta.msg} / ${meta.name}`,
      title: meta.unit ? `${meta.name} (${meta.unit})` : meta.name,
      heightPx: globalChartH,
      yMin: null,
      yMax: null,
      cursor: null,
      plot: null,
    });
    if (!activeViewId) activeViewId = views[views.length - 1].id;
  }

  function removeView(key) {
    const v = views.find((x) => x.key === key);
    if (v?.plot) {
      v.plot.destroy();
      v.plot = null;
    }
    views = views.filter((x) => x.key !== key);
    statsCache.delete(key);
    if (activeViewId && !views.find((v) => v.id === activeViewId)) {
      activeViewId = views[0]?.id || null;
    }
  }

  function renderViews() {
    const area = $("views-area");
    const ruler = $("time-ruler");
    if (!area.dataset.rulerObserved && typeof ResizeObserver === "function") {
      area.dataset.rulerObserved = "1";
      new ResizeObserver(() => scheduleTimeRuler()).observe(area);
    }
    if (!views.length) {
      area.innerHTML = '<div class="empty">\u4ece\u4fe1\u53f7\u5e93\u52fe\u9009\u4fe1\u53f7</div>';
      if (ruler) area.appendChild(ruler);
      scheduleTimeRuler();
      return;
    }

    let html = "";
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const meta = findSignalMeta(v.key);
      const color = signalColor(v.key);
      const path = [meta.ecu, meta.msg].filter(Boolean).join(" / ");
      const cycle = fmtCycle(meta.cycle_time);
      const cycleHtml = meta.calc
        ? ""
        : cycle
          ? `<span class="vh-cycle" title="DBC GenMsgCycleTime">${esc(cycle)}</span>`
          : `<span class="vh-cycle none" title="DBC \u672a\u5b9a\u4e49 GenMsgCycleTime">\u5468\u671f \u2014</span>`;
      html += `
        <div class="view-panel" data-vid="${v.id}" data-key="${attrEsc(v.key)}">
          <div class="view-header">
            <span class="vh-swatch" style="background:${color}"></span>
            <span class="vh-name">${esc(meta.name || v.title)}</span>
            ${path ? `<span class="vh-path">${esc(path)}</span>` : ""}
            ${cycleHtml}
          </div>
          <div class="view-chart-wrap" style="height:${v.heightPx}px">
            <div class="view-chart" id="chart-${v.id}"></div>
          </div>
          <div class="chart-resize" data-vid="${v.id}" title="\u62d6\u62fd\u8c03\u6574\u9ad8\u5ea6"></div>
        </div>`;
    }
    area.innerHTML = html;
    if (ruler) area.appendChild(ruler);

    area.querySelectorAll(".view-panel").forEach((panel) => {
      panel.addEventListener("mouseenter", () => {
        activeViewId = panel.dataset.vid;
        syncActiveHighlight();
      });
    });

    area.querySelectorAll(".chart-resize").forEach((handle) => {
      bindChartResize(handle);
    });
    syncActiveHighlight();
  }

  function bindChartResize(handle) {
    let startY = 0;
    let startH = 0;
    let vid = null;

    const onMove = (e) => {
      const view = getView(vid);
      if (!view) return;
      const dy = e.clientY - startY;
      const h = clampChartH(startH + dy);
      applyGlobalChartHeight(h, { redraw: true });
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      vid = handle.dataset.vid;
      const view = getView(vid);
      if (!view) return;
      startY = e.clientY;
      startH = view.heightPx;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function bindSidebarResize() {
    const handle = $("sidebarResize");
    const sidebar = $("sidebar");
    if (!handle || !sidebar) return;

    let startX = 0;
    let startW = 0;

    const onMove = (e) => {
      const w = Math.min(520, Math.max(200, startW + (e.clientX - startX)));
      sidebar.style.width = `${w}px`;
      scheduleWorkspaceSave();
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function getView(vid) {
    return views.find((v) => v.id === vid);
  }

  function getActiveView() {
    return getView(activeViewId) || views[0] || null;
  }

  function syncGlobalX() {
    views.forEach((v) => {
      v.xMin = viewStart;
      v.xMax = viewEnd;
    });
  }

  function fitViewYToCurrentWindow(view) {
    const ser = seriesCache.get(view.key);
    if (!ser?.timestamps?.length) return;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let i = 0; i < ser.timestamps.length; i++) {
      const t = ser.timestamps[i];
      if (t < viewStart || t > viewEnd) continue;
      const y = ser.values[i];
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) return;
    const pad = (ymax - ymin) * 0.025 || 0.5;
    view.yMin = ymin - pad;
    view.yMax = ymax + pad;
  }

  function fitViewXToData(view) {
    const ser = seriesCache.get(view.key);
    if (!ser?.timestamps?.length) return false;
    viewStart = ser.timestamps[0];
    viewEnd = ser.timestamps[ser.timestamps.length - 1];
    if (viewEnd - viewStart < 0.001) viewEnd = viewStart + 0.001;
    syncGlobalX();
    return true;
  }

  function fitCurrentAxis(mode) {
    const view = getActiveView();
    if (!view) return;
    if (mode === "x" || mode === "xy") {
      fitViewXToData(view);
    }
    if (mode === "y" || mode === "xy") {
      fitViewYToCurrentWindow(view);
    }
    drawView(view);
    if (mode === "x" || mode === "xy") refreshCharts();
    else scheduleWorkspaceSave();
    updateTopBar();
  }

  function overviewAllXY() {
    if (!session?.has_log) return;
    viewStart = session.t_start;
    viewEnd = session.t_end;
    syncGlobalX();
    views.forEach((v) => {
      v.yMin = null;
      v.yMax = null;
    });
    refreshCharts();
    updateTopBar();
  }

  function applyZoomGlobalX(u, clientX, factor) {
    const rect = u.over.getBoundingClientRect();
    const left = clientX - rect.left;
    const xVal = u.posToVal(left, "x");
    const base = session.t_start;
    let xmin = viewStart - base;
    let xmax = viewEnd - base;
    const xr = xmax - xmin || 1;
    const nxr = xr * factor;
    const newMin = xVal - ((xVal - xmin) / xr) * nxr;
    viewStart = newMin + base;
    viewEnd = viewStart + nxr;
    if (viewEnd - viewStart < 0.001) viewEnd = viewStart + 0.001;
    syncGlobalX();
    clearTimeout(xZoomRefreshTimer);
    xZoomRefreshTimer = setTimeout(() => {
      refreshCharts();
      updateTopBar();
    }, 64);
  }

  function applyZoomViewY(view, u, clientY, factor) {
    const rect = u.over.getBoundingClientRect();
    const yVal = u.posToVal(clientY - rect.top, "y");
    let ymin = view.yMin ?? 0;
    let ymax = view.yMax ?? 1;
    const yr = ymax - ymin || 1;
    const nyr = yr * factor;
    view.yMin = yVal - ((yVal - ymin) / yr) * nyr;
    view.yMax = view.yMin + nyr;
    drawView(view);
  }

  function zoomGlobalX(u, view, e) {
    const factor = e.deltaY > 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP;
    applyZoomGlobalX(u, e.clientX, factor);
  }

  function zoomViewY(view, u, e) {
    const factor = e.deltaY > 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP;
    applyZoomViewY(view, u, e.clientY, factor);
  }

  function applyPinchZoomX(u, midClientX, totalRatio, anchor) {
    const z = Math.pow(Math.max(0.05, totalRatio), PINCH_POWER);
    const dur0 = anchor.viewEnd - anchor.viewStart;
    const dur = Math.max(0.001, dur0 / z);
    const focal = anchor.focalT;
    const rel = dur0 > 0 ? (focal - anchor.viewStart) / dur0 : 0.5;
    viewStart = focal - dur * rel;
    viewEnd = viewStart + dur;
    if (viewEnd - viewStart < 0.001) viewEnd = viewStart + 0.001;
    syncGlobalX();
    clearTimeout(xZoomRefreshTimer);
    xZoomRefreshTimer = setTimeout(() => {
      refreshCharts();
      updateTopBar();
    }, 80);
  }

  function applyPinchZoomY(view, u, midClientY, totalRatio, anchor) {
    const z = Math.pow(Math.max(0.05, totalRatio), PINCH_POWER);
    const ymin0 = anchor.yMin;
    const ymax0 = anchor.yMax;
    const yr0 = ymax0 - ymin0 || 1;
    const yr = Math.max(yr0 * 0.0001, yr0 / z);
    const rect = u.over.getBoundingClientRect();
    const yVal = u.posToVal(midClientY - rect.top, "y");
    const rel = (yVal - ymin0) / yr0;
    view.yMin = yVal - yr * rel;
    view.yMax = view.yMin + yr;
    drawView(view);
  }

  function bindChartPointerZoom(over, view, u) {
    const pointers = new Map();
    let pinchAnchor = null;
    let yZoomMode = false;

    const pinchDist = () => {
      const pts = [...pointers.values()];
      if (pts.length < 2) return null;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    const pinchMid = () => {
      const pts = [...pointers.values()];
      return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    };

    const resetPinchAnchor = () => {
      const dist = pinchDist();
      if (dist == null || dist < 12) return;
      const mid = pinchMid();
      const rect = u.over.getBoundingClientRect();
      const relX = u.posToVal(mid.x - rect.left, "x");
      const base = session.t_start;
      const focalT = relX + base;
      if (yZoomMode) {
        pinchAnchor = {
          startDist: dist,
          yMin: view.yMin ?? 0,
          yMax: view.yMax ?? 1,
          mode: "y",
        };
      } else {
        pinchAnchor = {
          startDist: dist,
          viewStart,
          viewEnd,
          focalT,
          mode: "x",
        };
      }
    };

    const onDown = (e) => {
      if (e.pointerType === "mouse") return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      yZoomMode = e.altKey || e.shiftKey;
      if (pointers.size >= 2) {
        resetPinchAnchor();
      } else {
        pinchAnchor = null;
      }
      try {
        over.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      yZoomMode = yZoomMode || e.altKey || e.shiftKey;
      if (pointers.size < 2) return;
      e.preventDefault();
      const dist = pinchDist();
      if (dist == null || dist < 12) return;
      if (!pinchAnchor) resetPinchAnchor();
      if (!pinchAnchor || pinchAnchor.startDist <= 0) return;
      const mid = pinchMid();
      const totalRatio = dist / pinchAnchor.startDist;
      over.dataset.pinchMoved = "1";
      if (pinchAnchor.mode === "y") {
        applyPinchZoomY(view, u, mid.y, totalRatio, pinchAnchor);
      } else {
        applyPinchZoomX(u, mid.x, totalRatio, pinchAnchor);
      }
    };

    const onUp = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        pinchAnchor = null;
        clearTimeout(xZoomRefreshTimer);
        if (session?.has_log && selectedOrder.length) refreshCharts();
      }
      try {
        over.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    over.addEventListener("pointerdown", onDown);
    over.addEventListener("pointermove", onMove, { passive: false });
    over.addEventListener("pointerup", onUp);
    over.addEventListener("pointercancel", onUp);
  }

  function toggleDataPoints() {
    showDataPoints = !showDataPoints;
    $("btnTogglePoints")?.classList.toggle("active", showDataPoints);
    views.forEach((v) => drawView(v));
    scheduleWorkspaceSave();
  }

  async function refreshCharts() {
    if (!selectedOrder.length) {
      renderSelectedList();
      return;
    }
    if (!session?.has_log) {
      renderSelectedList();
      return;
    }
    try {
      const { series } = await api("/api/signals/viewport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keys: selectedOrder,
          t_start: viewStart,
          t_end: viewEnd,
          max_points: 4000,
        }),
      });
      series.forEach((s) => seriesCache.set(s.key, s));
      await refreshStats();
      renderSelectedList();
      views.forEach((v) => drawView(v));
      updateTopBar();
      scheduleStatsPanelRefresh();
      scheduleWorkspaceSave();
      showErr("");
    } catch (err) {
      showErr(err.message);
    }
  }

  function nearestPoint(ser, tAbs) {
    const ts = ser.timestamps;
    if (!ts.length) return null;
    let lo = 0;
    let hi = ts.length - 1;
    if (tAbs <= ts[0]) return { t: ts[0], v: ser.values[0] };
    if (tAbs >= ts[hi]) return { t: ts[hi], v: ser.values[hi] };
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < tAbs) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo > 0 && Math.abs(ts[lo - 1] - tAbs) <= Math.abs(ts[lo] - tAbs) ? lo - 1 : lo;
    return { t: ts[idx], v: ser.values[idx] };
  }

  function drawValueOnYAxis(ctx, u, val, unit, color) {
    const py = u.valToPos(val, "y", true);
    if (!Number.isFinite(py)) return;
    const plotLeft = u.bbox.left;
    const plotTop = u.bbox.top;
    const plotH = u.bbox.height;
    if (py < plotTop || py > plotTop + plotH) return;
    const txt = `${fmtNum(val)}${unit ? " " + unit : ""}`;
    ctx.save();
    ctx.font = "11px Segoe UI, sans-serif";
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(plotLeft - tw - 8, py - 7, tw + 6, 14);
    ctx.fillStyle = color || CHART.cursor;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(txt, plotLeft - 4, py);
    ctx.restore();
  }

  function hideHoverTip() {
    const tip = $("chartHoverTip");
    if (tip) tip.classList.remove("visible");
    hideRulerHover();
  }

  // ---- shared time ruler (replaces per-chart X axis so every chart keeps full height) ----

  const RULER_STEPS = [
    0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
    3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800,
  ];
  const RULER_EDGE_PX = 36;
  let rulerFrame = 0;
  let rulerScale = null;

  function scheduleTimeRuler() {
    if (rulerFrame) return;
    rulerFrame = requestAnimationFrame(() => {
      rulerFrame = 0;
      renderTimeRuler();
    });
  }

  function buildRulerTicks(t0, t1, widthPx) {
    const span = t1 - t0;
    if (!(span > 0) || widthPx < 20) return [];
    const minStep = (span * xAxisTickSpace(null, 0, t0, t1, widthPx)) / widthPx;
    const step = RULER_STEPS.find((s) => s >= minStep) ?? Math.ceil(minStep / 86400) * 86400;
    // Wall time: align ticks to local clock; relative time: align to log start.
    const shift = hasWallTime()
      ? -new Date(t0 * 1000).getTimezoneOffset() * 60
      : -(session?.t_start || 0);
    const first = Math.ceil((t0 + shift) / step - 1e-9);
    const ticks = [];
    for (let k = first; ; k++) {
      const t = k * step - shift;
      if (t > t1 + step * 1e-9) break;
      ticks.push(t);
    }
    return ticks;
  }

  function renderTimeRuler() {
    const ruler = $("time-ruler");
    const track = $("timeRulerTrack");
    const ticksEl = $("timeRulerTicks");
    if (!ruler || !track || !ticksEl) return;
    const host = views.find((v) => v.plot?.over?.isConnected);
    const t0 = viewStart;
    const t1 = viewEnd;
    if (!host || !(t1 > t0)) {
      ruler.classList.add("hidden");
      rulerScale = null;
      return;
    }
    ruler.classList.remove("hidden");
    const over = host.plot.over.getBoundingClientRect();
    const width = over.width;
    track.style.left = `${over.left - ruler.getBoundingClientRect().left - 1}px`;
    track.style.width = `${width}px`;
    const span = t1 - t0;
    rulerScale = { t0, span, width };
    const toX = (t) => (((t - t0) / span) * width).toFixed(1);

    let html = "";
    for (const t of buildRulerTicks(t0, t1, width)) {
      const x = Number(toX(t));
      const edge = x < RULER_EDGE_PX ? " edge-l" : x > width - RULER_EDGE_PX ? " edge-r" : "";
      html += `<span class="tr-tick${edge}" style="left:${x}px">${esc(fmtAxisTime(t, span))}</span>`;
    }
    for (const [t, cls] of [[cursorTime, "a"], [measureB, "b"]]) {
      if (t != null && t >= t0 && t <= t1) {
        html += `<span class="tr-mark ${cls}" style="left:${toX(t)}px"></span>`;
      }
    }
    ticksEl.innerHTML = html;
  }

  function showRulerHover(t) {
    const el = $("timeRulerHover");
    if (!el || !rulerScale) return;
    const { t0, span, width } = rulerScale;
    if (t < t0 || t > t0 + span) {
      el.style.display = "none";
      return;
    }
    const x = ((t - t0) / span) * width;
    el.textContent = fmtDetailTime(t);
    el.style.left = `${x}px`;
    el.classList.toggle("edge-l", x < RULER_EDGE_PX * 1.5);
    el.classList.toggle("edge-r", x > width - RULER_EDGE_PX * 1.5);
    el.style.display = "block";
  }

  function hideRulerHover() {
    const el = $("timeRulerHover");
    if (el) el.style.display = "none";
  }

  function showHoverTip(clientX, clientY, html) {
    const tip = $("chartHoverTip");
    if (!tip) return;
    tip.innerHTML = html;
    tip.classList.add("visible");
    const pad = 12;
    let left = clientX + pad;
    let top = clientY + pad;
    const tw = tip.offsetWidth || 120;
    const th = tip.offsetHeight || 40;
    if (left + tw > window.innerWidth - 8) left = clientX - tw - pad;
    if (top + th > window.innerHeight - 8) top = clientY - th - pad;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }

  function drawCursorLine(ctx, u, tAbs, base, style) {
    const px = u.valToPos(tAbs - base, "x", true);
    if (!Number.isFinite(px)) return null;
    const plotTop = u.bbox.top;
    const plotBottom = plotTop + u.bbox.height;
    ctx.save();
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width || 1.25;
    ctx.setLineDash(style.dash || [4, 4]);
    ctx.beginPath();
    ctx.moveTo(px, plotTop);
    ctx.lineTo(px, plotBottom);
    ctx.stroke();
    if (style.label) {
      ctx.setLineDash([]);
      ctx.font = "10px Segoe UI, sans-serif";
      ctx.fillStyle = style.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(style.label, px, plotTop + 2);
    }
    ctx.restore();
    return px;
  }

  function drawView(view) {
    const host = $(`chart-${view.id}`);
    if (!host) return;
    const ser = seriesCache.get(view.key);
    if (!ser?.timestamps?.length) {
      host.innerHTML = '<span class="meta" style="padding:8px">\u65e0\u6570\u636e</span>';
      return;
    }

    const base = session.t_start;
    const xMin = viewStart;
    const xMax = viewEnd;
    const relTs = [];
    const relVs = [];
    for (let i = 0; i < ser.timestamps.length; i++) {
      const t = ser.timestamps[i];
      if (t >= xMin && t <= xMax) {
        relTs.push(t - base);
        relVs.push(ser.values[i]);
      }
    }
    if (!relTs.length) {
      host.innerHTML = '<span class="meta" style="padding:8px">\u89c6\u53e3\u65e0\u6570\u636e</span>';
      return;
    }

    let yMin = view.yMin;
    let yMax = view.yMax;
    if (yMin == null || yMax == null) {
      yMin = Math.min(...relVs);
      yMax = Math.max(...relVs);
      const pad = (yMax - yMin) * 0.025 || 0.5;
      yMin -= pad;
      yMax += pad;
      view.yMin = yMin;
      view.yMax = yMax;
    }

    const meta = findSignalMeta(view.key);
    const color = signalColor(view.key);
    const c =
      view.cursor ||
      (cursorTime != null ? nearestPoint(ser, cursorTime) : null);

    if (view.plot) {
      view.plot.destroy();
      view.plot = null;
    }
    host.innerHTML = "";

    const wrap = host.parentElement;
    const h = view.heightPx || DEFAULT_CHART_H;
    if (wrap) wrap.style.height = `${h}px`;
    const plotH = Math.max(40, (wrap?.clientHeight || h) - 1);
    const w = Math.max(200, wrap?.clientWidth || host.clientWidth || 200);
    let internalScaleSync = true;
    view.plot = new uPlot(
      {
        width: w,
        height: plotH,
        padding: [2, 4, 2, 40],
        pxAlign: 1,
        legend: { show: false },
        cursor: {
          show: true,
          x: true,
          y: true,
          points: { show: false },
        },
        series: [
          {},
          {
            stroke: color,
            width: 1.5,
            points: { show: showDataPoints, size: 3, stroke: color, fill: "#ffffff" },
          },
        ],
        scales: {
          x: { time: false, min: xMin - base, max: xMax - base },
          y: { min: yMin, max: yMax },
        },
        axes: [
          { show: false },
          {
            stroke: CHART.axis,
            grid: { stroke: CHART.grid },
            size: 42,
            font: "10px Segoe UI, sans-serif",
            gap: 2,
          },
        ],
        hooks: {
          setScale: [
            (u, key) => {
              if (internalScaleSync) return;
              if (key === "x") {
                const min = u.scales.x.min;
                const max = u.scales.x.max;
                if (Number.isFinite(min) && Number.isFinite(max)) {
                  viewStart = min + base;
                  viewEnd = max + base;
                  syncGlobalX();
                  updateTopBar();
                  clearTimeout(xZoomRefreshTimer);
                  xZoomRefreshTimer = setTimeout(() => refreshCharts(), 64);
                }
              } else if (key === "y") {
                const min = u.scales.y.min;
                const max = u.scales.y.max;
                if (Number.isFinite(min) && Number.isFinite(max)) {
                  view.yMin = min;
                  view.yMax = max;
                  scheduleWorkspaceSave();
                }
              }
            },
          ],
          draw: [
            (u) => {
              const ctx = u.ctx;
              const plotTop = u.bbox.top;
              const plotHpx = u.bbox.height;

              if (cursorTime != null && measureB != null) {
                const xa = u.valToPos(cursorTime - base, "x", true);
                const xb = u.valToPos(measureB - base, "x", true);
                if (Number.isFinite(xa) && Number.isFinite(xb)) {
                  const left = Math.min(xa, xb);
                  const right = Math.max(xa, xb);
                  ctx.save();
                  ctx.fillStyle = "rgba(130, 80, 223, 0.08)";
                  ctx.fillRect(left, plotTop, right - left, plotHpx);
                  ctx.restore();
                }
              }

              if (cursorTime != null) {
                drawCursorLine(ctx, u, cursorTime, base, {
                  color: CHART.cursor,
                  dash: [4, 3],
                  label: "A",
                });
              }
              if (measureB != null) {
                drawCursorLine(ctx, u, measureB, base, {
                  color: CHART.measure,
                  dash: [2, 3],
                  label: "B",
                  width: 1.25,
                });
              }

              if (c) {
                drawValueOnYAxis(ctx, u, c.v, meta.unit, color);
              }
              scheduleTimeRuler();
            },
          ],
          ready: [
            (u) => {
              internalScaleSync = false;
              const over = u.over;
              over.addEventListener(
                "wheel",
                (e) => {
                  e.preventDefault();
                  if (e.altKey || e.shiftKey) {
                    zoomViewY(view, u, e);
                  } else {
                    zoomGlobalX(u, view, e);
                  }
                },
                { passive: false }
              );
              bindChartPointerZoom(over, view, u);
              over.addEventListener("click", (e) => {
                if (over.dataset.pinchMoved === "1") {
                  over.dataset.pinchMoved = "";
                  return;
                }
                onChartClick(view, u, ser, base, e);
              });
              over.addEventListener("mousemove", (e) => {
                onChartHover(view, u, ser, base, e);
              });
              over.addEventListener("mouseleave", () => hideHoverTip());
            },
          ],
        },
      },
      [relTs, relVs],
      host
    );
  }

  function onChartHover(view, u, ser, base, e) {
    const rect = u.over.getBoundingClientRect();
    const relX = u.posToVal(e.clientX - rect.left, "x");
    const tAbs = relX + base;
    const pt = nearestPoint(ser, tAbs);
    if (!pt) {
      hideHoverTip();
      return;
    }
    const meta = findSignalMeta(view.key);
    const choices = ser.choices || meta.choices;
    const label = choiceLabel(choices, pt.v);
    const yTxt = label || `${fmtNum(pt.v)}${meta.unit ? " " + meta.unit : ""}`;
    showRulerHover(pt.t);
    showHoverTip(
      e.clientX,
      e.clientY,
      `<div>X: ${esc(fmtDetailTime(pt.t))}</div><div class="tip-y">Y: ${esc(yTxt)}</div>`
    );
  }

  async function onChartClick(view, u, ser, base, e) {
    const relX = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, "x");
    const tAbs = relX + base;
    const pt = nearestPoint(ser, tAbs);
    if (!pt) return;

    if (measureMode) {
      if (cursorTime == null) {
        cursorTime = pt.t;
      } else if (measureB == null) {
        measureB = pt.t;
      } else {
        // Move the nearer cursor
        if (Math.abs(pt.t - cursorTime) <= Math.abs(pt.t - measureB)) {
          cursorTime = pt.t;
        } else {
          measureB = pt.t;
        }
      }
    } else {
      cursorTime = pt.t;
    }

    activeViewId = view.id;
    views.forEach((v) => {
      const s = seriesCache.get(v.key);
      if (!s) return;
      const p = nearestPoint(s, cursorTime);
      v.cursor = p ? { t: p.t, v: p.v } : null;
    });
    await refreshStats();
    renderSelectedList();
    views.forEach((v) => drawView(v));
    syncActiveHighlight();
    revealSelectedItem(view.key);
    updateTopBar();
    scheduleStatsPanelRefresh();
    scheduleWorkspaceSave();
  }

  function clearCursor() {
    cursorTime = null;
    measureB = null;
    views.forEach((v) => {
      v.cursor = null;
    });
    hideHoverTip();
    refreshStats().then(() => {
      renderSelectedList();
      views.forEach((v) => drawView(v));
      updateTopBar();
      scheduleStatsPanelRefresh();
      scheduleWorkspaceSave();
    });
  }

  function toggleMeasureMode() {
    measureMode = !measureMode;
    $("btnMeasure")?.classList.toggle("active", measureMode);
    updateTopBar();
    scheduleWorkspaceSave();
  }

  async function refreshSession(resetView = true) {
    session = await api("/api/session");
    if (Array.isArray(session.dbcs)) dbcList = session.dbcs;
    renderDbcSelect();
    if (session.has_log && resetView) {
      viewStart = session.t_start;
      viewEnd = session.t_end;
      cursorTime = null;
      measureB = null;
      syncGlobalX();
    }
    const meta = $("meta");
    if (meta) {
      meta.textContent = [
        session.log && `\u65e5\u5fd7: ${session.log} (${session.frame_count}\u5e27, ${session.duration.toFixed(2)}s)`,
        session.has_wall_time && session.log_start_text
          ? `\u8d77\u59cb: ${session.log_start_text} (\u672c\u5730\u65f6\u533a)`
          : null,
        session.dbc && `DBC: ${session.dbc}`,
        dbcList.length > 1 ? `(${dbcList.length}\u4e2a\u914d\u7f6e)` : "",
      ]
        .filter(Boolean)
        .join(" | ");
    }
    updateTopBar();
  }

  function renderDbcSelect() {
    const sel = $("dbcSelect");
    if (!sel) return;
    const active = session?.active_dbc_id || dbcList.find((d) => d.active)?.id || "";
    if (!dbcList.length) {
      sel.innerHTML = '<option value="">\u672a\u5bfc\u5165</option>';
      sel.value = "";
      return;
    }
    sel.innerHTML = dbcList
      .map(
        (d) =>
          `<option value="${attrEsc(d.id)}"${d.id === active ? " selected" : ""}>${esc(d.name)}${
            d.message_count != null ? ` (${d.message_count})` : ""
          }</option>`
      )
      .join("");
    if (active) sel.value = active;
  }

  async function applyDbcPayload(r) {
    if (Array.isArray(r.dbcs)) dbcList = r.dbcs;
    ecus = normalizeEcus(r);
    collapseAllTree();
    await refreshSession(false);
    renderDbcSelect();
    renderPickerTree();
    seriesCache.clear();
    statsCache.clear();
    if (selectedOrder.length && session?.has_log) {
      await refreshCharts();
    } else {
      renderSelectedList();
      renderViews();
    }
    $("picker-panel")?.classList.add("open");
    $("btnPicker")?.classList.add("open");
    scheduleWorkspaceSave();
  }

  $("logFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showErr("");
    const fd = new FormData();
    fd.append("file", f);
    try {
      await api("/api/log", { method: "POST", body: fd });
      await refreshSession();
      seriesCache.clear();
      statsCache.clear();
      if (session?.has_log) {
        viewStart = session.t_start;
        viewEnd = session.t_end;
        cursorTime = null;
        measureB = null;
      }
      for (const key of selectedOrder) addView(key);
      reorderViews();
      renderPickerTree();
      renderSelectedList();
      renderViews();
      if (selectedOrder.length && session?.has_log) {
        await refreshCharts();
      } else {
        updateTopBar();
      }
      scheduleWorkspaceSave();
    } catch (err) {
      showErr(err.message);
    }
    e.target.value = "";
  };

  $("dbcFile").onchange = async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    showErr("");
    try {
      let r;
      if (files.length === 1) {
        const fd = new FormData();
        fd.append("file", files[0]);
        r = await api("/api/dbc", { method: "POST", body: fd });
      } else {
        const fd = new FormData();
        for (const f of files) fd.append("files", f);
        r = await api("/api/dbc/batch", { method: "POST", body: fd });
      }
      await applyDbcPayload(r);
    } catch (err) {
      showErr(err.message);
    }
    e.target.value = "";
  };

  $("dbcSelect")?.addEventListener("change", async (e) => {
    const id = e.target.value;
    if (!id) return;
    showErr("");
    try {
      const r = await api("/api/dbc/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await applyDbcPayload(r);
    } catch (err) {
      showErr(err.message);
      renderDbcSelect();
    }
  });

  $("btnRemoveDbc")?.addEventListener("click", async () => {
    const id = session?.active_dbc_id || $("dbcSelect")?.value;
    if (!id) {
      showErr("当前没有可移除的 DBC");
      return;
    }
    showErr("");
    try {
      const r = await api(`/api/dbc/${encodeURIComponent(id)}`, { method: "DELETE" });
      await applyDbcPayload(r);
    } catch (err) {
      showErr(err.message);
    }
  });

  const JSON_HEADERS = { "Content-Type": "application/json" };

  function openModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  function newId(prefix) {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Replace the whole selection (used by group loading). */
  function setSelection(keys) {
    views.forEach((v) => v.plot?.destroy());
    views = [];
    activeViewId = null;
    statsCache.clear();
    selectedOrder = [];
    for (const k of keys) {
      if (selectedOrder.includes(k)) continue;
      selectedOrder.push(k);
      addView(k);
      if (!isCalcKey(k)) expandPathForKey(k);
    }
    renderPickerTree();
    renderViews();
    if (selectedOrder.length && session?.has_log) refreshCharts();
    else renderSelectedList();
    scheduleStatsPanelRefresh();
    scheduleWorkspaceSave();
  }

  // ---- signal groups ----

  async function loadGroups() {
    try {
      const r = await api("/api/groups");
      groups = Array.isArray(r.groups) ? r.groups : [];
    } catch {
      groups = [];
    }
  }

  async function saveGroups(next) {
    const r = await api("/api/groups", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ groups: next }),
    });
    groups = r.groups || [];
    if (activeGroupId && !groups.some((g) => g.id === activeGroupId)) activeGroupId = null;
    renderGroupSelect();
    renderGroupManageList();
    scheduleWorkspaceSave();
  }

  function renderGroupSelect() {
    const sel = $("groupSelect");
    if (!sel) return;
    sel.innerHTML =
      `<option value="">\u2014 \u4fe1\u53f7\u7ec4 (${groups.length}) \u2014</option>` +
      groups
        .map((g) => `<option value="${attrEsc(g.id)}">${esc(g.name)} (${g.keys.length})</option>`)
        .join("");
    sel.value = groups.some((g) => g.id === activeGroupId) ? activeGroupId : "";
  }

  function applyGroup(groupId, mode) {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    const known = allSignalKeySet();
    const usable = g.keys.filter((k) => known.has(k));
    const missing = g.keys.length - usable.length;
    const keys =
      mode === "append"
        ? [...selectedOrder, ...usable.filter((k) => !selectedOrder.includes(k))]
        : usable;
    activeGroupId = g.id;
    setSelection(keys);
    renderGroupSelect();
    const verb = mode === "append" ? "\u8ffd\u52a0" : "\u8f7d\u5165";
    showToast(
      missing
        ? `\u5df2${verb}\u300c${g.name}\u300d\uff0c${missing} \u4e2a\u4fe1\u53f7\u5728\u5f53\u524d DBC \u4e2d\u4e0d\u5b58\u5728\uff0c\u5df2\u8df3\u8fc7`
        : `\u5df2${verb}\u300c${g.name}\u300d\uff08${usable.length} \u4e2a\u4fe1\u53f7\uff09`
    );
  }

  async function saveCurrentAsGroup() {
    if (!selectedOrder.length) {
      showToast("\u8bf7\u5148\u52fe\u9009\u4fe1\u53f7");
      return;
    }
    const current = groups.find((g) => g.id === activeGroupId);
    const name = (prompt("\u4fe1\u53f7\u7ec4\u540d\u79f0", current?.name || "") || "").trim();
    if (!name) return;
    const existing = groups.find((g) => g.name === name);
    if (
      existing &&
      !confirm(`\u4fe1\u53f7\u7ec4\u300c${name}\u300d\u5df2\u5b58\u5728\uff0c\u662f\u5426\u7528\u5f53\u524d\u5df2\u9009\u4fe1\u53f7\u8986\u76d6\uff1f`)
    ) {
      return;
    }
    const g = existing
      ? { ...existing, keys: [...selectedOrder] }
      : { id: newId("g_"), name, keys: [...selectedOrder], created_at: new Date().toISOString() };
    const next = existing ? groups.map((x) => (x.id === g.id ? g : x)) : [...groups, g];
    try {
      await saveGroups(next);
      activeGroupId = g.id;
      renderGroupSelect();
      showToast(`\u5df2\u4fdd\u5b58\u4fe1\u53f7\u7ec4\u300c${name}\u300d\uff08${g.keys.length} \u4e2a\u4fe1\u53f7\uff09`);
    } catch (err) {
      showErr(err.message);
    }
  }

  function renderGroupManageList() {
    const el = $("groupManageList");
    if (!el) return;
    if (!groups.length) {
      el.innerHTML = '<div class="empty">\u8fd8\u6ca1\u6709\u4fe1\u53f7\u7ec4\uff0c\u5148\u5728\u5df2\u9009\u4fe1\u53f7\u680f\u70b9\u300c\u4fdd\u5b58\u4e3a\u7ec4\u300d</div>';
      return;
    }
    el.innerHTML = groups
      .map((g, i) => {
        const names = g.keys.map((k) => findSignalMeta(k).name).join("\n");
        return `<div class="grp-row${g.id === activeGroupId ? " active" : ""}" data-id="${attrEsc(g.id)}">
          <input class="grp-name" value="${attrEsc(g.name)}" title="\u4fee\u6539\u540e\u56de\u8f66\u6216\u79fb\u51fa\u5373\u4fdd\u5b58" />
          <span class="grp-count" title="${attrEsc(names)}">${g.keys.length} \u4e2a\u4fe1\u53f7</span>
          <button type="button" class="btn sm" data-act="replace">\u8f7d\u5165</button>
          <button type="button" class="btn sm btn-ghost" data-act="append">\u8ffd\u52a0</button>
          <button type="button" class="btn sm btn-ghost" data-act="update" title="\u7528\u5f53\u524d\u5df2\u9009\u4fe1\u53f7\u8986\u76d6\u8be5\u7ec4">\u66f4\u65b0</button>
          <button type="button" class="btn sm btn-ghost" data-act="up" ${i === 0 ? "disabled" : ""}>\u2191</button>
          <button type="button" class="btn sm btn-ghost" data-act="down" ${i === groups.length - 1 ? "disabled" : ""}>\u2193</button>
          <button type="button" class="btn sm btn-ghost btn-danger" data-act="del">\u5220\u9664</button>
        </div>`;
      })
      .join("");
  }

  async function onGroupManageAction(id, act) {
    const idx = groups.findIndex((g) => g.id === id);
    if (idx < 0) return;
    const g = groups[idx];
    if (act === "replace" || act === "append") {
      applyGroup(id, act);
      renderGroupManageList();
      return;
    }
    let next = [...groups];
    if (act === "update") {
      if (!selectedOrder.length) {
        showToast("\u5f53\u524d\u6ca1\u6709\u5df2\u9009\u4fe1\u53f7");
        return;
      }
      if (!confirm(`\u7528\u5f53\u524d ${selectedOrder.length} \u4e2a\u5df2\u9009\u4fe1\u53f7\u8986\u76d6\u300c${g.name}\u300d\uff1f`)) return;
      next[idx] = { ...g, keys: [...selectedOrder] };
    } else if (act === "up" && idx > 0) {
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    } else if (act === "down" && idx < next.length - 1) {
      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    } else if (act === "del") {
      if (!confirm(`\u5220\u9664\u4fe1\u53f7\u7ec4\u300c${g.name}\u300d\uff1f`)) return;
      next = next.filter((x) => x.id !== id);
    } else {
      return;
    }
    try {
      await saveGroups(next);
    } catch (err) {
      showErr(err.message);
    }
  }

  async function renameGroup(id, name) {
    const g = groups.find((x) => x.id === id);
    const clean = name.trim();
    if (!g || !clean || clean === g.name) {
      renderGroupManageList();
      return;
    }
    try {
      await saveGroups(groups.map((x) => (x.id === id ? { ...x, name: clean } : x)));
    } catch (err) {
      showErr(err.message);
    }
  }

  function exportGroups() {
    const blob = new Blob([JSON.stringify({ version: 1, groups }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "can-replay-signal-groups.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importGroups(file) {
    try {
      const raw = JSON.parse(await file.text());
      const list = Array.isArray(raw) ? raw : raw?.groups;
      if (!Array.isArray(list)) throw new Error("\u6587\u4ef6\u683c\u5f0f\u4e0d\u6b63\u786e");
      const next = [...groups];
      let added = 0;
      for (const item of list) {
        if (!item || !item.name || !Array.isArray(item.keys)) continue;
        const g = {
          id: String(item.id || newId("g_")),
          name: String(item.name),
          keys: item.keys.map(String),
          created_at: item.created_at || new Date().toISOString(),
        };
        const at = next.findIndex((x) => x.id === g.id);
        if (at >= 0) next[at] = g;
        else next.push(g);
        added++;
      }
      await saveGroups(next);
      showToast(`\u5df2\u5bfc\u5165 ${added} \u4e2a\u4fe1\u53f7\u7ec4`);
    } catch (err) {
      showErr(`\u5bfc\u5165\u5931\u8d25: ${err.message}`);
    }
  }

  // ---- virtual (calculated) signals ----

  let calcPicked = [];

  async function loadCalcDefs() {
    try {
      const r = await api("/api/calc");
      calcDefs = Array.isArray(r.defs) ? r.defs : [];
      calcFunctions = Array.isArray(r.functions) ? r.functions : [];
    } catch {
      calcDefs = [];
    }
  }

  function calcVarsFromPicked() {
    const vars = {};
    calcPicked.forEach((key, i) => {
      vars[CALC_VARS[i]] = key;
    });
    return vars;
  }

  function calcCandidateKeys() {
    const keys = selectedOrder.filter((k) => !isCalcKey(k));
    for (const k of calcPicked) if (!keys.includes(k)) keys.push(k);
    return keys;
  }

  function renderCalcSignalList() {
    const el = $("calcSignalList");
    if (!el) return;
    const keys = calcCandidateKeys();
    if (!keys.length) {
      el.innerHTML = '<div class="empty">\u5148\u4ece\u4fe1\u53f7\u5e93\u52fe\u9009\u8981\u53c2\u4e0e\u8ba1\u7b97\u7684\u4fe1\u53f7</div>';
      return;
    }
    el.innerHTML = keys
      .map((key) => {
        const meta = findSignalMeta(key);
        const idx = calcPicked.indexOf(key);
        const varName = idx >= 0 ? CALC_VARS[idx] : "";
        return `<label class="calc-sig${idx >= 0 ? " picked" : ""}">
          <input type="checkbox" data-key="${attrEsc(key)}" ${idx >= 0 ? "checked" : ""} />
          <span class="calc-var" data-var="${varName}" title="${varName ? "\u70b9\u51fb\u63d2\u5165\u5230\u8868\u8fbe\u5f0f" : ""}">${varName || "\u00b7"}</span>
          <span class="sig-swatch" style="background:${signalColor(key)}"></span>
          <span class="calc-sig-name">${esc(meta.name)}</span>
          <span class="calc-sig-unit">${esc(meta.unit || "")}</span>
        </label>`;
      })
      .join("");
  }

  function renderCalcFuncChips() {
    const el = $("calcFuncs");
    if (!el) return;
    const names = calcFunctions.length
      ? calcFunctions
      : ["abs", "sqrt", "min", "max", "pow", "round", "diff", "integ", "mavg", "where"];
    el.innerHTML = names
      .map((f) => `<button type="button" class="calc-chip" data-insert="${f}(">${f}</button>`)
      .join("");
  }

  function insertIntoExpr(text) {
    const input = $("calcExpr");
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    input.focus();
    input.setSelectionRange(pos, pos);
  }

  function renderCalcDefList() {
    const el = $("calcDefList");
    if (!el) return;
    if (!calcDefs.length) {
      el.innerHTML = '<div class="empty">\u8fd8\u6ca1\u6709\u865a\u62df\u4fe1\u53f7</div>';
      return;
    }
    el.innerHTML = calcDefs
      .map((d) => {
        const key = `${CALC_PREFIX}${d.id}`;
        const shown = selectedOrder.includes(key);
        const mapping = Object.entries(d.vars)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([v, k]) => `${v}=${findSignalMeta(k).name}`)
          .join("  ");
        return `<div class="calc-def${d.id === calcEditingId ? " editing" : ""}" data-id="${attrEsc(d.id)}">
          <div class="calc-def-main">
            <div><strong>${esc(d.name)}</strong>${d.unit ? ` <span class="meta-inline">[${esc(d.unit)}]</span>` : ""} = <code>${esc(d.expr)}</code></div>
            <div class="meta-inline">${esc(mapping)}</div>
          </div>
          <button type="button" class="btn sm${shown ? "" : " btn-ghost"}" data-act="toggle">${shown ? "\u9690\u85cf" : "\u663e\u793a"}</button>
          <button type="button" class="btn sm btn-ghost" data-act="edit">\u7f16\u8f91</button>
          <button type="button" class="btn sm btn-ghost btn-danger" data-act="del">\u5220\u9664</button>
        </div>`;
      })
      .join("");
  }

  function resetCalcForm() {
    calcEditingId = null;
    calcPicked = [];
    $("calcName").value = "";
    $("calcUnit").value = "";
    $("calcExpr").value = "";
    $("calcPreview").textContent = "";
    $("btnCalcSave").textContent = "\u6dfb\u52a0\u5e76\u663e\u793a";
    renderCalcSignalList();
    renderCalcDefList();
  }

  function openCalcModal() {
    calcPicked = calcPicked.filter((k) => calcCandidateKeys().includes(k));
    renderCalcFuncChips();
    renderCalcSignalList();
    renderCalcDefList();
    openModal("calc-modal");
  }

  function editCalcDef(id) {
    const d = calcDefs.find((x) => x.id === id);
    if (!d) return;
    calcEditingId = d.id;
    calcPicked = Object.entries(d.vars)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, k]) => k);
    $("calcName").value = d.name;
    $("calcUnit").value = d.unit || "";
    $("calcExpr").value = d.expr;
    $("calcPreview").textContent = "";
    $("btnCalcSave").textContent = "\u4fdd\u5b58\u4fee\u6539";
    renderCalcSignalList();
    renderCalcDefList();
  }

  function calcFormDef() {
    return {
      id: calcEditingId || newId("c"),
      name: $("calcName").value.trim(),
      unit: $("calcUnit").value.trim(),
      expr: $("calcExpr").value.trim(),
      vars: calcVarsFromPicked(),
    };
  }

  async function previewCalc() {
    const out = $("calcPreview");
    const def = calcFormDef();
    if (!def.name) def.name = "preview";
    out.classList.remove("err-text");
    out.textContent = "\u6821\u9a8c\u4e2d\u2026";
    try {
      const r = await api("/api/calc/preview", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(def),
      });
      out.textContent = r.count
        ? `\u2714 \u8868\u8fbe\u5f0f\u6709\u6548\uff1a${r.count} \u4e2a\u70b9\uff0c\u8303\u56f4 ${fmtNum(r.min)} ~ ${fmtNum(r.max)}`
        : "\u2714 \u8868\u8fbe\u5f0f\u6709\u6548\uff0c\u4f46\u6ca1\u6709\u7ed3\u679c\u70b9\uff08\u53c2\u4e0e\u4fe1\u53f7\u6ca1\u6709\u91cd\u53e0\u7684\u65f6\u95f4\u6bb5\uff09";
    } catch (err) {
      out.classList.add("err-text");
      out.textContent = `\u2716 ${err.message}`;
    }
  }

  async function putCalcDefs(next) {
    const r = await api("/api/calc", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ defs: next }),
    });
    calcDefs = r.defs || [];
    for (const k of [...seriesCache.keys()]) if (isCalcKey(k)) seriesCache.delete(k);
    for (const k of [...statsCache.keys()]) if (isCalcKey(k)) statsCache.delete(k);
  }

  async function saveCalcDef() {
    const out = $("calcPreview");
    const def = calcFormDef();
    const editing = !!calcEditingId;
    const next = editing
      ? calcDefs.map((d) => (d.id === def.id ? def : d))
      : [...calcDefs, def];
    try {
      await putCalcDefs(next);
    } catch (err) {
      out.classList.add("err-text");
      out.textContent = `\u2716 ${err.message}`;
      return;
    }
    const key = `${CALC_PREFIX}${def.id}`;
    if (!selectedOrder.includes(key)) {
      toggleSignal(key, true);
    } else {
      renderViews();
      refreshCharts();
    }
    showToast(`${editing ? "\u5df2\u66f4\u65b0" : "\u5df2\u6dfb\u52a0"}\u865a\u62df\u4fe1\u53f7\u300c${def.name}\u300d`);
    resetCalcForm();
  }

  async function onCalcDefAction(id, act) {
    const d = calcDefs.find((x) => x.id === id);
    if (!d) return;
    const key = `${CALC_PREFIX}${d.id}`;
    if (act === "edit") {
      editCalcDef(id);
      return;
    }
    if (act === "toggle") {
      toggleSignal(key, !selectedOrder.includes(key));
      renderCalcDefList();
      return;
    }
    if (act === "del") {
      if (!confirm(`\u5220\u9664\u865a\u62df\u4fe1\u53f7\u300c${d.name}\u300d\uff1f`)) return;
      try {
        await putCalcDefs(calcDefs.filter((x) => x.id !== id));
      } catch (err) {
        showErr(err.message);
        return;
      }
      if (selectedOrder.includes(key)) toggleSignal(key, false);
      if (calcEditingId === id) resetCalcForm();
      renderCalcDefList();
    }
  }

  // ---- statistics panel ----

  function applyStatsPanelVisibility() {
    $("stats-panel")?.classList.toggle("hidden", !statsPanelOpen);
    $("btnStats")?.classList.toggle("active", statsPanelOpen);
    document.querySelectorAll('input[name="statsRange"]').forEach((r) => {
      r.checked = r.value === statsRange;
    });
    if (statsPanelOpen) scheduleStatsPanelRefresh();
  }

  function toggleStatsPanel(force) {
    statsPanelOpen = typeof force === "boolean" ? force : !statsPanelOpen;
    applyStatsPanelVisibility();
    scheduleWorkspaceSave();
  }

  function scheduleStatsPanelRefresh() {
    if (!statsPanelOpen) return;
    clearTimeout(statsRefreshTimer);
    statsRefreshTimer = setTimeout(refreshStatsPanel, 120);
  }

  function statsTimeRange() {
    if (statsRange === "ab") {
      if (cursorTime == null || measureB == null) return null;
      return [Math.min(cursorTime, measureB), Math.max(cursorTime, measureB)];
    }
    return [viewStart, viewEnd];
  }

  let lastStatsRows = [];
  const STATS_COLS = [
    ["min", "\u6700\u5c0f"],
    ["max", "\u6700\u5927"],
    ["avg", "\u5e73\u5747"],
    ["std", "\u6807\u51c6\u5dee"],
    ["rms", "RMS"],
    ["first", "\u9996\u503c"],
    ["last", "\u672b\u503c"],
    ["delta", "\u5dee\u503c"],
  ];

  async function refreshStatsPanel() {
    const table = $("statsTable");
    const info = $("statsRangeText");
    if (!table || !statsPanelOpen) return;
    if (!selectedOrder.length || !session?.has_log) {
      table.innerHTML = '<tr><td class="empty">\u6ca1\u6709\u5df2\u9009\u4fe1\u53f7</td></tr>';
      if (info) info.textContent = "";
      lastStatsRows = [];
      return;
    }
    const range = statsTimeRange();
    if (!range) {
      table.innerHTML =
        '<tr><td class="empty">\u8bf7\u5148\u6253\u5f00\u300c\u6807\u5c3a\u300d\uff0c\u5728\u66f2\u7ebf\u4e0a\u653e\u7f6e A\u3001B \u4e24\u4e2a\u6e38\u6807</td></tr>';
      if (info) info.textContent = "";
      lastStatsRows = [];
      return;
    }
    if (info) {
      info.textContent = `${fmtDetailTime(range[0])} \u2192 ${fmtDetailTime(range[1])}\uff08${fmtDelta(range[1] - range[0])}\uff09`;
    }
    try {
      const { stats } = await api("/api/stats/range", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ keys: selectedOrder, t_start: range[0], t_end: range[1] }),
      });
      lastStatsRows = stats;
      let html = `<thead><tr><th>\u4fe1\u53f7</th><th>\u5355\u4f4d</th>${STATS_COLS.map(([, l]) => `<th>${l}</th>`).join("")}<th>\u70b9\u6570</th></tr></thead><tbody>`;
      for (const s of stats) {
        const meta = findSignalMeta(s.key);
        html += `<tr data-key="${attrEsc(s.key)}">
          <td class="st-name"><span class="sig-swatch" style="background:${signalColor(s.key)}"></span>${esc(meta.name || s.name)}</td>
          <td>${esc(s.unit || meta.unit || "")}</td>
          ${STATS_COLS.map(([k]) => `<td class="num">${s.count ? fmtNum(s[k]) : "\u2014"}</td>`).join("")}
          <td class="num">${s.count}</td>
        </tr>`;
      }
      table.innerHTML = `${html}</tbody>`;
    } catch (err) {
      table.innerHTML = `<tr><td class="empty err-text">${esc(err.message)}</td></tr>`;
    }
  }

  async function copyStatsTable() {
    if (!lastStatsRows.length) {
      showToast("\u6ca1\u6709\u53ef\u590d\u5236\u7684\u7edf\u8ba1\u6570\u636e");
      return;
    }
    const header = ["\u4fe1\u53f7", "\u5355\u4f4d", ...STATS_COLS.map(([, l]) => l), "\u70b9\u6570"];
    const lines = [header.join("\t")];
    for (const s of lastStatsRows) {
      const meta = findSignalMeta(s.key);
      lines.push(
        [meta.name || s.name, s.unit || "", ...STATS_COLS.map(([k]) => (s.count ? s[k] : "")), s.count].join("\t")
      );
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showToast("\u7edf\u8ba1\u7ed3\u679c\u5df2\u590d\u5236\uff0c\u53ef\u76f4\u63a5\u7c98\u8d34\u5230 Excel");
  }

  function bindFeaturePanels() {
    $("groupSelect")?.addEventListener("change", (e) => {
      const id = e.target.value;
      if (id) applyGroup(id, "replace");
      else {
        activeGroupId = null;
        scheduleWorkspaceSave();
      }
    });
    $("btnGroupSave")?.addEventListener("click", saveCurrentAsGroup);
    $("btnGroupManage")?.addEventListener("click", () => {
      renderGroupManageList();
      openModal("group-modal");
    });
    $("btnGroupClose")?.addEventListener("click", () => closeModal("group-modal"));
    $("groupBackdrop")?.addEventListener("click", () => closeModal("group-modal"));
    $("btnGroupExport")?.addEventListener("click", exportGroups);
    $("groupImportFile")?.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) importGroups(f);
      e.target.value = "";
    });
    const gl = $("groupManageList");
    gl?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      const row = e.target.closest(".grp-row");
      if (btn && row) onGroupManageAction(row.dataset.id, btn.dataset.act);
    });
    gl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.classList.contains("grp-name")) e.target.blur();
    });
    gl?.addEventListener(
      "blur",
      (e) => {
        if (!e.target.classList?.contains("grp-name")) return;
        const row = e.target.closest(".grp-row");
        if (row) renameGroup(row.dataset.id, e.target.value);
      },
      true
    );

    $("btnCalc")?.addEventListener("click", openCalcModal);
    $("btnCalcClose")?.addEventListener("click", () => closeModal("calc-modal"));
    $("calcBackdrop")?.addEventListener("click", () => closeModal("calc-modal"));
    $("btnCalcPreview")?.addEventListener("click", previewCalc);
    $("btnCalcSave")?.addEventListener("click", saveCalcDef);
    $("btnCalcReset")?.addEventListener("click", resetCalcForm);
    $("calcExpr")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") previewCalc();
    });
    $("calcFuncs")?.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-insert]");
      if (chip) insertIntoExpr(chip.dataset.insert);
    });
    const sl = $("calcSignalList");
    sl?.addEventListener("change", (e) => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || !cb.dataset.key) return;
      if (cb.checked) {
        if (calcPicked.length >= CALC_VARS.length) {
          cb.checked = false;
          return;
        }
        if (!calcPicked.includes(cb.dataset.key)) calcPicked.push(cb.dataset.key);
      } else {
        calcPicked = calcPicked.filter((k) => k !== cb.dataset.key);
      }
      renderCalcSignalList();
    });
    sl?.addEventListener("click", (e) => {
      const v = e.target.closest(".calc-var");
      if (v?.dataset.var) {
        e.preventDefault();
        insertIntoExpr(v.dataset.var);
      }
    });
    $("calcDefList")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      const row = e.target.closest(".calc-def");
      if (btn && row) onCalcDefAction(row.dataset.id, btn.dataset.act);
    });

    $("btnStats")?.addEventListener("click", () => toggleStatsPanel());
    $("btnStatsClose")?.addEventListener("click", () => toggleStatsPanel(false));
    $("btnStatsCopy")?.addEventListener("click", copyStatsTable);
    document.querySelectorAll('input[name="statsRange"]').forEach((r) => {
      r.addEventListener("change", () => {
        if (!r.checked) return;
        statsRange = r.value;
        scheduleStatsPanelRefresh();
        scheduleWorkspaceSave();
      });
    });
    $("statsTable")?.addEventListener("click", (e) => {
      const row = e.target.closest("tr[data-key]");
      if (!row) return;
      focusChartForKey(row.dataset.key);
      revealSelectedItem(row.dataset.key);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closeModal("calc-modal");
      closeModal("group-modal");
    });
  }

  bindFeaturePanels();

  async function bootApp() {
    try {
      session = await api("/api/session");
      if (Array.isArray(session.dbcs)) dbcList = session.dbcs;
      const ws = await api("/api/workspace");
      if (Array.isArray(ws.dbcs) && ws.dbcs.length) dbcList = ws.dbcs;
      await Promise.all([loadCalcDefs(), loadGroups()]);
      restoreWorkspaceUi(ws.ui);
      renderGroupSelect();
      applyStatsPanelVisibility();
      renderDbcSelect();
      if (session.has_dbc) {
        const tree = await api("/api/dbc/tree");
        if (Array.isArray(tree.dbcs)) dbcList = tree.dbcs;
        ecus = normalizeEcus(tree);
        collapseAllTree();
        renderDbcSelect();
      }
      const meta = $("meta");
      if (meta) {
        meta.textContent = [
          session.log && `\u65e5\u5fd7: ${session.log} (${session.frame_count}\u5e27, ${session.duration.toFixed(2)}s)`,
          session.has_wall_time && session.log_start_text
            ? `\u8d77\u59cb: ${session.log_start_text} (\u672c\u5730\u65f6\u533a)`
            : null,
          session.dbc && `DBC: ${session.dbc}`,
          dbcList.length > 1 ? `(${dbcList.length}\u4e2a\u914d\u7f6e)` : "",
          session.restored ? "\u00b7 \u5df2\u6062\u590d\u4e0a\u6b21\u4f1a\u8bdd" : "",
        ]
          .filter(Boolean)
          .join(" | ");
      }
      renderPickerTree();
      renderSelectedList();
      renderViews();
      if (selectedOrder.length && session.has_log) {
        await refreshCharts();
      } else {
        updateTopBar();
      }
    } catch (err) {
      showErr(err.message);
    }
  }

  $("pickerFilter").oninput = renderPickerTree;
  $("btnPicker").onclick = () => {
    $("picker-panel").classList.toggle("open");
    $("btnPicker").classList.toggle("open");
  };

  bindTreeContainer($("picker-tree"));
  bindSidebarResize();
  const sidebar = $("sidebar");
  if (sidebar && !sidebar.style.width) sidebar.style.width = `${DEFAULT_SIDEBAR_W}px`;

  $("btnClearCursor")?.addEventListener("click", clearCursor);
  $("btnMeasure")?.addEventListener("click", toggleMeasureMode);
  $("btnTogglePoints")?.addEventListener("click", toggleDataPoints);
  $("btnFitCurrentX")?.addEventListener("click", () => fitCurrentAxis("x"));
  $("btnFitCurrentY")?.addEventListener("click", () => fitCurrentAxis("y"));
  $("btnFitCurrentXY")?.addEventListener("click", () => fitCurrentAxis("xy"));
  $("btnOverviewAll")?.addEventListener("click", overviewAllXY);

  const chartHeightRange = $("chartHeightRange");
  if (chartHeightRange) {
    syncChartHeightControl();
    chartHeightRange.addEventListener("input", () => {
      applyGlobalChartHeight(chartHeightRange.value, { redraw: true });
    });
  }

  function openBusLoadModal() {
    const modal = $("busload-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    if (session?.has_log) runBusLoadQuery();
  }

  function closeBusLoadModal() {
    const modal = $("busload-modal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  function fmtLoadPct(v) {
    if (v == null || Number.isNaN(v)) return "—";
    return `${Number(v).toFixed(3)}%`;
  }

  function renderBusLoadResult(data) {
    const summary = $("busloadSummary");
    const tree = $("busloadTree");
    if (!summary || !tree) return;
    const ov = data.overall || {};
    const peak = data.peak || (data.windows || []).reduce(
      (best, w) => (!best || (w.total_load_pct || 0) > (best.total_load_pct || 0) ? w : best),
      null
    ) || ov;
    const winSec = data.window_sec;
    const parts = [
      `整段负载 ${fmtLoadPct(ov.total_load_pct)}`,
      `帧数 ${ov.frame_count ?? 0}`,
      `时长 ${(data.duration || 0).toFixed(3)}s`,
      `波特率 ${data.bitrate}`,
    ];
    if (winSec) {
      parts.push(`窗口 ${winSec}s · 峰值 ${fmtLoadPct(peak.total_load_pct)}`);
      if (data.window_count) parts.push(`共 ${data.window_count} 段`);
      if (data.windows_truncated) parts.push("窗口列表已抽样");
    }
    if (!data.has_dbc) parts.push("未加载DBC（ECU按未分类）");
    summary.textContent = parts.join(" · ");

    const ecus = ov.ecus || [];
    if (!ecus.length) {
      tree.innerHTML = '<span class="meta">无帧数据</span>';
      return;
    }
    let html = "";
    for (const ecu of ecus) {
      html += `<details open>
        <summary><strong>${esc(ecu.ecu)}</strong>
          <span class="bl-pct">${fmtLoadPct(ecu.load_pct)}</span>
          <span class="meta">(${ecu.frame_count || 0} 帧)</span>
        </summary>`;
      for (const fr of ecu.frames || []) {
        const label = fr.name || fr.frame_id_hex || `0x${Number(fr.frame_id).toString(16).toUpperCase()}`;
        html += `<div class="bl-row">
          <span>${esc(label)} <span class="meta">${esc(fr.frame_id_hex || "")}</span></span>
          <span class="meta">${fr.count || 0}</span>
          <strong class="bl-pct">${fmtLoadPct(fr.load_pct)}</strong>
        </div>`;
      }
      html += `</details>`;
    }
    if (winSec && (data.windows || []).length > 1) {
      const wlabel = data.windows_truncated
        ? `各时间窗口（抽样 ${data.windows.length}/${data.window_count || data.windows.length}）`
        : `各时间窗口 (${data.windows.length})`;
      html += `<details>
        <summary><strong>${wlabel}</strong></summary>`;
      for (const w of data.windows) {
        html += `<div class="bl-row">
          <span>${esc(fmtAxisTime(w.t_start))} → ${esc(fmtAxisTime(w.t_end))}</span>
          <span class="meta">${w.frame_count || 0}</span>
          <strong class="bl-pct">${fmtLoadPct(w.total_load_pct)}</strong>
        </div>`;
      }
      html += `</details>`;
    }
    tree.innerHTML = html;
  }

  async function runBusLoadQuery() {
    const summary = $("busloadSummary");
    const tree = $("busloadTree");
    if (!session?.has_log) {
      if (summary) summary.textContent = "请先加载日志文件";
      if (tree) tree.innerHTML = "";
      return;
    }
    const bitrate = Number($("busloadBitrate")?.value || 500000);
    const windowSec = Number($("busloadWindow")?.value ?? 1);
    const stuffing = $("busloadStuff")?.value || "estimate";
    if (summary) summary.textContent = "查询中…";
    if (tree) tree.innerHTML = "";
    try {
      const data = await api("/api/busload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bitrate,
          window_sec: windowSec,
          stuffing,
        }),
      });
      renderBusLoadResult(data);
    } catch (err) {
      if (summary) summary.textContent = err.message || String(err);
      showErr(err.message);
    }
  }

  $("btnBusLoad")?.addEventListener("click", openBusLoadModal);
  $("btnBusLoadClose")?.addEventListener("click", closeBusLoadModal);
  $("busloadBackdrop")?.addEventListener("click", closeBusLoadModal);
  $("btnBusLoadRun")?.addEventListener("click", runBusLoadQuery);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("busload-modal")?.classList.contains("hidden")) {
      closeBusLoadModal();
    }
  });

  window.addEventListener("pagehide", flushWorkspaceSave);
  window.addEventListener("beforeunload", flushWorkspaceSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushWorkspaceSave();
  });

  bootApp();
})();
