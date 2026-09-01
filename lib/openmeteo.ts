import { cacheGet, cacheSet, cached } from "./cache";
import { chunk, fetchJson, withRetry } from "./http";
import { ALL_OPEN_METEO_IDS, MODELS, estimateRun, type ModelDef } from "./models";
import { hourFromLocalIso } from "./time";
import { fillSlots } from "./hourly";
import type { ModelDayValue, ModelStatus, TempUnit } from "./types";
import { toMarketUnit, truncateTemp } from "./units";

const OM_TTL_MS = 15 * 60_000;
const FORECAST_DAYS = 4;

type OmHourly = Record<string, Array<number | string | null>>;

type OmResponse = {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  hourly?: OmHourly;
  error?: boolean;
  reason?: string;
};

export type OmHourlyPack = {
  days: Record<string, ModelDayValue[]>;
  hourly: { time: string[]; gfs: Array<number | null>; ecmwf: Array<number | null> };
  hourlyByDate: Record<string, Record<string, Array<number | null>>>;
  fetchedAt: string;
  error?: string;
};

function hourlyKey(omId: string): string {
  return `temperature_2m_${omId}`;
}

function seriesFor(hourly: OmHourly | undefined, omId: string): Array<number | null> {
  if (!hourly) return [];
  const raw = hourly[hourlyKey(omId)] ?? hourly.temperature_2m;
  if (!raw) return [];
  return raw.map((v) => (typeof v === "number" ? v : null));
}

function tmaxForDay(
  times: string[],
  temps: Array<number | null>,
  date: string,
  unit: TempUnit,
): { tmax: number; peakLocal: string } | null {
  let best: number | null = null;
  let peak = "";
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!t.startsWith(date)) continue;
    const v = temps[i];
    if (v == null) continue;
    const market = toMarketUnit(v, unit);
    if (best === null || market > best) {
      best = market;
      peak = hourFromLocalIso(t);
    }
  }
  if (best === null) return null;
  return { tmax: best, peakLocal: peak };
}

function statusFor(def: ModelDef, dayHas: boolean, anyDayHas: boolean): ModelStatus {
  if (dayHas) return "ok";
  if (anyDayHas) return "out_of_horizon";
  return def.coverage === "global" ? "unavailable" : "out_of_domain";
}

function pickSubmodel(
  def: ModelDef,
  hourly: OmHourly,
  times: string[],
  date: string,
): { omId: string; temps: Array<number | null> } | null {
  for (const omId of def.openMeteoIds) {
    const temps = seriesFor(hourly, omId);
    if (!temps.length) continue;
    const has = times.some((t, i) => t.startsWith(date) && temps[i] != null);
    if (has) return { omId, temps };
  }
  for (const omId of def.openMeteoIds) {
    const temps = seriesFor(hourly, omId);
    if (temps.some((v) => v != null)) return { omId, temps };
  }
  return null;
}

function buildDays(
  hourly: OmHourly | undefined,
  dates: string[],
  unit: TempUnit,
  runningMaxJ: number | null,
  today: string,
): ModelDayValue[] {
  const times = (hourly?.time ?? []).map(String);
  const out: ModelDayValue[] = [];
  for (const def of MODELS) {
    const run = estimateRun(def);
    const anyPick = pickSubmodel(def, hourly ?? {}, times, dates[0] ?? "");
    const anyDayHas = Boolean(
      anyPick && dates.some((d) => tmaxForDay(times, anyPick.temps, d, unit)),
    );
    for (const date of dates) {
      const pick = pickSubmodel(def, hourly ?? {}, times, date);
      const day = pick ? tmaxForDay(times, pick.temps, date, unit) : null;
      const st = statusFor(def, Boolean(day), anyDayHas);
      const beaten =
        date === today &&
        runningMaxJ != null &&
        day != null &&
        runningMaxJ > day.tmax + 1e-6;
      out.push({
        modelId: def.id,
        label: def.label,
        group: def.group,
        submodel: pick && def.openMeteoIds.length > 1 ? pick.omId : null,
        tmax: day?.tmax ?? null,
        tmaxTrunc: day ? truncateTemp(day.tmax) : null,
        peakLocal: day?.peakLocal ?? null,
        status: st,
        runLabel: st === "ok" ? run.runUtc : null,
        runAgeHours: st === "ok" ? run.ageHours : null,
        beatenByMetar: beaten,
      });
    }
  }
  return out;
}

async function omRequest(
  latitudes: number[],
  longitudes: number[],
  timezone: string,
): Promise<OmResponse[]> {
  const params = new URLSearchParams({
    latitude: latitudes.map((v) => v.toFixed(4)).join(","),
    longitude: longitudes.map((v) => v.toFixed(4)).join(","),
    hourly: "temperature_2m",
    forecast_days: String(FORECAST_DAYS),
    past_days: "1",
    timezone,
    models: ALL_OPEN_METEO_IDS.join(","),
    cell_selection: "nearest",
    temperature_unit: "celsius",
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const data = await withRetry(() => fetchJson<OmResponse | OmResponse[]>(url, { timeoutMs: 30_000 }));
  const list = Array.isArray(data) ? data : [data];
  const failed = list.find((r) => r.error);
  if (failed) throw new Error(failed.reason || "Open-Meteo error");
  return list;
}

function packFromHourly(hourly: OmHourly | undefined, opts: StationOmOpts): OmHourlyPack {
  const daysList = buildDays(hourly, opts.dates, opts.unit, opts.runningMaxJ, opts.today);
  const byDate: Record<string, ModelDayValue[]> = {};
  for (const date of opts.dates) byDate[date] = [];
  const nDates = opts.dates.length;
  const nModels = MODELS.length;
  for (let mi = 0; mi < nModels; mi++) {
    for (let di = 0; di < nDates; di++) {
      const val = daysList[mi * nDates + di];
      if (val) byDate[opts.dates[di]].push(val);
    }
  }
  const times = (hourly?.time ?? []).map(String);
  return {
    days: byDate,
    hourly: {
      time: times,
      gfs: seriesFor(hourly, "gfs013").map((v) => (v == null ? null : toMarketUnit(v, opts.unit))),
      ecmwf: seriesFor(hourly, "ecmwf_ifs").map((v) =>
        v == null ? null : toMarketUnit(v, opts.unit),
      ),
    },
    hourlyByDate: hourlyByDateFrom(hourly, opts.dates, opts.unit),
    fetchedAt: new Date().toISOString(),
  };
}

function emptyPack(opts: StationOmOpts, message: string): OmHourlyPack {
  const empty: Record<string, ModelDayValue[]> = {};
  for (const date of opts.dates) {
    empty[date] = MODELS.map((def) => ({
      modelId: def.id,
      label: def.label,
      group: def.group,
      submodel: null,
      tmax: null,
      tmaxTrunc: null,
      peakLocal: null,
      status: "error" as const,
      runLabel: null,
      runAgeHours: null,
      beatenByMetar: false,
    }));
  }
  return {
    days: empty,
    hourly: { time: [], gfs: [], ecmwf: [] },
    hourlyByDate: Object.fromEntries(opts.dates.map((d) => [d, {}])),
    fetchedAt: new Date().toISOString(),
    error: message,
  };
}

type StationOmOpts = {
  icao: string;
  lat: number;
  lon: number;
  timezone: string;
  unit: TempUnit;
  dates: string[];
  today: string;
  runningMaxJ: number | null;
};

function omKey(opts: StationOmOpts): string {
  return `om6:${opts.icao}:${opts.unit}:${opts.dates.join(",")}`;
}

export async function fetchModelsForStation(opts: StationOmOpts): Promise<OmHourlyPack> {
  try {
    return await cached(omKey(opts), OM_TTL_MS, async () => {
      const [res] = await omRequest([opts.lat], [opts.lon], opts.timezone);
      return packFromHourly(res?.hourly, opts);
    });
  } catch (err) {
    return emptyPack(opts, err instanceof Error ? err.message : String(err));
  }
}

export async function fetchModelsForStations(
  stations: StationOmOpts[],
): Promise<Record<string, OmHourlyPack>> {
  const unique = [...new Map(stations.map((s) => [s.icao, s])).values()];
  const out: Record<string, OmHourlyPack> = {};
  const missing: StationOmOpts[] = [];
  for (const s of unique) {
    const hit = cacheGet<OmHourlyPack>(omKey(s));
    if (hit && !hit.error) out[s.icao] = hit;
    else missing.push(s);
  }

  const byTz = new Map<string, StationOmOpts[]>();
  for (const s of missing) {
    const list = byTz.get(s.timezone) ?? [];
    list.push(s);
    byTz.set(s.timezone, list);
  }

  for (const [tz, group] of byTz) {
    for (const batch of chunk(group, 6)) {
      try {
        const list = await omRequest(
          batch.map((s) => s.lat),
          batch.map((s) => s.lon),
          tz,
        );
        batch.forEach((s, i) => {
          const pack = packFromHourly(list[i]?.hourly, s);
          cacheSet(omKey(s), pack, OM_TTL_MS);
          out[s.icao] = pack;
        });
      } catch {
        for (const s of batch) {
          out[s.icao] = await fetchModelsForStation(s);
        }
      }
    }
  }

  for (const s of unique) {
    if (!out[s.icao]) out[s.icao] = emptyPack(s, "Open-Meteo indisponible");
  }
  return out;
}

function hourlyByDateFrom(
  hourly: OmHourly | undefined,
  dates: string[],
  unit: TempUnit,
): Record<string, Record<string, Array<number | null>>> {
  const times = (hourly?.time ?? []).map(String);
  const out: Record<string, Record<string, Array<number | null>>> = {};
  for (const date of dates) {
    out[date] = {};
    for (const def of MODELS) {
      const pick = pickSubmodel(def, hourly ?? {}, times, date);
      out[date][def.id] = pick ? fillSlots(times, pick.temps, date, unit, "last") : fillSlots(times, [], date, unit);
    }
  }
  return out;
}
