import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { SignalSeries } from "../api";

const COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

interface Props {
  series: SignalSeries[];
  playhead: number | null;
  tStart: number;
  tEnd: number;
}

export default function ChartPanel({
  series,
  playhead,
  tStart,
  tEnd,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (!series.length) {
      plotRef.current?.destroy();
      plotRef.current = null;
      el.innerHTML = "";
      return;
    }

    const baseTs = series[0]?.timestamps[0] ?? tStart;
    const rel = (t: number) => t - baseTs;

    const alignedX = new Set<number>();
    for (const s of series) {
      for (const t of s.timestamps) alignedX.add(rel(t));
    }
    const xData = Array.from(alignedX).sort((a, b) => a - b);

    if (xData.length === 0) {
      plotRef.current?.destroy();
      plotRef.current = null;
      return;
    }

    const data: uPlot.AlignedData = [
      xData,
      ...series.map((s) => {
        const map = new Map(s.timestamps.map((t, i) => [rel(t), s.values[i]]));
        return xData.map((x) => map.get(x) ?? null);
      }),
    ];

    const playheadRel =
      playhead != null && playhead >= tStart && playhead <= tEnd
        ? rel(playhead)
        : null;

    plotRef.current?.destroy();

    const width = el.clientWidth || 600;
    const height = Math.max(220, el.clientHeight || 280);

    const opts: uPlot.Options = {
      width,
      height,
      series: [
        { label: "时间 (s)" },
        ...series.map((s, i) => ({
          label: s.unit ? `${s.name} (${s.unit})` : s.name,
          stroke: COLORS[i % COLORS.length],
          width: 2,
        })),
      ],
      axes: [
        { stroke: "#8b9cb3", grid: { stroke: "#2d3a4f" } },
        { stroke: "#8b9cb3", grid: { stroke: "#2d3a4f" } },
      ],
      scales: {
        x: { time: false },
      },
      hooks: {
        draw: [
          (u) => {
            if (playheadRel == null) return;
            const left = u.valToPos(playheadRel, "x", true);
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
      },
    };

    plotRef.current = new uPlot(opts, data, el);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [series, playhead, tStart, tEnd]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !plotRef.current) return;
    const ro = new ResizeObserver(() => {
      if (plotRef.current) {
        plotRef.current.setSize({
          width: el.clientWidth,
          height: Math.max(220, el.clientHeight),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [series]);

  if (!series.length) {
    return (
      <div className="empty-hint">
        勾选左侧信号后显示曲线（需已加载日志与 DBC）
      </div>
    );
  }

  return <div ref={containerRef} className="chart-wrap" style={{ height: "100%" }} />;
}
