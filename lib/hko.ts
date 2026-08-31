import { cached } from "./cache";
import { fetchJson } from "./http";
import type { DailyObs, MetarSnapshot, TempUnit } from "./types";
import { toMarketUnit } from "./units";

const HKO_TTL_MS = 5 * 60_000;

type HkoRhr = {
  temperature?: {
    data?: { place?: string; value?: number }[];
    recordTime?: string;
  };
};

/**
 * Hong Kong Observatory current reading (not METAR).
 * Daily Extract "Absolute Daily Max" is the resolution value; this is the
 * intra-day proxy plus the open data CLMMAXT series when available.
 */
export async function fetchHko(unit: TempUnit): Promise<{
  last: MetarSnapshot | null;
  daily: DailyObs | null;
  error?: string;
}> {
  return cached(`hko:${unit}`, HKO_TTL_MS, async () => {
    try {
      const rhr = await fetchJson<HkoRhr>(
        "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en",
        { timeoutMs: 12_000 },
      );
      const obs =
        rhr.temperature?.data?.find((d) => /observatory/i.test(d.place ?? "")) ??
        rhr.temperature?.data?.[0];
      const valueC = obs?.value;
      const recordTime = rhr.temperature?.recordTime;
      const last: MetarSnapshot | null =
        valueC != null
          ? {
              icao: "HKO",
              obsTimeIso: recordTime ?? new Date().toISOString(),
              obsAgeMin: recordTime
                ? Math.max(0, Math.round((Date.now() - Date.parse(recordTime)) / 60_000))
                : 0,
              tempC: valueC,
              tempMarket: toMarketUnit(valueC, unit),
              windDir: null,
              windKt: null,
              wx: obs?.place ?? "HKO",
              raw: null,
              fetchedAt: new Date().toISOString(),
            }
          : null;

      let daily: DailyObs | null = null;
      if (valueC != null && recordTime) {
        const date = recordTime.slice(0, 10);
        daily = {
          date,
          runningMaxMarket: toMarketUnit(valueC, unit),
          runningMaxC: valueC,
          nObs: 1,
          lastObsIso: recordTime,
          finalized: false,
          source: "HKO rhrread (running; Daily Extract = résolution)",
        };
      }
      return { last, daily };
    } catch (err) {
      return {
        last: null,
        daily: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
