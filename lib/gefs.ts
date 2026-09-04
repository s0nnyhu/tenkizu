import { cached } from "./cache";
import { fetchJson, withRetry } from "./http";
import type { GefsDay, TempUnit } from "./types";
import { mean, spread } from "./units";

/** GEFS 0.25° cycles 00/06/12/18Z; Open-Meteo typically lags ~5 h. Independent of GFS 0.13° déterministe. */
const CYCLE_H = 6;
const LAG_H = 5;
const FORECAST_DAYS = 4;

type EnsembleDaily = Record<string, Array<number | string | null> | undefined>;

type EnsembleResponse = {
  daily?: EnsembleDaily;
  error?: boolean;
  reason?: string;
};

export type GefsPack = {
  byDate: Record<string, GefsDay>;
  fetchedAt: string;
  cycleUtc: string;
  error?: string;
};

function asNums(raw: Array<number | string | null> | undefined): Array<number | null> {
  if (!raw) return [];
  return raw.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
}

function memberColumns(daily: EnsembleDaily): Array<Array<number | null>> {
  const cols: Array<Array<number | null>> = [];
  const control = asNums(daily.temperature_2m_max);
  if (control.length) cols.push(control);
  for (let i = 1; i <= 30; i++) {
    const key = `temperature_2m_max_member${String(i).padStart(2, "0")}`;
    const col = asNums(daily[key]);
    if (col.length) cols.push(col);
  }
  return cols;
}

function statsForIndex(cols: Array<Array<number | null>>, i: number): Omit<GefsDay, "date"> {
  const vals: number[] = [];
  for (const col of cols) {
    const v = col[i];
    if (v != null) vals.push(v);
  }
  const m = mean(vals);
  const sp = spread(vals);
  return {
    mean: m,
    min: sp?.min ?? null,
    max: sp?.max ?? null,
    spread: sp == null ? null : sp.max - sp.min,
    n: vals.length,
  };
}

/** Estimated current GEFS cycle (UTC hour), after typical Open-Meteo lag. */
function gefsCycleUtc(now = new Date()): { hour: number; label: string; runMs: number } {
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  let runHour = Math.floor((utcH - LAG_H) / CYCLE_H) * CYCLE_H;
  let dayOffset = 0;
  while (runHour < 0) {
    runHour += 24;
    dayOffset -= 1;
  }
  const runDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, runHour),
  );
  return {
    hour: runHour,
    label: `${String(runHour).padStart(2, "0")}Z`,
    runMs: runDate.getTime(),
  };
}

function ttlMsUntilNextCycle(now = new Date()): number {
  const { runMs } = gefsCycleUtc(now);
  let exp = runMs + (CYCLE_H + LAG_H) * 3_600_000;
  while (exp <= now.getTime() + 60_000) exp += CYCLE_H * 3_600_000;
  return Math.max(60_000, Math.min(exp - now.getTime(), CYCLE_H * 3_600_000));
}

type GefsOpts = {
  icao: string;
  lat: number;
  lon: number;
  timezone: string;
  unit: TempUnit;
  dates: string[];
};

function gefsKey(opts: GefsOpts): string {
  const cycle = gefsCycleUtc();
  return `gefs2:${opts.icao}:${opts.lat.toFixed(5)}:${opts.lon.toFixed(5)}:${opts.unit}:${opts.dates.join(",")}:${cycle.label}`;
}

function emptyDay(date: string): GefsDay {
  return { date, mean: null, min: null, max: null, spread: null, n: 0 };
}

function emptyPack(opts: GefsOpts, message: string): GefsPack {
  const byDate: Record<string, GefsDay> = {};
  for (const date of opts.dates) byDate[date] = emptyDay(date);
  return {
    byDate,
    fetchedAt: new Date().toISOString(),
    cycleUtc: gefsCycleUtc().label,
    error: message,
  };
}

function packFromDaily(daily: EnsembleDaily | undefined, opts: GefsOpts): GefsPack {
  const times = (daily?.time ?? []).map(String);
  const cols = daily ? memberColumns(daily) : [];
  const byDate: Record<string, GefsDay> = {};
  for (const date of opts.dates) {
    const i = times.indexOf(date);
    if (i < 0 || !cols.length) {
      byDate[date] = emptyDay(date);
      continue;
    }
    byDate[date] = { date, ...statsForIndex(cols, i) };
  }
  return {
    byDate,
    fetchedAt: new Date().toISOString(),
    cycleUtc: gefsCycleUtc().label,
  };
}

async function gefsRequest(opts: GefsOpts): Promise<EnsembleResponse> {
  const params = new URLSearchParams({
    latitude: opts.lat.toFixed(5),
    longitude: opts.lon.toFixed(5),
    daily: "temperature_2m_max",
    models: "gfs025",
    timezone: opts.timezone,
    forecast_days: String(FORECAST_DAYS),
    temperature_unit: opts.unit === "F" ? "fahrenheit" : "celsius",
    cell_selection: "nearest",
  });
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?${params.toString()}`;
  const data = await withRetry(() => fetchJson<EnsembleResponse>(url, { timeoutMs: 25_000 }));
  if (data.error) throw new Error(data.reason || "GEFS Open-Meteo error");
  return data;
}

export async function fetchGefsDaily(opts: GefsOpts): Promise<GefsPack> {
  try {
    return await cached(gefsKey(opts), ttlMsUntilNextCycle(), async () => {
      const res = await gefsRequest(opts);
      if (!res.daily?.temperature_2m_max?.length) {
        throw new Error("GEFS: pas de temperature_2m_max");
      }
      return packFromDaily(res.daily, opts);
    });
  } catch (err) {
    return emptyPack(opts, err instanceof Error ? err.message : String(err));
  }
}
