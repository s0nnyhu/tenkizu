import { cached } from "./cache";
import { fetchJson, withRetry } from "./http";
import type { MetarSnapshot, WxChip, WxOutlook } from "./types";

const WX_TTL_MS = 10 * 60_000;

type OmWx = {
  hourly?: {
    time?: string[];
    weather_code?: Array<number | null>;
    precipitation?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    cloud_cover?: Array<number | null>;
  };
  error?: boolean;
  reason?: string;
};

function localHour(timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  return Number(h);
}

function todayISO(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function metarPrecip(wx: string | null): "storm" | "rain" | "snow" | null {
  if (!wx) return null;
  const s = wx.toUpperCase();
  if (/\bTS|\bFC/.test(s)) return "storm";
  if (/\bSN|\bGS|\bGR|\bSG/.test(s)) return "snow";
  if (/\bRA|\bSH|\bDZ|\bUP/.test(s)) return "rain";
  return null;
}

function metarFog(wx: string | null): boolean {
  if (!wx) return false;
  return /\bFG|\bBR|\bHZ|\bFU/.test(wx.toUpperCase());
}

function metarCloudy(wx: string | null): boolean {
  if (!wx) return false;
  return /\bBKN|\bOVC|\bVV/.test(wx.toUpperCase());
}

function metarClear(wx: string | null): boolean {
  if (!wx) return false;
  return /\bCLR|\bSKC|\bCAVOK|\bNSC|\bFEW|\bSCT/.test(wx.toUpperCase());
}

export function buildWxOutlook(
  metar: MetarSnapshot | null,
  forecast: {
    times: string[];
    weather: Array<number | null>;
    precip: Array<number | null>;
    windKt: Array<number | null>;
  } | null,
  timeZone: string,
): WxOutlook {
  const chips: WxChip[] = [];
  const today = todayISO(timeZone);
  const hour = localHour(timeZone);

  const nowPrecip = metarPrecip(metar?.wx ?? null);
  if (nowPrecip === "storm") chips.push({ kind: "storm", label: "Orage en cours" });
  else if (nowPrecip === "snow") chips.push({ kind: "rain", label: "Neige en cours" });
  else if (nowPrecip === "rain") chips.push({ kind: "rain", label: "Pluie en cours" });
  else if (metarFog(metar?.wx ?? null)) chips.push({ kind: "fog", label: "Brouillard / brume" });
  else if (metarCloudy(metar?.wx ?? null)) chips.push({ kind: "cloud", label: "Nuageux" });
  else if (metarClear(metar?.wx ?? null)) chips.push({ kind: "fair", label: "Beau" });
  else {
    const codeNow = forecast
      ? forecast.weather.find((_, i) => {
          const t = forecast.times[i];
          return t.startsWith(today) && Number(t.slice(11, 13)) === hour;
        })
      : null;
    if (codeNow != null && codeNow >= 95) chips.push({ kind: "storm", label: "Orage" });
    else if (codeNow != null && codeNow >= 51) chips.push({ kind: "rain", label: "Averses" });
    else if (codeNow != null && codeNow >= 45) chips.push({ kind: "fog", label: "Brouillard" });
    else if (codeNow != null && codeNow >= 2) chips.push({ kind: "cloud", label: "Nuageux" });
    else chips.push({ kind: "fair", label: "Beau" });
  }

  let rainHour: number | null = null;
  let maxWind = metar?.windKt ?? null;
  if (forecast) {
    for (let i = 0; i < forecast.times.length; i++) {
      const t = forecast.times[i];
      if (!t.startsWith(today)) continue;
      const h = Number(t.slice(11, 13));
      if (h < hour) continue;
      const p = forecast.precip[i] ?? 0;
      const code = forecast.weather[i] ?? 0;
      const w = forecast.windKt[i];
      if (w != null && (maxWind == null || w > maxWind)) maxWind = w;
      if (rainHour == null && (p >= 0.2 || code >= 51)) rainHour = h;
    }
  }

  if (nowPrecip == null && rainHour != null) {
    chips.push({ kind: "rain", label: `Pluie vers ${String(rainHour).padStart(2, "0")}h` });
  } else if (nowPrecip != null && rainHour != null && rainHour > hour + 1) {
    chips.push({ kind: "rain", label: `Encore de la pluie vers ${String(rainHour).padStart(2, "0")}h` });
  }

  const windNow = metar?.windKt ?? null;
  const windShow = maxWind ?? windNow;
  if (windShow != null && windShow >= 22) {
    chips.push({ kind: "wind", label: `Beaucoup de vent · ${Math.round(windShow)} kt` });
  } else if (windShow != null && windShow >= 12) {
    chips.push({ kind: "wind", label: `Vent ${Math.round(windShow)} kt` });
  } else if (windNow != null) {
    chips.push({ kind: "fair", label: `Vent faible · ${Math.round(windNow)} kt` });
  }

  return {
    chips,
    summary: chips.map((c) => c.label).join(" · "),
  };
}

export async function fetchWxOutlook(opts: {
  icao: string;
  lat: number;
  lon: number;
  timezone: string;
  metar: MetarSnapshot | null;
}): Promise<WxOutlook> {
  const forecast = await cached(`wx-fc:${opts.icao}`, WX_TTL_MS, async () => {
    try {
      const params = new URLSearchParams({
        latitude: opts.lat.toFixed(4),
        longitude: opts.lon.toFixed(4),
        hourly: "weather_code,precipitation,wind_speed_10m",
        forecast_days: "2",
        timezone: opts.timezone,
        wind_speed_unit: "kn",
        models: "ecmwf_ifs",
        cell_selection: "nearest",
      });
      const data = await withRetry(() =>
        fetchJson<OmWx>(`https://api.open-meteo.com/v1/forecast?${params}`, { timeoutMs: 12_000 }),
      );
      if (data.error) throw new Error(data.reason || "Open-Meteo wx");
      const hourly = data.hourly;
      if (!hourly) return null;
      return {
        times: (hourly.time ?? []).map(String),
        weather: hourly.weather_code ?? [],
        precip: hourly.precipitation ?? [],
        windKt: hourly.wind_speed_10m ?? [],
      };
    } catch {
      return null;
    }
  });
  return buildWxOutlook(opts.metar, forecast, opts.timezone);
}
