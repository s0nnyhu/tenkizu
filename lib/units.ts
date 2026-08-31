import type { Bucket, TempUnit } from "./types";

export function toMarketUnit(celsius: number, unit: TempUnit): number {
  return unit === "F" ? (celsius * 9) / 5 + 32 : celsius;
}

export function celsiusFromMarket(value: number, unit: TempUnit): number {
  return unit === "F" ? ((value - 32) * 5) / 9 : value;
}

/** Truncation toward zero, not rounding. 23.4 → 23, 22.9 → 22. */
export function truncateTemp(value: number): number {
  return Math.trunc(value);
}

export function bucketContains(bucket: Bucket, truncated: number): boolean {
  const geLo = bucket.lo === null || truncated >= bucket.lo;
  const leHi = bucket.hi === null || truncated <= bucket.hi;
  return geLo && leHi;
}

export function findBucket(buckets: Bucket[], truncated: number | null): Bucket | null {
  if (truncated === null || !Number.isFinite(truncated)) return null;
  return buckets.find((b) => bucketContains(b, truncated)) ?? null;
}

export function marketFavorite(buckets: Bucket[]): Bucket | null {
  if (!buckets.length) return null;
  return buckets.reduce((a, b) => (b.yesPrice > a.yesPrice ? b : a));
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function spread(values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function consensusOf(tmaxes: number[]): {
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  n: number;
  meanTrunc: number | null;
} {
  const n = tmaxes.length;
  const m = mean(tmaxes);
  const med = median(tmaxes);
  const sp = spread(tmaxes);
  return {
    mean: m,
    median: med,
    min: sp?.min ?? null,
    max: sp?.max ?? null,
    n,
    meanTrunc: m === null ? null : truncateTemp(m),
  };
}
