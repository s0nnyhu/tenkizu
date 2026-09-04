import { fetchAwekasPws } from "./awekas";
import { cached } from "./cache";
import { mapPool } from "./http";
import type { PwsReading, TempUnit } from "./types";

const PWS_TTL_MS = 2 * 60_000;

/** URLs de stations perso, groupées par ICAO marché. */
export const PWS_STATIONS: Record<string, string[]> = {
  LFPB: ["https://www.awekas.at/fr/instrument.php?id=46887"],
  EHAM: ["https://www.awekas.at/fr/instrument.php?id=31057"],
  EDDM: ["https://www.awekas.at/fr/instrument.php?id=44077"],
};

function metaFromUrl(url: string): { id: string; source: string } {
  const u = new URL(url);
  const id = u.searchParams.get("id") ?? "";
  const source = u.hostname.replace(/^www\./, "");
  return { id, source };
}

async function fetchOne(url: string, unit: TempUnit): Promise<PwsReading> {
  const { id, source } = metaFromUrl(url);
  try {
    if (source === "awekas.at") {
      const hit = await fetchAwekasPws(url, unit);
      return { id, source, url, ...hit };
    }
    return {
      id,
      source,
      url,
      name: null,
      tempC: null,
      tempMarket: null,
      obsTimeIso: null,
      status: "error",
      error: `source PWS inconnue: ${source}`,
    };
  } catch (err) {
    return {
      id,
      source,
      url,
      name: null,
      tempC: null,
      tempMarket: null,
      obsTimeIso: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchPwsForIcao(icao: string, unit: TempUnit): Promise<PwsReading[]> {
  const urls = PWS_STATIONS[icao.toUpperCase()] ?? [];
  if (!urls.length) return [];
  return cached(`pws:${icao}:${unit}:${urls.join(",")}`, PWS_TTL_MS, () =>
    mapPool(urls, 3, (url) => fetchOne(url, unit)),
  );
}
