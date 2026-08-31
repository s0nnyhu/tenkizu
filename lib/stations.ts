import tzlookup from "tz-lookup";
import { cached } from "./cache";
import { fetchJson } from "./http";
import type { StationMeta } from "./types";

const HKO: StationMeta = {
  icao: "HKO",
  metarIcao: "VHHH",
  name: "Hong Kong Observatory",
  lat: 22.3019,
  lon: 114.1743,
  elevM: 32,
  country: "HK",
  region: "Asie",
  timezone: "Asia/Hong_Kong",
  site: "Hong Kong Observatory",
};

const REGION_BY_CC: Record<string, string> = {
  US: "Amériques", CA: "Amériques", MX: "Amériques", BR: "Amériques",
  AR: "Amériques", CL: "Amériques", CO: "Amériques", PE: "Amériques",
  GB: "Europe", FR: "Europe", DE: "Europe", IT: "Europe", ES: "Europe",
  NL: "Europe", PL: "Europe", FI: "Europe", SE: "Europe", NO: "Europe",
  IE: "Europe", PT: "Europe", AT: "Europe", CH: "Europe", BE: "Europe",
  DK: "Europe", CZ: "Europe", GR: "Europe", RO: "Europe", HU: "Europe",
  UA: "Europe", RU: "Europe", TR: "Europe", RS: "Europe", HR: "Europe",
  CN: "Asie", JP: "Asie", KR: "Asie", HK: "Asie", TW: "Asie", SG: "Asie",
  IN: "Asie", TH: "Asie", VN: "Asie", MY: "Asie", PH: "Asie", ID: "Asie",
  AE: "Moyen-Orient", SA: "Moyen-Orient", IL: "Moyen-Orient", QA: "Moyen-Orient",
  AU: "Pacifique", NZ: "Pacifique",
  ZA: "Afrique", EG: "Afrique", NG: "Afrique", KE: "Afrique", MA: "Afrique",
};

type AwStation = {
  icaoId?: string;
  iataId?: string;
  site?: string;
  lat?: number;
  lon?: number;
  elev?: number;
  country?: string;
  state?: string;
  name?: string;
};

function regionOf(cc: string): string {
  return REGION_BY_CC[cc.toUpperCase()] ?? "Autre";
}

function timezoneOf(lat: number, lon: number): string {
  try {
    return tzlookup(lat, lon);
  } catch {
    return "UTC";
  }
}

async function fetchStationInfo(icao: string): Promise<AwStation | null> {
  const url = `https://aviationweather.gov/api/data/stationinfo?ids=${encodeURIComponent(icao)}&format=json`;
  const data = await fetchJson<AwStation[] | AwStation>(url, { timeoutMs: 15_000 });
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

export async function resolveStation(icao: string, metarIcao: string): Promise<StationMeta> {
  if (icao === "HKO") return HKO;
  return cached(`station:${icao}`, 24 * 3600_000, async () => {
    const info = await fetchStationInfo(metarIcao || icao);
    if (!info || info.lat == null || info.lon == null) {
      throw new Error(`Station ICAO introuvable: ${icao}`);
    }
    const cc = (info.country ?? "").toUpperCase();
    return {
      icao,
      metarIcao: metarIcao || icao,
      name: info.site || info.name || icao,
      lat: info.lat,
      lon: info.lon,
      elevM: info.elev ?? null,
      country: cc,
      region: regionOf(cc),
      timezone: timezoneOf(info.lat, info.lon),
      site: info.site || info.name || icao,
    };
  });
}
