type Entry<T> = {
  value: T;
  exp: number;
  staleUntil: number;
};

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined;
  if (!hit) return undefined;
  if (hit.exp > Date.now()) return hit.value;
  return undefined;
}

export function cacheGetStale<T>(key: string): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined;
  if (!hit) return undefined;
  if (hit.staleUntil > Date.now()) return hit.value;
  return undefined;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number, staleMs = ttlMs * 3): T {
  store.set(key, {
    value,
    exp: Date.now() + ttlMs,
    staleUntil: Date.now() + ttlMs + staleMs,
  });
  return value;
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  staleMs = ttlMs * 4,
): Promise<T> {
  const fresh = cacheGet<T>(key);
  if (fresh !== undefined) return fresh;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const run = (async () => {
    try {
      const value = await fn();
      cacheSet(key, value, ttlMs, staleMs);
      return value;
    } catch (err) {
      const stale = cacheGetStale<T>(key);
      if (stale !== undefined) return stale;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, run);
  return run;
}

export function cacheStats(): { keys: number } {
  return { keys: store.size };
}
