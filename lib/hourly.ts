import type { TempUnit } from "./types";
import { toMarketUnit } from "./units";

export const HOURS_24 = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

export function emptySlots(): Array<number | null> {
  return Array.from({ length: 24 }, () => null);
}

export function fillSlotsDirect(
  times: string[],
  temps: Array<number | null>,
  date: string,
  mode: "last" | "max" = "last",
): Array<number | null> {
  const out = emptySlots();
  const seen = emptySlots();
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const v = temps[i];
    if (!t?.startsWith(date) || v == null || !Number.isFinite(v)) continue;
    const h = Number(t.slice(11, 13));
    if (h < 0 || h > 23) continue;
    if (seen[h] == null) {
      out[h] = v;
      seen[h] = 1;
    } else if (mode === "max" && v > (out[h] ?? -Infinity)) {
      out[h] = v;
    }
  }
  return out;
}

export function fillSlots(
  times: string[],
  temps: Array<number | null>,
  date: string,
  unit: TempUnit,
  mode: "last" | "max" = "last",
): Array<number | null> {
  const converted = temps.map((v) => (v == null ? null : toMarketUnit(v, unit)));
  return fillSlotsDirect(times, converted, date, mode);
}

export function hourFromIso(localIso: string): number | null {
  const h = Number(localIso.slice(11, 13));
  return Number.isFinite(h) && h >= 0 && h < 24 ? h : null;
}
