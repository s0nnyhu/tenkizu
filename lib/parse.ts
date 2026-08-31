import type { Bucket, ParsedEvent, ResolutionKind, TempUnit } from "./types";
import { wuDatePath } from "./time";

const TITLE_RE =
  /^Highest temperature in (.+?) on ([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\??$/i;

const SLUG_RE =
  /^(?:arch-)?highest-temperature-in-(.+)-on-([a-z]+)-(\d{1,2})(?:-(\d{4}))?$/i;

const DESC_DATE_RE = /on\s+(\d{1,2})\s+([A-Za-z]+)\s+'(\d{2})\b/i;

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function titleCaseCity(slugCity: string): string {
  return slugCity
    .split("-")
    .map((w) => (w.toLowerCase() === "nyc" ? "NYC" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function parseBucketLabel(label: string): {
  lo: number | null;
  hi: number | null;
  unit: TempUnit | null;
} {
  const compact = label.replace(/\s+/g, " ").trim();
  const unit: TempUnit | null = /°\s*F|\bF\b/i.test(compact)
    ? "F"
    : /°\s*C|\bC\b/i.test(compact)
      ? "C"
      : null;
  const n = String.raw`(-?\d+(?:\.\d+)?)`;

  let m = compact.match(new RegExp(`^${n}\\s*°?\\s*[CF]?\\s+or\\s+(below|lower|under)\\b`, "i"));
  if (m) return { lo: null, hi: Number(m[1]), unit };

  m = compact.match(new RegExp(`^${n}\\s*°?\\s*[CF]?\\s+or\\s+(higher|above|over|more)\\b`, "i"));
  if (m) return { lo: Number(m[1]), hi: null, unit };

  m = compact.match(new RegExp(`^${n}\\s*[-–—]\\s*${n}`));
  if (m) return { lo: Number(m[1]), hi: Number(m[2]), unit };

  m = compact.match(new RegExp(`^${n}`));
  if (m) return { lo: Number(m[1]), hi: Number(m[1]), unit };

  return { lo: null, hi: null, unit };
}

function wrhTimeseriesUrl(site: string, unit: TempUnit): string {
  const u = new URL("https://www.weather.gov/wrh/timeseries");
  u.searchParams.set("site", site.toUpperCase());
  u.searchParams.set("hours", "72");
  u.searchParams.set("units", unit === "F" ? "english" : "metric");
  u.searchParams.set("chart", "on");
  u.searchParams.set("headers", "on");
  u.searchParams.set("obs", "tabular");
  u.searchParams.set("hourly", "false");
  u.searchParams.set("pview", "standard");
  u.searchParams.set("font", "12");
  u.searchParams.set("plot", "");
  return u.toString();
}

function applyResolutionUnits(url: string, unit: TempUnit, icao: string | null): string {
  if (!url || !/weather\.gov\/wrh\/timeseries/i.test(url)) return url;
  let site = icao;
  try {
    site = new URL(url).searchParams.get("site") ?? icao;
  } catch {
    /* keep icao */
  }
  if (!site) return url;
  return wrhTimeseriesUrl(site, unit);
}

function extractIcao(description: string, resolutionSource: string): {
  icao: string | null;
  kind: ResolutionKind;
  resolutionUrl: string;
  wuHistoryUrl: string | null;
} {
  const blob = `${resolutionSource}\n${description}`;
  const urls = blob.match(/https?:\/\/[^\s)<>"']+/gi) ?? [];
  const cleaned = urls.map((u) => u.replace(/[.,;]+$/, ""));

  const wrh = cleaned.find((u) => /weather\.gov\/wrh\/timeseries/i.test(u));
  const wu = cleaned.find((u) => /wunderground\.com/i.test(u));
  const hko = cleaned.find((u) => /weather\.gov\.hk|hko\.gov\.hk/i.test(u));

  if (wrh) {
    const site = wrh.match(/[?&]site=([A-Za-z0-9]{3,5})/i)?.[1];
    return {
      icao: site ? site.toUpperCase() : null,
      kind: "noaa_wrh",
      resolutionUrl: wrh,
      wuHistoryUrl: wu ?? null,
    };
  }

  if (/hong kong observatory/i.test(blob) || hko) {
    return {
      icao: "HKO",
      kind: "hko",
      resolutionUrl: hko ?? "https://www.weather.gov.hk/en/cis/climat.htm",
      wuHistoryUrl: wu ?? null,
    };
  }

  if (wu) {
    const pathIcao = wu.match(/\/([A-Z][A-Z0-9]{3})(?:[/?#]|$)/i)?.[1];
    return {
      icao: pathIcao ? pathIcao.toUpperCase() : null,
      kind: "wunderground",
      resolutionUrl: wu,
      wuHistoryUrl: wu,
    };
  }

  const site = blob.match(/[?&]site=([A-Za-z0-9]{4})/i)?.[1];
  if (site) {
    return {
      icao: site.toUpperCase(),
      kind: "other",
      resolutionUrl: cleaned[0] ?? "",
      wuHistoryUrl: null,
    };
  }

  return {
    icao: null,
    kind: "other",
    resolutionUrl: cleaned[0] ?? resolutionSource ?? "",
    wuHistoryUrl: null,
  };
}

function wuHourlyTemplate(historyUrl: string | null, icao: string): string | null {
  if (historyUrl && /wunderground\.com\/history\/daily\//i.test(historyUrl)) {
    const base = historyUrl.replace(/\/history\/daily\//i, "/hourly/").replace(/[./]+$/, "");
    return `${base.replace(/\/$/, "")}/date/{date}`;
  }
  if (icao && icao !== "HKO") {
    return `https://www.wunderground.com/hourly/${icao}/date/{date}`;
  }
  return null;
}

function detectUnit(description: string, buckets: Bucket[]): TempUnit {
  if (/degrees\s+Fahrenheit|°F\b/i.test(description)) return "F";
  if (/degrees\s+Celsius|°C\b/i.test(description)) return "C";
  const fromBucket = buckets.find((b) => /°F/.test(b.label))
    ? "F"
    : buckets.find((b) => /°C/.test(b.label))
      ? "C"
      : null;
  return fromBucket ?? "C";
}

type GammaMarket = {
  id?: string;
  question?: string;
  groupItemTitle?: string;
  slug?: string;
  outcomes?: unknown;
  outcomePrices?: unknown;
  volume?: unknown;
  volumeNum?: unknown;
  closed?: boolean;
};

type GammaEvent = {
  id?: string;
  title?: string;
  slug?: string;
  description?: string;
  resolutionSource?: string;
  volume?: unknown;
  closed?: boolean;
  active?: boolean;
  markets?: GammaMarket[];
};

export function isHighestTempTitle(title: string): boolean {
  return /^Highest temperature in /i.test(title.trim());
}

export function parseEvent(event: GammaEvent): ParsedEvent | null {
  const title = (event.title ?? "").trim();
  const slug = (event.slug ?? "").trim();
  const description = event.description ?? "";
  if (!isHighestTempTitle(title) && !SLUG_RE.test(slug)) return null;

  const slugMatch = slug.match(SLUG_RE);
  const titleMatch = title.match(TITLE_RE);

  let city = "";
  let year = 0;
  let month = 0;
  let day = 0;

  if (slugMatch) {
    city = titleCaseCity(slugMatch[1]);
    month = MONTHS[slugMatch[2].toLowerCase()] ?? 0;
    day = Number(slugMatch[3]);
    if (slugMatch[4]) year = Number(slugMatch[4]);
  }
  if (titleMatch) {
    city = titleMatch[1].trim();
    month = MONTHS[titleMatch[2].toLowerCase()] ?? month;
    day = Number(titleMatch[3]) || day;
    if (titleMatch[4]) year = Number(titleMatch[4]);
  }
  const descDate = description.match(DESC_DATE_RE);
  if (descDate) {
    day = day || Number(descDate[1]);
    month = month || MONTHS[descDate[2].toLowerCase()] || 0;
    if (!year) {
      const yy = Number(descDate[3]);
      year = yy < 100 ? 2000 + yy : yy;
    }
  }
  if (!city || !year || !month || !day) return null;

  const localDate = `${year}-${pad2(month)}-${pad2(day)}`;
  const extracted = extractIcao(description, event.resolutionSource ?? "");

  const buckets: Bucket[] = (event.markets ?? []).map((m) => {
    const label = (m.groupItemTitle || m.question || "").trim();
    const parsed = parseBucketLabel(label);
    const outcomes = asArray<string>(m.outcomes);
    const prices = asArray<string>(m.outcomePrices);
    const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o)));
    const yesPrice = num(prices[yesIdx >= 0 ? yesIdx : 0]);
    return {
      id: m.id ?? m.slug ?? label,
      label,
      lo: parsed.lo,
      hi: parsed.hi,
      yesPrice,
      volume: num(m.volumeNum ?? m.volume),
      slug: m.slug ?? "",
      question: m.question ?? label,
    };
  });

  buckets.sort((a, b) => {
    const av = a.lo ?? a.hi ?? -Infinity;
    const bv = b.lo ?? b.hi ?? -Infinity;
    if (a.lo === null) return -1;
    if (b.lo === null) return 1;
    if (a.hi === null) return 1;
    if (b.hi === null) return -1;
    return av - bv;
  });

  const unit = detectUnit(description, buckets);
  const icao = extracted.icao ?? "";
  const metarIcao = icao === "HKO" ? "VHHH" : icao;
  const wuHistory =
    extracted.wuHistoryUrl ??
    (icao !== "HKO" ? `https://www.wunderground.com/history/daily/${icao}` : null);

  return {
    eventId: String(event.id ?? slug),
    slug,
    title,
    city,
    localDate,
    unit,
    icao,
    metarIcao,
    resolutionKind: extracted.kind,
    resolutionUrl: applyResolutionUnits(extracted.resolutionUrl, unit, icao || extracted.icao),
    wuHistoryUrl: wuHistory,
    wuHourlyUrlTemplate: wuHourlyTemplate(wuHistory, icao),
    description,
    buckets,
    volume: num(event.volume),
    closed: Boolean(event.closed),
    polymarketUrl: `https://polymarket.com/event/${slug}`,
  };
}

export function fillWuHourlyUrl(template: string | null, localDate: string): string | null {
  if (!template) return null;
  return template.replace("{date}", wuDatePath(localDate));
}
