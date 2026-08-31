import { cached } from "./cache";
import { fetchJson, fetchText } from "./http";
import { emptySlots, fillSlots } from "./hourly";
import type { TempUnit } from "./types";
import { toMarketUnit } from "./units";

const WU_TTL_MS = 10 * 60_000;
const KEY_TTL_MS = 12 * 3600_000;

function hourlyMax(slots: Array<number | null>): number | null {
  let max: number | null = null;
  for (const v of slots) {
    if (v != null && (max == null || v > max)) max = v;
  }
  return max;
}

export type WuDay = {
  forecastTmax: number | null;
  dailyTmax: number | null;
  dailyStatus: "ok" | "provisional" | "missing" | "error";
  hourly: Array<number | null>;
};

export type WuStation = {
  byDate: Record<string, WuDay>;
  fetchedAt: string;
  error?: string;
  selector: string;
};

export type WuResult = WuDay & { fetchedAt: string; error?: string; selector: string };

/**
 * Wunderground / weather.com.
 *
 * WU is an Angular SPA (no stable HTML table). The page embeds api.weather.com
 * URLs. We extract `apiKey` from WU HTML (`apiKey=`), then:
 *  - GET `/v3/wx/forecast/hourly/15day` → Tmax = max des heures (aligné tableau horaire)
 *  - GET `/v3/wx/forecast/daily/7day` → fallback si pas d’horaire
 *  - GET `/v3/wx/conditions/historical/dailysummary/30day` → temperatureMax observé
 *
 * Units requested in Celsius, converted to the market unit.
 * ToS: same endpoints the public site calls; personal/research. May 403.
 */
export const WU_SELECTOR =
  "WU HTML apiKey= + hourly/15day (max horaire) + daily/7day fallback + dailysummary/30day";

async function wuApiKey(): Promise<string> {
  return cached("wu:apikey", KEY_TTL_MS, async () => {
    const html = await fetchText("https://www.wunderground.com/", {
      timeoutMs: 12_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    const m = html.match(/apiKey=([A-Za-z0-9]{20,})/);
    if (!m) throw new Error("apiKey WU introuvable dans le HTML");
    return m[1];
  });
}

type DailyFc = {
  calendarDayTemperatureMax?: Array<number | null>;
  temperatureMax?: Array<number | null>;
  validTimeLocal?: string[];
};

function fromC(c: number | null | undefined, unit: TempUnit): number | null {
  if (c == null || !Number.isFinite(c)) return null;
  return toMarketUnit(c, unit);
}

export async function fetchWundergroundStation(opts: {
  icao: string;
  metarIcao: string;
  unit: TempUnit;
}): Promise<WuStation> {
  const stationId = opts.metarIcao && opts.icao !== "HKO" ? opts.metarIcao : opts.icao;
  return cached(`wu-st4:${stationId}:${opts.unit}`, WU_TTL_MS, async () => {
    const fetchedAt = new Date().toISOString();
    if (opts.icao === "HKO") {
      return {
        byDate: {},
        fetchedAt,
        error: "HKO ne cite pas Wunderground",
        selector: WU_SELECTOR,
      };
    }
    try {
      const apiKey = await wuApiKey();
      const common = `apiKey=${encodeURIComponent(apiKey)}&icaoCode=${encodeURIComponent(stationId)}&units=m&language=en-US&format=json`;
      const errors: string[] = [];
      const byDate: Record<string, WuDay> = {};

      const ensure = (date: string): WuDay => {
        if (!byDate[date]) {
          byDate[date] = {
            forecastTmax: null,
            dailyTmax: null,
            dailyStatus: "missing",
            hourly: emptySlots(),
          };
        }
        return byDate[date];
      };

      try {
        const fc = await fetchJson<DailyFc>(
          `https://api.weather.com/v3/wx/forecast/daily/7day?${common}`,
          { timeoutMs: 12_000 },
        );
        const times = fc.validTimeLocal ?? [];
        const highs = fc.calendarDayTemperatureMax ?? fc.temperatureMax ?? [];
        times.forEach((t, i) => {
          const date = t.slice(0, 10);
          ensure(date).forecastTmax = fromC(highs[i], opts.unit);
        });
      } catch (err) {
        errors.push(`daily/7day: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const hist = await fetchJson<DailyFc>(
          `https://api.weather.com/v3/wx/conditions/historical/dailysummary/30day?${common}`,
          { timeoutMs: 12_000 },
        );
        const times = hist.validTimeLocal ?? [];
        const highs = hist.temperatureMax ?? [];
        times.forEach((t, i) => {
          const date = t.slice(0, 10);
          const day = ensure(date);
          day.dailyTmax = fromC(highs[i], opts.unit);
          day.dailyStatus = day.dailyTmax != null ? "ok" : "missing";
        });
      } catch (err) {
        errors.push(`dailysummary: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const hr = await fetchJson<{ temperature?: Array<number | null>; validTimeLocal?: string[] }>(
          `https://api.weather.com/v3/wx/forecast/hourly/15day?${common}`,
          { timeoutMs: 12_000 },
        );
        const times = hr.validTimeLocal ?? [];
        const temps = hr.temperature ?? [];
        const dates = [...new Set(times.map((t) => t.slice(0, 10)))];
        for (const date of dates) {
          const day = ensure(date);
          day.hourly = fillSlots(times, temps, date, opts.unit, "last");
          const peak = hourlyMax(day.hourly);
          if (peak != null) day.forecastTmax = peak;
        }
      } catch (err) {
        errors.push(`hourly/15day: ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        byDate,
        fetchedAt,
        error: errors.length ? errors.join(" · ") : undefined,
        selector: WU_SELECTOR,
      };
    } catch (err) {
      return {
        byDate: {},
        fetchedAt,
        error: err instanceof Error ? err.message : String(err),
        selector: WU_SELECTOR,
      };
    }
  });
}

export async function fetchWunderground(opts: {
  icao: string;
  metarIcao: string;
  localDate: string;
  unit: TempUnit;
  hourlyUrl?: string | null;
  historyUrl?: string | null;
}): Promise<WuResult> {
  const pack = await fetchWundergroundStation({
    icao: opts.icao,
    metarIcao: opts.metarIcao,
    unit: opts.unit,
  });
  const day = pack.byDate[opts.localDate];
  return {
    forecastTmax: day?.forecastTmax ?? null,
    dailyTmax: day?.dailyTmax ?? null,
    dailyStatus: day?.dailyStatus ?? (pack.error ? "error" : "missing"),
    hourly: day?.hourly ?? emptySlots(),
    fetchedAt: pack.fetchedAt,
    error: pack.error,
    selector: pack.selector,
  };
}
