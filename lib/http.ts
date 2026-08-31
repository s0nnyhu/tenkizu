const UA =
  "TenkiZu/0.1 (read-only; highest-temperature dashboard)";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function fetchText(
  url: string,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    accept?: string;
  } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: opts.accept ?? "*/*",
        ...opts.headers,
      },
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const status = err instanceof HttpError ? err.status : 0;
      if (status === 429 || status >= 500) {
        await sleep(2000 * 2 ** i);
        continue;
      }
      throw err;
    }
  }
  throw last;
}

export async function fetchJson<T>(
  url: string,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    accept?: string;
  } = {},
): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    accept: opts.accept ?? "application/json",
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 180)}`);
  }
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
