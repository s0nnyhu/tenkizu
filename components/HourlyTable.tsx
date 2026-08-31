"use client";

import { useMemo, useState } from "react";
import type { HourlyDayGrid, TempUnit } from "@/lib/types";
import { tempHeatColor } from "@/lib/format";

function localHour(timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  return Number(h);
}

export function HourlyTable({
  days,
  unit,
  timezone,
}: {
  days: HourlyDayGrid[];
  unit: TempUnit;
  timezone: string;
}) {
  const [sel, setSel] = useState(days.find((d) => d.horizon === "J")?.date ?? days[0]?.date ?? "");
  const grid = days.find((d) => d.date === sel) ?? days[0];
  const nowH = grid?.horizon === "J" ? localHour(timezone) : -1;

  const peakIdx = useMemo(() => {
    if (!grid) return {} as Record<string, number>;
    const map: Record<string, number> = {};
    for (const row of grid.rows) {
      let best = -Infinity;
      let idx = -1;
      row.temps.forEach((v, i) => {
        if (v != null && v > best) {
          best = v;
          idx = i;
        }
      });
      map[row.id] = idx;
    }
    return map;
  }, [grid]);

  const heatRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const row of grid?.rows ?? []) {
      for (const v of row.temps) {
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    return { min, max };
  }, [grid]);

  if (!grid) return null;

  return (
    <div className="card hourly-card">
      <div className="hourly-head">
        <h2>Températures horaires · heure locale {timezone}</h2>
        <div className="hourly-tabs">
          {days.map((d) => (
            <button
              key={d.date}
              type="button"
              className={d.date === grid.date ? "on" : ""}
              onClick={() => setSel(d.date)}
            >
              {d.horizon} · {d.date.slice(5)}
            </button>
          ))}
        </div>
      </div>
      <div className="hourly-wrap">
        <table className="hourly">
          <thead>
            <tr>
              <th className="sticky">Modèle</th>
              {grid.hours.map((h, i) => (
                <th key={h} className={i === nowH ? "now" : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => {
              const dead =
                row.status === "out_of_domain" ||
                row.status === "out_of_horizon" ||
                row.status === "unavailable" ||
                row.status === "error";
              const allNull = row.temps.every((v) => v == null);
              return (
                <tr key={row.id} className={row.kind}>
                  <th className="sticky">
                    {row.label}
                    {dead && allNull && (
                      <span className="sub">
                        {row.status === "out_of_domain"
                          ? "hors domaine"
                          : row.status === "out_of_horizon"
                            ? "hors horizon"
                            : row.status === "unavailable"
                              ? "n/a"
                              : "erreur"}
                      </span>
                    )}
                  </th>
                  {row.temps.map((v, i) => {
                    if (v == null) {
                      return (
                        <td key={i} className={i === nowH ? "now empty" : "empty"}>
                          ·
                        </td>
                      );
                    }
                    const peak = peakIdx[row.id] === i;
                    const bg = tempHeatColor(v, heatRange.min, heatRange.max);
                    return (
                      <td
                        key={i}
                        className={`${peak ? "peak" : ""} ${i === nowH ? "now" : ""}`}
                        style={{ background: bg }}
                        title={`${row.label} ${grid.hours[i]}h → ${v.toFixed(1)}°${unit}${peak ? " · pic" : ""}`}
                      >
                        {v.toFixed(0)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hourly-legend">
        °{unit} · heure locale station · fond = chaleur relative du jour · cadre pêche = Tmax du
        modèle · colonne marquée = heure actuelle (J)
      </p>
    </div>
  );
}
