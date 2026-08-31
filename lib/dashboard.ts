import { fetchHko } from "./hko";
import { fetchObsForStations, metarRawUrl, type StationObsBundle } from "./metar";
import { fetchModelsForStation, fetchModelsForStations } from "./openmeteo";
import { fillWuHourlyUrl } from "./parse";
import { discoverHighestTempEvents } from "./polymarket";
import { resolveStation } from "./stations";
import { addDaysISO, horizonFor, todayISO } from "./time";
import type {
  Consensus,
  DashboardRow,
  HourlyDayGrid,
  HourlyRow,
  MarketStatus,
  ModelDayValue,
  ParsedEvent,
  SourceError,
  StationMeta,
  StationPayload,
  TempUnit,
} from "./types";
import { consensusOf, findBucket, marketFavorite, truncateTemp } from "./units";
import { fetchWundergroundStation, type WuStation } from "./wunderground";
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

function marketStatus(event: ParsedEvent, horizon: DashboardRow["horizon"], dailyFinalized: boolean): MarketStatus {
  if (event.closed) return "resolved";
  if (horizon === "past") return dailyFinalized ? "awaiting_daily" : "awaiting_daily";
  if (horizon === "later") return "upcoming";
  return "live";
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

export async function buildDashboard(): Promise<{
  rows: DashboardRow[];
  fetchedAt: string;
  marketCount: number;
  stationCount: number;
}> {
  const events = await discoverHighestTempEvents();
  const stationMap = await stationsFor(events);
  const withStation = events.filter((e) => stationMap.has(e.icao));

  const unitByIcao: Record<string, TempUnit> = {};
  for (const e of withStation) unitByIcao[e.icao] = e.unit;

  const stationList = [...stationMap.values()].map((s) => ({
    icao: s.icao,
    metarIcao: s.metarIcao,
    timezone: s.timezone,
  }));

  const obs = await fetchObsForStations(stationList, unitByIcao);

  const modelInputs = [...stationMap.values()].map((s) => {
    const today = todayISO(s.timezone);
    const dates = [addDaysISO(today, -1), today, addDaysISO(today, 1), addDaysISO(today, 2)];
    const running = obs[s.icao]?.byDate[today]?.runningMaxMarket ?? null;
    const unit = unitByIcao[s.icao] ?? "C";
    return {
      icao: s.icao,
      lat: s.lat,
      lon: s.lon,
      timezone: s.timezone,
      unit,
      dates,
      today,
      runningMaxJ: running,
    };
  });

  const models = await fetchModelsForStations(modelInputs);

  let hkoLast = null as Awaited<ReturnType<typeof fetchHko>> | null;
  if (stationMap.has("HKO")) {
    hkoLast = await fetchHko(unitByIcao.HKO ?? "C");
  }

  const wuByIcao: Record<string, WuStation> = {};
  await mapPool([...stationMap.values()], 6, async (s) => {
    wuByIcao[s.icao] = await fetchWundergroundStation({
      icao: s.icao,
      metarIcao: s.metarIcao,
      unit: unitByIcao[s.icao] ?? "C",
    });
  });

  const rows: DashboardRow[] = [];
  for (const event of events) {
    const st = stationMap.get(event.icao);
    const errors: SourceError[] = [];
    if (!st) {
      errors.push({ source: "station", message: `ICAO ${event.icao} non résolu` });
      rows.push(rowFromPartial(event, errors));
      continue;
    }
    const today = todayISO(st.timezone);
    const horizon = horizonFor(event.localDate, today);
    const bundle: StationObsBundle | undefined = obs[event.icao];
    let last = bundle?.last ?? null;
    let daily = bundle?.byDate[event.localDate] ?? null;
    if (event.icao === "HKO" && hkoLast) {
      if (hkoLast.error) errors.push({ source: "HKO", message: hkoLast.error });
      if (hkoLast.last) last = hkoLast.last;
      if (hkoLast.daily && hkoLast.daily.date === event.localDate) daily = hkoLast.daily;
    }
    const modelPack = models[event.icao];
    if (modelPack?.error) errors.push({ source: "Open-Meteo", message: modelPack.error });
    const dayModels = modelPack?.days[event.localDate] ?? [];

    const hourlyUrl = fillWuHourlyUrl(event.wuHourlyUrlTemplate, event.localDate);
    const historyUrl = event.wuHistoryUrl
      ? `${event.wuHistoryUrl.replace(/\/$/, "")}/date/${event.localDate}`
      : null;
    const wuPack = wuByIcao[event.icao];
    const wuDay = wuPack?.byDate[event.localDate];
    if (wuPack?.error) errors.push({ source: "Wunderground", message: wuPack.error });

    const runningMax = daily?.runningMaxMarket ?? null;
    const wuForecast = wuDay?.forecastTmax ?? null;
    const consensus = consensusFrom(dayModels, wuForecast, true);
    const consensusBucket = findBucket(event.buckets, consensus.meanTrunc);
    const wuBucket = findBucket(event.buckets, wuForecast == null ? null : truncateTemp(wuForecast));
    const runningBucket = findBucket(event.buckets, runningMax == null ? null : truncateTemp(runningMax));
    const mktFav = marketFavorite(event.buckets);

    rows.push({
      slug: event.slug,
      eventId: event.eventId,
      city: event.city,
      icao: event.icao,
      metarIcao: event.metarIcao,
      localDate: event.localDate,
      horizon,
      unit: event.unit,
      timezone: st.timezone,
      country: st.country,
      region: st.region,
      volume: event.volume,
      status: marketStatus(event, horizon, Boolean(daily?.finalized)),
      polymarketUrl: event.polymarketUrl,
      resolutionKind: event.resolutionKind,
      resolutionUrl: event.resolutionUrl,
      wuHistoryUrl: historyUrl,
      wuHourlyUrl: hourlyUrl,
      metarRawUrl: metarRawUrl(event.metarIcao),
      stationName: st.name,
      lat: st.lat,
      lon: st.lon,
      lastMetar: last,
      runningMax,
      runningMaxFinalized: Boolean(daily?.finalized),
      wuForecastTmax: wuForecast,
      wuForecastTmaxTrunc: wuForecast == null ? null : truncateTemp(wuForecast),
      wuDailyTmax: wuDay?.dailyTmax ?? null,
      wuDailyStatus: wuDay?.dailyStatus ?? "missing",
      consensus,
      favoriteBucket: consensusBucket?.label ?? null,
      consensusBucket: consensusBucket?.label ?? null,
      wuBucket: wuBucket?.label ?? null,
      runningMaxBucket: runningBucket?.label ?? null,
      marketFavoriteBucket: mktFav?.label ?? null,
      buckets: event.buckets,
      models: dayModels,
      errors,
      metarAgeMin: last?.obsAgeMin ?? null,
      wuFetchedAt: wuPack?.fetchedAt ?? null,
      modelsFetchedAt: modelPack?.fetchedAt ?? null,
    });
  }

  return {
    rows,
    fetchedAt: new Date().toISOString(),
    marketCount: events.length,
    stationCount: stationMap.size,
  };
}

function rowFromPartial(event: ParsedEvent, errors: SourceError[]): DashboardRow {
  return {
    slug: event.slug,
    eventId: event.eventId,
    city: event.city,
    icao: event.icao,
    metarIcao: event.metarIcao,
    localDate: event.localDate,
    horizon: "later",
    unit: event.unit,
    timezone: "UTC",
    country: "",
    region: "Autre",
    volume: event.volume,
    status: event.closed ? "resolved" : "upcoming",
    polymarketUrl: event.polymarketUrl,
    resolutionKind: event.resolutionKind,
    resolutionUrl: event.resolutionUrl,
    wuHistoryUrl: event.wuHistoryUrl,
    wuHourlyUrl: fillWuHourlyUrl(event.wuHourlyUrlTemplate, event.localDate),
    metarRawUrl: metarRawUrl(event.metarIcao),
    stationName: event.icao,
    lat: 0,
    lon: 0,
    lastMetar: null,
    runningMax: null,
    runningMaxFinalized: false,
    wuForecastTmax: null,
    wuForecastTmaxTrunc: null,
    wuDailyTmax: null,
    wuDailyStatus: "missing",
    consensus: { mean: null, median: null, min: null, max: null, n: 0, meanTrunc: null, includesWu: false },
    favoriteBucket: null,
    consensusBucket: null,
    wuBucket: null,
    runningMaxBucket: null,
    marketFavoriteBucket: marketFavorite(event.buckets)?.label ?? null,
    buckets: event.buckets,
    models: [],
    errors,
    metarAgeMin: null,
    wuFetchedAt: null,
    modelsFetchedAt: null,
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
  const modelPack = await fetchModelsForStation({
    icao: station.icao,
    lat: station.lat,
    lon: station.lon,
    timezone: station.timezone,
    unit,
    dates: [addDaysISO(today, -1), ...dates],
    today,
    runningMaxJ: runningJ,
  });
  if (modelPack.error) errors.push({ source: "Open-Meteo", message: modelPack.error });

  const [wuPack, wxOutlook] = await Promise.all([
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
  ]);
  if (wuPack.error) errors.push({ source: "Wunderground", message: wuPack.error });

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
