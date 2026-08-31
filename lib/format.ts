import type { Bucket } from "./types";

export function fmtTemp(value: number | null | undefined, unit: string, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = digits === 0 ? Math.trunc(value) : value;
  const s = digits === 0 ? String(n) : n.toFixed(digits);
  return `${s}°${unit}`;
}

export function fmtProb(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function heatStops(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  const h = 28 - x * 6;
  const s = 20 + x * 42;
  const l = 9 + x * 24;
  return `hsl(${h} ${s}% ${l}%)`;
}

export function bucketColor(buckets: Bucket[], label: string | null): string {
  if (!label) return "transparent";
  const i = buckets.findIndex((b) => b.label === label);
  if (i < 0) return heatStops(0.35);
  const t = buckets.length <= 1 ? 0.55 : i / (buckets.length - 1);
  return heatStops(t);
}

export function tempHeatColor(value: number, min: number, max: number): string {
  const span = Math.max(1, max - min);
  return heatStops((value - min) / span);
}

export function tempToBucketColor(buckets: Bucket[], trunc: number | null): string {
  if (trunc == null) return "transparent";
  const b = buckets.find((x) => {
    const ge = x.lo === null || trunc >= x.lo;
    const le = x.hi === null || trunc <= x.hi;
    return ge && le;
  });
  return bucketColor(buckets, b?.label ?? null);
}

export function statusLabel(s: string): string {
  switch (s) {
    case "live":
      return "live";
    case "awaiting_daily":
      return "daily summary";
    case "resolved":
      return "résolu";
    case "upcoming":
      return "à venir";
    default:
      return s;
  }
}

export function horizonLabel(h: string): string {
  return h;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "à l’instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}
