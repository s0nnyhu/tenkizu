import { fetchHko } from "./hko";
import { fetchObsForStations, metarRawUrl, type StationObsBundle } from "./metar";
import { fetchGefsDaily } from "./gefs";
import { fetchModelsForStation } from "./openmeteo";
import { fillWuHourlyUrl } from "./parse";
import { discoverHighestTempEvents } from "./polymarket";
import { resolveStation } from "./stations";
import { addDaysISO, horizonFor, todayISO } from "./time";
import type {
  Consensus,
  HourlyDayGrid,
  HourlyRow,
  ModelDayValue,
  ParsedEvent,
  SourceError,
  StationIndexItem,
  StationMeta,
  StationPayload,
  TempUnit,
} from "./types";
import { consensusOf, findBucket, marketFavorite, truncateTemp } from "./units";
import { fetchWundergroundStation } from "./wunderground";
import { fetchWxOutlook } from "./wx";
import { mapPool } from "./http";
import { MODELS } from "./models";
import { emptySlots, HOURS_24 } from "./hourly";

function consensusFrom(models: ModelDayValue[], wuTmax: number | null, includeWu: boolean): Consensus {
  const vals = models
    .filter((m) => m.modelId !== "cma" && m.status === "ok" && m.tmax != null)
    .map((m) => m.tmax as number);
  if (includeWu && wuTmax != null) vals.push(wuTmax);
  const c = consensusOf(vals);
  return { ...c, includesWu: includeWu && wuTmax != null };
}

async function stationsFor(events: ParsedEvent[]): Promise<Map<string, StationMeta>> {
  const uniq = [...new Map(events.map((e) => [e.icao, e])).values()];
  const metas = await mapPool(uniq, 8, async (e) => {
    try {
      return await resolveStation(e.icao, e.metarIcao);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        icao: e.icao,
      } as const;
    }
  });
  const map = new Map<string, StationMeta>();
  for (const m of metas) {
    if ("error" in m) continue;
    map.set(m.icao, m);
  }
  return map;
}

export async function buildStationIndex(): Promise<{
  stations: StationIndexItem[];
  fetchedAt: string;
  marketCount: number;
  stationCount: number;
}> {
  const events = await discoverHighestTempEvents();
  const stationMap = await stationsFor(events);
  const byIcao = new Map<string, StationIndexItem>();
  for (const e of events) {
    if (!e.icao || byIcao.has(e.icao)) continue;
    const st = stationMap.get(e.icao);
    byIcao.set(e.icao, {
      icao: e.icao,
      city: e.city,
      stationName: st?.name ?? e.icao,
      country: st?.country ?? "",
    });
  }
  const stations = [...byIcao.values()].sort((a, b) => a.city.localeCompare(b.city, "fr"));
  return {
    stations,
    fetchedAt: new Date().toISOString(),
    marketCount: events.length,
    stationCount: stations.length,
  };
}

export async function buildStation(icaoParam: string): Promise<StationPayload> {
  const icao = icaoParam.toUpperCase();
  const events = (await discoverHighestTempEvents()).filter((e) => e.icao === icao);
  if (!events.length) {
    throw new Error(`Aucun marché actif pour ${icao}`);
  }
  const primary = events[0];
  const station = await resolveStation(icao, primary.metarIcao);
  const today = todayISO(station.timezone);
  const dates = [today, addDaysISO(today, 1), addDaysISO(today, 2)];
  const unit = primary.unit;

  const obs = await fetchObsForStations(
    [{ icao: station.icao, metarIcao: station.metarIcao, timezone: station.timezone }],
    { [station.icao]: unit },
  );
  const bundle = obs[station.icao];
  let last = bundle?.last ?? null;
  const errors: SourceError[] = [];

  if (icao === "HKO") {
    const hko = await fetchHko(unit);
    if (hko.error) errors.push({ source: "HKO", message: hko.error });
    if (hko.last) last = hko.last;
  }

  const runningJ = bundle?.byDate[today]?.runningMaxMarket ?? null;
  const [modelPack, wuPack, wxOutlook, gefsPack] = await Promise.all([
    fetchModelsForStation({
      icao: station.icao,
      lat: station.lat,
      lon: station.lon,
      timezone: station.timezone,
      unit,
      dates: [addDaysISO(today, -1), ...dates],
      today,
      runningMaxJ: runningJ,
    }),
    fetchWundergroundStation({
      icao: station.icao,
      metarIcao: station.metarIcao,
      unit,
    }),
    fetchWxOutlook({
      icao: station.icao,
      lat: station.lat,
      lon: station.lon,
      timezone: station.timezone,
      metar: last,
    }),
    fetchGefsDaily({
      icao: station.icao,
      lat: station.lat,
      lon: station.lon,
      timezone: station.timezone,
      unit,
      dates,
    }),
  ]);
  if (modelPack.error) errors.push({ source: "Open-Meteo", message: modelPack.error });
  if (wuPack.error) errors.push({ source: "Wunderground", message: wuPack.error });
  if (gefsPack.error) errors.push({ source: "GEFS", message: gefsPack.error });

  const days = dates.map((date) => {
    const event = events.find((e) => e.localDate === date) ?? null;
    const wu = wuPack.byDate[date];
    const dayModels = modelPack.days[date] ?? [];
    const consensus = consensusFrom(dayModels, wu?.forecastTmax ?? null, true);
    return {
      localDate: date,
      horizon: horizonFor(date, today),
      market: event,
      runningMax: bundle?.byDate[date] ?? null,
      wuForecastTmax: wu?.forecastTmax ?? null,
      wuDailyTmax: wu?.dailyTmax ?? null,
      wuDailyStatus: wu?.dailyStatus ?? (wuPack.error ? "error" : "missing"),
      consensus,
      models: dayModels,
      buckets: event?.buckets ?? [],
      gefs: gefsPack.byDate[date] ?? null,
    };
  });

  const times = modelPack.hourly.time;
  const metarByHour = new Map<string, number>();
  for (const pt of bundle?.hourly ?? []) {
    if (!pt.localIso.startsWith(today)) continue;
    metarByHour.set(pt.localIso.slice(0, 13), pt.tempMarket);
  }
  const hourlyJ = times
    .map((t, i) => ({
      time: t,
      gfs: modelPack.hourly.gfs[i] ?? null,
      ecmwf: modelPack.hourly.ecmwf[i] ?? null,
      metar: metarByHour.get(t.slice(0, 13)) ?? null,
    }))
    .filter((p) => p.time.startsWith(today));

  const hourlyDays: HourlyDayGrid[] = dates.map((date) => {
    const metarSlots = emptySlots();
    for (const pt of bundle?.hourly ?? []) {
      if (!pt.localIso.startsWith(date)) continue;
      const h = Number(pt.localIso.slice(11, 13));
      if (h < 0 || h > 23) continue;
      if (metarSlots[h] == null) metarSlots[h] = pt.tempMarket;
    }
    const wuHourly = wuPack.byDate[date]?.hourly ?? emptySlots();
    const modelHours = modelPack.hourlyByDate[date] ?? {};
    const rows: HourlyRow[] = [
      {
        id: "metar",
        label: "METAR",
        kind: "metar",
        temps: metarSlots,
        status: metarSlots.some((v) => v != null) ? "ok" : "unavailable",
      },
      {
        id: "wu",
        label: "Wunderground",
        kind: "wu",
        temps: wuHourly,
        status: wuHourly.some((v) => v != null) ? "ok" : "unavailable",
      },
    ];
    for (const def of MODELS) {
      const dayModel = (modelPack.days[date] ?? []).find((m) => m.modelId === def.id);
      rows.push({
        id: def.id,
        label: def.label,
        kind: def.group,
        temps: modelHours[def.id] ?? emptySlots(),
        status: dayModel?.status ?? "error",
      });
    }
    return {
      date,
      horizon: horizonFor(date, today),
      hours: HOURS_24,
      rows,
    };
  });

  const jEvent = events.find((e) => e.localDate === today) ?? events[0];
  const hourlyUrl = fillWuHourlyUrl(jEvent.wuHourlyUrlTemplate, today);
  const historyUrl = jEvent.wuHistoryUrl
    ? `${jEvent.wuHistoryUrl.replace(/\/$/, "")}/date/${today}`
    : null;

  return {
    station,
    unit,
    days,
    lastMetar: last,
    wxOutlook,
    hourlyJ,
    hourlyDays,
    errors,
    polymarketUrl: jEvent.polymarketUrl,
    resolutionUrl: jEvent.resolutionUrl,
    wuHistoryUrl: historyUrl,
    wuHourlyUrl: hourlyUrl,
    metarRawUrl: metarRawUrl(station.metarIcao),
    fetchedAt: new Date().toISOString(),
  };
}
