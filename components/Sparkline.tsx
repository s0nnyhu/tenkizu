"use client";

import { useState } from "react";
import type { HourlyDayGrid } from "@/lib/types";

const COLORS: Record<string, string> = {
  metar: "#5ee9a8",
  wu: "#f5c14a",
  ecmwf_ifs: "#2ee6c5",
  icon: "#c084fc",
  icon_d2: "#a78bfa",
  arome: "#f472b6",
  ukmo: "#38bdf8",
  gfs: "#6ea8ff",
  hrrr: "#94a3b8",
  cma: "#fdba74",
};

function colorFor(id: string, i: number): string {
  return COLORS[id] ?? `hsl(${(i * 47) % 360} 58% 58%)`;
}

export function Sparkline({ grid, unit }: { grid: HourlyDayGrid | undefined; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = (grid?.rows ?? []).filter((r) => r.temps.some((v) => v != null));
  const vals = rows.flatMap((r) => r.temps).filter((v): v is number => v != null);
  if (!grid || !rows.length || !vals.length) {
    return <div className="muted">Pas encore de série horaire pour J.</div>;
  }

  const w = 920;
  const h = 168;
  const pad = { l: 36, r: 12, t: 10, b: 18 };
  const n = grid.hours.length;
  const min = Math.min(...vals) - 1;
  const max = Math.max(...vals) + 1;
  const x = (i: number) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, n - 1);
  const y = (v: number) => pad.t + ((max - v) * (h - pad.t - pad.b)) / (max - min || 1);

  function pathFrom(temps: Array<number | null>): string {
    const d: string[] = [];
    let drawing = false;
    temps.forEach((v, i) => {
      if (v == null) {
        drawing = false;
        return;
      }
      d.push(`${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      drawing = true;
    });
    return d.join(" ");
  }

  function hourFromClientX(svg: SVGSVGElement, clientX: number): number {
    const rect = svg.getBoundingClientRect();
    const xSvg = ((clientX - rect.left) / Math.max(1, rect.width)) * w;
    const t = (xSvg - pad.l) / (w - pad.l - pad.r);
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  }

  const tipRows =
    hover == null
      ? []
      : rows
          .map((row, i) => ({
            id: row.id,
            label: row.label,
            color: colorFor(row.id, i),
            v: row.temps[hover],
          }))
          .filter((r) => r.v != null)
          .sort((a, b) => (b.v as number) - (a.v as number));

  return (
    <div className="spark-wrap">
      <svg
        className="spark"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="Profil horaire J"
        onMouseMove={(e) => setHover(hourFromClientX(e.currentTarget, e.clientX))}
        onMouseLeave={() => setHover(null)}
      >
        {rows.map((row, i) => {
          const stroke = colorFor(row.id, i);
          const dashed = row.kind === "wu" ? "4 3" : undefined;
          const width = row.id === "ecmwf_ifs" || row.id === "icon" || row.kind === "metar" ? 1.8 : 1.25;
          return (
            <path
              key={row.id}
              d={pathFrom(row.temps)}
              fill="none"
              stroke={stroke}
              strokeWidth={width}
              strokeDasharray={dashed}
              opacity={row.kind === "extra" ? 0.75 : 0.95}
            />
          );
        })}
        {rows
          .find((r) => r.kind === "metar")
          ?.temps.map((v, i) =>
            v == null ? null : (
              <circle key={`m${i}`} cx={x(i)} cy={y(v)} r="2.3" fill={COLORS.metar} />
            ),
          )}
        {hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.t}
              y2={h - pad.b}
              stroke="#e8edf7"
              strokeOpacity="0.35"
            />
            {rows.map((row, i) => {
              const v = row.temps[hover];
              if (v == null) return null;
              return <circle key={`h${row.id}`} cx={x(hover)} cy={y(v)} r="3.2" fill={colorFor(row.id, i)} />;
            })}
          </>
        )}
        <text x="8" y={y(max) + 4}>
          {max.toFixed(0)}
        </text>
        <text x="8" y={y(min) + 4}>
          {min.toFixed(0)}
        </text>
      </svg>
      {hover != null && tipRows.length > 0 && (
        <div
          className={`spark-tip ${hover > 14 ? "left" : "right"}`}
          style={{ left: `${(x(hover) / w) * 100}%` }}
        >
          <b>
            {grid.hours[hover]}h locale
          </b>
          {tipRows.map((r) => (
            <div key={r.id}>
              <i style={{ background: r.color }} />
              <span>{r.label}</span>
              <em>
                {(r.v as number).toFixed(1)}°{unit}
              </em>
            </div>
          ))}
        </div>
      )}
      <div className="spark-legend">
        {rows.map((row, i) => (
          <span key={row.id}>
            <i style={{ background: colorFor(row.id, i) }} />
            {row.label}
          </span>
        ))}
        <span className="faint">°{unit} · J · trait pointillé = WU · survol = T° à l’heure</span>
      </div>
    </div>
  );
}
