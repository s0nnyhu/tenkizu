import { cached } from "./cache";
import { chunk, fetchJson } from "./http";
import { localDateISO } from "./time";
import type { DailyObs, MetarSnapshot, TempUnit } from "./types";
import { toMarketUnit } from "./units";

const METAR_TTL_MS = 2 * 60_000;

type AwMetar = {
  icaoId?: string;
  obsTime?: number;
  reportTime?: string;
  temp?: number | null;
  wdir?: number | null;
  wspd?: number | null;
  cover?: string | null;
  wxString?: string | null;
  rawOb?: string | null;
  name?: string;
};

async function fetchMetars(ids: string[], hours: number): Promise<AwMetar[]> {
  if (!ids.length) return [];
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids.join(","))}&format=json&hours=${hours}`;
  const data = await fetchJson<AwMetar[] | AwMetar>(url, { timeoutMs: 20_000 });
  return Array.isArray(data) ? data : data ? [data] : [];
}

export type StationObsBundle = {
  last: MetarSnapshot | null;
  byDate: Record<string, DailyObs>;
  hourly: { localIso: string; tempMarket: number }[];
};

function wxText(row: AwMetar): string | null {
  return row.wxString || row.cover || null;
}

export async function fetchObsForStations(
  stations: { icao: string; metarIcao: string; timezone: string }[],
  unitByIcao: Record<string, TempUnit>,
): Promise<Record<string, StationObsBundle>> {
  const unique = [...new Map(stations.map((s) => [s.metarIcao, s])).values()];
  const key = `metar:${unique.map((s) => s.metarIcao).sort().join(",")}`;
  return cached(key, METAR_TTL_MS, async () => {
    const groups = chunk(unique, 20);
    const rows: AwMetar[] = [];
    for (const g of groups) {
      const ids = g.map((s) => s.metarIcao);
      rows.push(...(await fetchMetars(ids, 48)));
    }

    const byIcao = new Map<string, AwMetar[]>();
    for (const row of rows) {
      const id = (row.icaoId ?? "").toUpperCase();
      if (!id) continue;
      const list = byIcao.get(id) ?? [];
      list.push(row);
      byIcao.set(id, list);
    }

    const out: Record<string, StationObsBundle> = {};
    const now = Date.now();

    for (const st of stations) {
      const list = (byIcao.get(st.metarIcao) ?? []).slice().sort((a, b) => (b.obsTime ?? 0) - (a.obsTime ?? 0));
      const unit = unitByIcao[st.icao] ?? "C";
      const lastRow = list.find((r) => r.temp != null) ?? list[0] ?? null;
      const last: MetarSnapshot | null = lastRow
        ? {
            icao: st.metarIcao,
            obsTimeIso: lastRow.reportTime ?? (lastRow.obsTime ? new Date(lastRow.obsTime * 1000).toISOString() : ""),
            obsAgeMin: lastRow.obsTime ? Math.max(0, Math.round((now - lastRow.obsTime * 1000) / 60_000)) : 999,
            tempC: lastRow.temp ?? null,
            tempMarket: lastRow.temp == null ? null : toMarketUnit(lastRow.temp, unit),
            windDir: lastRow.wdir ?? null,
            windKt: lastRow.wspd ?? null,
            wx: wxText(lastRow),
            raw: lastRow.rawOb ?? null,
            fetchedAt: new Date(now).toISOString(),
          }
        : null;

      const hourly: { localIso: string; tempMarket: number }[] = [];
      const byDate: Record<string, DailyObs> = {};
      for (const row of list) {
        if (row.obsTime == null || row.temp == null) continue;
        const date = localDateISO(row.obsTime * 1000, st.timezone);
        const market = toMarketUnit(row.temp, unit);
        const localIso = new Intl.DateTimeFormat("sv-SE", {
          timeZone: st.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .format(new Date(row.obsTime * 1000))
          .replace(" ", "T");
        hourly.push({ localIso, tempMarket: market });
        const cur = byDate[date];
        if (!cur) {
          byDate[date] = {
            date,
            runningMaxMarket: market,
            runningMaxC: row.temp,
            nObs: 1,
            lastObsIso: new Date(row.obsTime * 1000).toISOString(),
            finalized: false,
            source: "METAR / ASOS",
          };
        } else {
          cur.nObs += 1;
          if (market > (cur.runningMaxMarket ?? -Infinity)) {
            cur.runningMaxMarket = market;
            cur.runningMaxC = row.temp;
          }
          const iso = new Date(row.obsTime * 1000).toISOString();
          if (!cur.lastObsIso || iso > cur.lastObsIso) cur.lastObsIso = iso;
        }
      }

      const dates = Object.keys(byDate).sort();
      for (const date of dates) {
        const next = dates.find((d) => d > date);
        byDate[date].finalized = Boolean(next);
      }

      out[st.icao] = { last, byDate, hourly };
    }
    return out;
  });
}

export function metarRawUrl(icao: string): string {
  return `https://aviationweather.gov/api/data/metar?ids=${icao}&hours=24&format=raw`;
}
