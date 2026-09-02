import { fetchJson, fetchText, HttpError, mapPool } from "./http";

export type LatestMetar = {
  icao: string;
  tempC: number | null;
  raw: string | null;
  obsTimeIso: string | null;
  obsAgeMin: number | null;
  source: "tgftp" | "aviationweather" | null;
};

/** Prefer RMK Txxxx (0.1 °C), else the TT/Td group. */
export function parseMetarTempC(raw: string): number | null {
  const t = raw.match(/\bT([01])(\d{3})[01]\d{3}\b/);
  if (t) {
    const sign = t[1] === "1" ? -1 : 1;
    return (sign * Number(t[2])) / 10;
  }
  const m = raw.match(/(?:^|\s)(M?\d{2})\/(M?\d{2}|\/\/)(?:\s|$)/);
  if (!m) return null;
  return m[1].startsWith("M") ? -Number(m[1].slice(1)) : Number(m[1]);
}

function parseTgftpStamp(header: string): Date | null {
  const m = header.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
}

function ageMin(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 60_000));
}

async function fromTgftp(icao: string, now: number): Promise<LatestMetar> {
  const url = `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`;
  const text = await fetchText(url, { timeoutMs: 8_000, accept: "text/plain" });
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const stamp = lines[0] ? parseTgftpStamp(lines[0]) : null;
  const raw = lines.find((l) => l.startsWith(icao)) ?? lines[1] ?? lines[0] ?? "";
  const obsTimeIso = stamp ? stamp.toISOString() : null;
  return {
    icao,
    tempC: parseMetarTempC(raw),
    raw,
    obsTimeIso,
    obsAgeMin: ageMin(obsTimeIso, now),
    source: "tgftp",
  };
}

async function fromAviationWeather(icao: string, now: number): Promise<LatestMetar> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&hours=2`;
  const data = await fetchJson<Array<{ temp?: number | null; rawOb?: string; obsTime?: number; reportTime?: string }>>(
    url,
    { timeoutMs: 8_000 },
  );
  const row = Array.isArray(data) ? data[0] : null;
  const raw = row?.rawOb ?? "";
  const fromRaw = raw ? parseMetarTempC(raw) : null;
  const tempC = fromRaw ?? (typeof row?.temp === "number" ? row.temp : null);
  const obsTimeIso = row?.reportTime
    ?? (row?.obsTime ? new Date(row.obsTime * 1000).toISOString() : null);
  return {
    icao,
    tempC,
    raw: raw || null,
    obsTimeIso,
    obsAgeMin: ageMin(obsTimeIso, now),
    source: "aviationweather",
  };
}

async function fetchOne(icao: string): Promise<LatestMetar> {
  const now = Date.now();
  try {
    const hit = await fromTgftp(icao, now);
    if (hit.tempC != null) return hit;
  } catch (err) {
    if (!(err instanceof HttpError || err instanceof Error)) throw err;
  }
  try {
    return await fromAviationWeather(icao, now);
  } catch {
    return { icao, tempC: null, raw: null, obsTimeIso: null, obsAgeMin: null, source: null };
  }
}

export async function fetchLatestMetars(icaos: string[]): Promise<Record<string, LatestMetar>> {
  const ids = [...new Set(icaos.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{3,4}$/.test(s)))].slice(0, 16);
  const out: Record<string, LatestMetar> = {};
  await mapPool(ids, 6, async (icao) => {
    out[icao] = await fetchOne(icao);
  });
  return out;
}
