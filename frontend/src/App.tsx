import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSession,
  fetchValuesAtTime,
  fetchViewport,
  uploadDbc,
  uploadLog,
  type DbcEcu,
  type SessionInfo,
  type SignalSeries,
} from "./api";
import SignalChartView, { type ViewScale } from "./components/SignalChartView";
import SignalTree from "./components/SignalTree";

function groupMessagesByEcu(messages: import("./api").DbcMessage[]): import("./api").DbcEcu[] {
  const map = new Map<string, import("./api").DbcMessage[]>();
  for (const m of messages) {
    const ecu = m.ecu || "未分类";
    if (!map.has(ecu)) map.set(ecu, []);
    map.get(ecu)!.push(m);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, msgs]) => ({ name, messages: msgs }));
}

function formatTime(sec: number, base: number): string {
  const rel = sec - base;
  const m = Math.floor(Math.abs(rel) / 60);
  const s = (Math.abs(rel) % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

interface ChartView {
  key: string;
  label: string;
  title: string;
  scale: ViewScale;
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [ecus, setEcus] = useState<DbcEcu[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [chartViews, setChartViews] = useState<ChartView[]>([]);
  const [seriesMap, setSeriesMap] = useState<Map<string, SignalSeries>>(new Map());
  const [layoutMode, setLayoutMode] = useState<"stack" | "tab">("stack");
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("");
  const lastTickRef = useRef(0);

  const refreshSession = useCallback(async () => {
    const s = await fetchSession();
    setSession(s);
    if (s.has_log) {
      setPlayhead(s.t_start);
      setViewStart(s.t_start);
      setViewEnd(s.t_end);
    }
  }, []);

  useEffect(() => {
    refreshSession().catch(() => {});
  }, [refreshSession]);

  const findMeta = (key: string) => {
    for (const ecu of ecus) {
      for (const m of ecu.messages) {
        for (const s of m.signals) {
          if (s.key === key) {
            return {
              label: `${ecu.name} / ${m.name} / ${s.name}`,
              title: s.unit ? `${s.name} (${s.unit})` : s.name,
            };
          }
        }
      }
    }
    return { label: key, title: key };
  };

  const syncViews = useCallback(
    (keys: Set<string>) => {
      setChartViews((prev) => {
        const next = prev.filter((v) => keys.has(v.key));
        keys.forEach((key) => {
          if (!next.find((v) => v.key === key)) {
            const meta = findMeta(key);
            next.push({
              key,
              label: meta.label,
              title: meta.title,
              scale: { xMin: viewStart, xMax: viewEnd, yMin: null, yMax: null },
            });
          }
        });
        return next;
      });
    },
    [ecus, viewStart, viewEnd]
  );

  const keys = Array.from(selected);

  const loadCharts = useCallback(async () => {
    if (!keys.length || !session?.has_log) {
      setSeriesMap(new Map());
      return;
    }
    const { series } = await fetchViewport(keys, viewStart, viewEnd);
    const m = new Map<string, SignalSeries>();
    series.forEach((s) => m.set(s.key, s));
    setSeriesMap(m);
  }, [keys.join(","), viewStart, viewEnd, session?.has_log]);

  const loadStatus = useCallback(async () => {
    if (!keys.length) {
      setStatusText("");
      return;
    }
    const { values } = await fetchValuesAtTime(keys, playhead);
    setStatusText(
      values
        .map((v) => `${v.name}: ${v.value != null ? v.value.toFixed(4) : "—"} ${v.unit}`)
        .join(" | ")
    );
  }, [keys.join(","), playhead]);

  useEffect(() => {
    loadCharts().catch((e) => setError(String(e)));
  }, [loadCharts]);

  useEffect(() => {
    loadStatus().catch(() => {});
  }, [loadStatus]);

  useEffect(() => {
    if (!playing || !session?.has_log) return;
    const tick = (now: number) => {
      if (!lastTickRef.current) lastTickRef.current = now;
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setPlayhead((t) => {
        const next = t + dt * speed;
        if (next >= session.t_end) {
          setPlaying(false);
          return session.t_end;
        }
        return next;
      });
      requestAnimationFrame(tick);
    };
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, speed, session]);

  const toggleSignal = (key: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      syncViews(next);
      if (on && !activeTab) setActiveTab(key);
      return next;
    });
  };

  const tBase = session?.t_start ?? 0;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>CAN 离线回放</h1>
        <label className="btn">
          加载日志
          <input
            type="file"
            accept=".asc,.blf"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setError(null);
              try {
                await uploadLog(f);
                await refreshSession();
                setSelected(new Set());
                setChartViews([]);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
              e.target.value = "";
            }}
          />
        </label>
        <label className="btn">
          加载 DBC
          <input
            type="file"
            accept=".dbc"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setError(null);
              try {
                const r = await uploadDbc(f);
                const list =
                  r.ecus?.length
                    ? r.ecus
                    : groupMessagesByEcu(r.messages || []);
                setEcus(list);
                await refreshSession();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
              e.target.value = "";
            }}
          />
        </label>
        {session?.log && (
          <span className="meta">
            {session.log} · {session.frame_count} 帧 · {session.duration.toFixed(2)}s
          </span>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="main">
        <aside className="sidebar">
          <SignalTree
            ecus={ecus}
            selected={selected}
            onToggle={toggleSignal}
            disabled={!session?.has_dbc}
          />
        </aside>

        <div className="content">
          <div className="view-toolbar" style={{ padding: 8, display: "flex", gap: 8 }}>
            <span>视图布局</span>
            <button
              type="button"
              className={`btn ${layoutMode === "stack" ? "active" : ""}`}
              onClick={() => setLayoutMode("stack")}
            >
              堆叠
            </button>
            <button
              type="button"
              className={`btn ${layoutMode === "tab" ? "active" : ""}`}
              onClick={() => setLayoutMode("tab")}
            >
              标签
            </button>
          </div>

          {layoutMode === "tab" && chartViews.length > 0 && (
            <div style={{ display: "flex", gap: 4, padding: "0 8px", flexWrap: "wrap" }}>
              {chartViews.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`btn ${activeTab === v.key ? "active" : ""}`}
                  onClick={() => setActiveTab(v.key)}
                >
                  {v.title}
                </button>
              ))}
            </div>
          )}

          <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
            {!chartViews.length ? (
              <p className="empty-hint">勾选信号后显示曲线视图</p>
            ) : (
              chartViews
                .filter((v) => layoutMode === "stack" || v.key === (activeTab || chartViews[0]?.key))
                .map((v) => (
                  <SignalChartView
                    key={v.key}
                    series={seriesMap.get(v.key) ?? null}
                    label={v.label}
                    title={v.title}
                    playhead={playhead}
                    tBase={tBase}
                    scale={v.scale}
                    onScaleChange={(scale) =>
                      setChartViews((prev) =>
                        prev.map((x) => (x.key === v.key ? { ...x, scale } : x))
                      )
                    }
                    onPick={(t) => {
                      setPlayhead(t);
                      setPlaying(false);
                      loadStatus();
                    }}
                  />
                ))
            )}
          </div>

          <div id="status-bar" style={{ padding: 8, fontSize: "0.8rem", color: "#8b9cb3" }}>
            {statusText || "播放头时刻信号值"}
          </div>
        </div>
      </div>

      <footer className="timeline-panel">
        <div className="timeline-controls">
          <button
            type="button"
            disabled={!session?.has_log}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? "暂停" : "播放"}
          </button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
          <span>
            {formatTime(playhead, tBase)} / {formatTime(session?.t_end ?? 0, tBase)}
          </span>
          <button
            type="button"
            disabled={!session?.has_log}
            onClick={() => {
              setViewStart(session!.t_start);
              setViewEnd(session!.t_end);
              setChartViews((prev) =>
                prev.map((v) => ({
                  ...v,
                  scale: {
                    xMin: session!.t_start,
                    xMax: session!.t_end,
                    yMin: null,
                    yMax: null,
                  },
                }))
              );
            }}
          >
            全局显示全部
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={0.01}
          disabled={!session?.has_log}
          value={
            session && session.duration > 0
              ? ((playhead - session.t_start) / session.duration) * 100
              : 0
          }
          onChange={(e) => {
            const pct = Number(e.target.value);
            setPlayhead(session!.t_start + (pct / 100) * session!.duration);
            setPlaying(false);
          }}
        />
      </footer>
    </div>
  );
}
