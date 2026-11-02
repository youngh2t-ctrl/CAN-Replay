import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { SignalSeries } from "../api";

export interface ViewScale {
  xMin: number;
  xMax: number;
  yMin: number | null;
  yMax: number | null;
}

interface Props {
  series: SignalSeries | null;
  title: string;
  label: string;
  playhead: number;
  tBase: number;
  scale: ViewScale;
  onScaleChange: (scale: ViewScale) => void;
  onPick: (t: number, v: number) => void;
}

function nearest(ts: number[], t: number) {
  if (!ts.length) return null;
  let lo = 0;
  let hi = ts.length - 1;
  if (t <= ts[0]) return { t: ts[0], idx: 0 };
  if (t >= ts[hi]) return { t: ts[hi], idx: hi };
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const idx =
    lo > 0 && Math.abs(ts[lo - 1] - t) <= Math.abs(ts[lo] - t) ? lo - 1 : lo;
  return { t: ts[idx], idx };
}

export default function SignalChartView({
  series,
  title,
  label,
  playhead,
  tBase,
  scale,
  onScaleChange,
  onPick,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [cursorText, setCursorText] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !series?.timestamps.length) {
      plotRef.current?.destroy();
      plotRef.current = null;
      if (host) host.innerHTML = "";
      return;
    }

    const relTs: number[] = [];
    const relVs: number[] = [];
    for (let i = 0; i < series.timestamps.length; i++) {
      const t = series.timestamps[i];
      if (t >= scale.xMin && t <= scale.xMax) {
        relTs.push(t - tBase);
        relVs.push(series.values[i]);
      }
    }
    if (!relTs.length) return;

    let yMin = scale.yMin;
    let yMax = scale.yMax;
    if (yMin == null || yMax == null) {
      yMin = Math.min(...relVs);
      yMax = Math.max(...relVs);
      const pad = (yMax - yMin) * 0.05 || 1;
      yMin -= pad;
      yMax += pad;
    }

    const data: uPlot.AlignedData = [relTs, relVs];
    const playRel = playhead - tBase;

    plotRef.current?.destroy();
    host.innerHTML = "";

    const plot = new uPlot(
      {
        width: host.clientWidth || 400,
        height: 200,
        series: [{}, { label: title, stroke: "#3b82f6", width: 2 }],
        scales: {
          x: { time: false, min: scale.xMin - tBase, max: scale.xMax - tBase },
          y: { min: yMin, max: yMax },
        },
        axes: [
          { stroke: "#8b9cb3", grid: { stroke: "#2d3a4f" } },
          { stroke: "#8b9cb3", grid: { stroke: "#2d3a4f" } },
        ],
        hooks: {
          draw: [
            (u) => {
              const left = u.valToPos(playRel, "x", true);
              if (!Number.isFinite(left)) return;
              const ctx = u.ctx;
              ctx.save();
              ctx.strokeStyle = "#f59e0b";
              ctx.lineWidth = 2;
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(left, u.bbox.top);
              ctx.lineTo(left, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.restore();
            },
          ],
          ready: [
            (u) => {
              const over = u.over;
              over.addEventListener("wheel", (e) => {
                e.preventDefault();
                const rect = over.getBoundingClientRect();
                const left = e.clientX - rect.left;
                const xVal = u.posToVal(left, "x");
                const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
                if (e.ctrlKey) {
                  let ymin = scale.yMin ?? 0;
                  let ymax = scale.yMax ?? 1;
                  const yVal = u.posToVal(e.clientY - rect.top, "y");
                  const yr = ymax - ymin;
                  const nyr = yr * factor;
                  onScaleChange({
                    ...scale,
                    yMin: yVal - ((yVal - ymin) / yr) * nyr,
                    yMax: (yVal - ((yVal - ymin) / yr) * nyr) + nyr,
                  });
                } else {
                  const xmin = scale.xMin - tBase;
                  const xmax = scale.xMax - tBase;
                  const xr = xmax - xmin;
                  const nxr = xr * factor;
                  const newMin = xVal - ((xVal - xmin) / xr) * nxr;
                  onScaleChange({
                    ...scale,
                    xMin: newMin + tBase,
                    xMax: newMin + tBase + nxr,
                  });
                }
              });
              over.addEventListener("click", (e) => {
                const rect = over.getBoundingClientRect();
                const relX = u.posToVal(e.clientX - rect.left, "x");
                const tAbs = relX + tBase;
                const pt = nearest(series.timestamps, tAbs);
                if (!pt) return;
                const v = series.values[pt.idx];
                onPick(tAbs, v);
                setCursorText(`X: ${(tAbs - tBase).toFixed(3)}s  Y: ${v.toFixed(4)}`);
              });
            },
          ],
        },
      },
      data,
      host
    );
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, [series, playhead, tBase, scale, title, onScaleChange, onPick]);

  const fit = (mode: "x" | "y" | "xy") => {
    if (!series) return;
    const next = { ...scale };
    if (mode === "x" || mode === "xy") {
      /* x from parent global viewport - caller should set */
    }
    if (mode === "y" || mode === "xy") {
      let ymin = Infinity;
      let ymax = -Infinity;
      for (let i = 0; i < series.timestamps.length; i++) {
        const t = series.timestamps[i];
        if (t < scale.xMin || t > scale.xMax) continue;
        const y = series.values[i];
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
      }
      const pad = (ymax - ymin) * 0.05 || 1;
      next.yMin = ymin - pad;
      next.yMax = ymax + pad;
    }
    onScaleChange(next);
  };

  return (
    <div className="view-panel">
      <div className="view-header" style={{ display: "flex", gap: 8, padding: 8 }}>
        <strong style={{ flex: 1 }}>{label}</strong>
        <button type="button" className="btn secondary" onClick={() => fit("x")}>
          适配 X
        </button>
        <button type="button" className="btn secondary" onClick={() => fit("y")}>
          适配 Y
        </button>
        <button type="button" className="btn secondary" onClick={() => fit("xy")}>
          适配 XY
        </button>
      </div>
      <div ref={hostRef} className="chart-wrap" style={{ minHeight: 200 }} />
      <div style={{ padding: "4px 10px", fontSize: "0.75rem", color: "#8b9cb3" }}>
        {cursorText || "点击曲线查看 X/Y · 滚轮 X · Ctrl+滚轮 Y"}
      </div>
    </div>
  );
}
