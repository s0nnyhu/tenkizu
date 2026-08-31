/** Station-local civil calendar helpers. Never use the browser TZ or UTC date for market days. */

export function localDateISO(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

export function localTimeHM(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}

export function stationLocalParts(timeZone: string, epochMs = Date.now()) {
  const d = new Date(epochMs);
  const time = new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
  const hm = new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  const date = new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
  const offset =
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return { time, hm, date, offset };
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(utc);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function todayISO(timeZone: string, now = Date.now()): string {
  return localDateISO(now, timeZone);
}

export function horizonFor(dateISO: string, today: string): import("./types").Horizon {
  if (dateISO === today) return "J";
  if (dateISO === addDaysISO(today, 1)) return "J+1";
  if (dateISO === addDaysISO(today, 2)) return "J+2";
  if (dateISO < today) return "past";
  return "later";
}

export function formatAge(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  if (h < 48) return rem ? `${h} h ${rem} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} j`;
}

export function hourFromLocalIso(localIso: string): string {
  const t = localIso.split("T")[1] ?? "";
  return t.slice(0, 5);
}

/** Wunderground date path: 2026-8-31 (no zero padding). */
export function wuDatePath(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y}-${Number(m)}-${Number(d)}`;
}

export function parseMaybeIso(value: string): number | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
