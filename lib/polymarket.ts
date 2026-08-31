import { cached } from "./cache";
import { fetchJson } from "./http";
import { parseEvent } from "./parse";
import type { ParsedEvent } from "./types";

const GAMMA = "https://gamma-api.polymarket.com";
const POLY_TTL_MS = 30_000;

type SearchResponse = {
  events?: Record<string, unknown>[];
  pagination?: { hasMore?: boolean; totalResults?: number };
};

async function searchPage(page: number): Promise<SearchResponse> {
  const q = encodeURIComponent("Highest temperature in");
  const url = `${GAMMA}/public-search?q=${q}&events_status=active&limit_per_type=50&page=${page}`;
  return fetchJson<SearchResponse>(url, { timeoutMs: 25_000 });
}

export async function discoverHighestTempEvents(): Promise<ParsedEvent[]> {
  return cached("poly:highest-temp-events", POLY_TTL_MS, async () => {
    const seen = new Set<string>();
    const out: ParsedEvent[] = [];
    for (let page = 1; page <= 8; page++) {
      const res = await searchPage(page);
      const events = res.events ?? [];
      if (!events.length) break;
      for (const raw of events) {
        const parsed = parseEvent(raw);
        if (!parsed) continue;
        if (seen.has(parsed.slug)) continue;
        seen.add(parsed.slug);
        out.push(parsed);
      }
      if (!res.pagination?.hasMore) break;
    }
    const cityIcao = new Map<string, { icao: string; metarIcao: string }>();
    for (const e of out) {
      if (e.icao) cityIcao.set(e.city.toLowerCase(), { icao: e.icao, metarIcao: e.metarIcao });
    }
    for (const e of out) {
      if (e.icao) continue;
      const hit = cityIcao.get(e.city.toLowerCase());
      if (!hit) continue;
      e.icao = hit.icao;
      e.metarIcao = hit.metarIcao;
      if (!e.wuHistoryUrl) {
        e.wuHistoryUrl = `https://www.wunderground.com/history/daily/${hit.icao}`;
      }
    }
    const kept = out.filter((e) => e.icao);
    kept.sort((a, b) => b.volume - a.volume || a.localDate.localeCompare(b.localDate) || a.city.localeCompare(b.city));
    return kept;
  });
}
