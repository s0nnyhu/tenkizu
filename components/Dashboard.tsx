"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DashboardRow } from "@/lib/types";
import { fmtProb, fmtTemp, relTime, tempToBucketColor } from "@/lib/format";
import { stationLocalParts } from "@/lib/time";
import { useFavorites } from "@/lib/favorites";

type Payload = {
  rows: DashboardRow[];
  fetchedAt: string;
  marketCount: number;
  stationCount: number;
  error?: string;
};

function pickStationRow(rows: DashboardRow[]): DashboardRow | null {
  return rows.find((r) => r.horizon === "J") ?? rows[0] ?? null;
}

function uniqueStations(rows: DashboardRow[]): DashboardRow[] {
  const by = new Map<string, DashboardRow[]>();
  for (const r of rows) {
    const list = by.get(r.icao) ?? [];
    list.push(r);
    by.set(r.icao, list);
  }
  return [...by.values()].map((list) => pickStationRow(list)!).filter(Boolean);
}

export function Dashboard() {
  const router = useRouter();
  const { favs, ready, has, toggle } = useFavorites();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [now, setNow] = useState(() => Date.now());

  async function load() {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      const json = (await res.json()) as Payload;
      if (!res.ok) throw new Error(json.error || res.statusText);
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const stations = useMemo(() => uniqueStations(data?.rows ?? []), [data]);

  const favoriteRows = useMemo(() => {
    const set = new Set(favs);
    return stations.filter((r) => set.has(r.icao));
  }, [stations, favs]);

  const searchHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return stations.filter(
      (r) =>
        r.city.toLowerCase().includes(s) ||
        r.icao.toLowerCase().includes(s) ||
        r.stationName.toLowerCase().includes(s),
    );
  }, [stations, q]);

  return (
    <div className="home">
      <header className="home-hero">
        <h1>
          <span>TenkiZu</span>
        </h1>
        <p>Highest temperature · favoris · Tmax à la station ICAO</p>
        <div className="home-search">
          <input
            placeholder="Rechercher une ville ou un ICAO…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </div>
        <div className="home-meta">
          {data ? `${data.stationCount} stations · MAJ ${relTime(data.fetchedAt)}` : "Chargement…"}
        </div>
      </header>

      {error && !data && (
        <div className="loading">
          <b>Erreur dashboard</b>
          {error}
        </div>
      )}

      {ready && favoriteRows.length === 0 && !q.trim() && (
        <p className="home-empty">Aucune station en favori. Cherche une ville, puis clique sur ☆.</p>
      )}

      {ready && favoriteRows.length > 0 && (
        <section className="fav-grid">
          {favoriteRows.map((r) => (
            <StationTile
              key={r.icao}
              row={r}
              now={now}
              favorited
              onOpen={() => router.push(`/station/${r.icao}`)}
              onToggleFav={() => toggle(r.icao)}
            />
          ))}
        </section>
      )}

      {q.trim() && (
        <section className="search-hits">
          {loading && !data ? (
            <div className="muted" style={{ textAlign: "center" }}>
              Recherche… chargement des stations
            </div>
          ) : searchHits.length === 0 ? (
            <div className="muted" style={{ textAlign: "center" }}>
              Aucun résultat pour « {q.trim()} »
            </div>
          ) : (
            searchHits.map((r) => (
              <div key={r.icao} className="search-hit">
                <button type="button" className="search-hit-main" onClick={() => router.push(`/station/${r.icao}`)}>
                  <b>{r.city}</b>
                  <span className="icao">{r.icao}</span>
                  <span className="faint">{r.stationName}</span>
                </button>
                <StarButton on={has(r.icao)} onClick={() => toggle(r.icao)} />
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}

function StarButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`star-btn ${on ? "on" : ""}`}
      title={on ? "Retirer des favoris" : "Ajouter aux favoris"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

function StationTile({
  row,
  now,
  favorited,
  onOpen,
  onToggleFav,
}: {
  row: DashboardRow;
  now: number;
  favorited: boolean;
  onOpen: () => void;
  onToggleFav: () => void;
}) {
  const clock = stationLocalParts(row.timezone, now);
  return (
    <article className="card fav-tile" onClick={onOpen}>
      <div className="fav-tile-head">
        <div>
          <h2>
            {row.city} <span className="icao">{row.icao}</span>
          </h2>
          <div className="muted">
            {clock.hm} · {row.timezone}
          </div>
        </div>
        <StarButton on={favorited} onClick={onToggleFav} />
      </div>
      <div className="fav-tile-stats">
        <div>
          <span className="faint">METAR</span>
          <span
            className="tmax"
            style={{
              background: tempToBucketColor(
                row.buckets,
                row.lastMetar?.tempMarket == null ? null : Math.trunc(row.lastMetar.tempMarket),
              ),
            }}
          >
            {fmtTemp(row.lastMetar?.tempMarket ?? null, row.unit, 1)}
          </span>
        </div>
        <div>
          <span className="faint">Cons.</span>
          <span
            className="tmax"
            style={{ background: tempToBucketColor(row.buckets, row.consensus.meanTrunc) }}
          >
            {fmtTemp(row.consensus.mean, row.unit, 1)}
          </span>
        </div>
        <div>
          <span className="faint">Mkt</span>
          <span className="num">
            {row.marketFavoriteBucket ?? "—"}{" "}
            {fmtProb(row.buckets.find((b) => b.label === row.marketFavoriteBucket)?.yesPrice ?? null)}
          </span>
        </div>
      </div>
    </article>
  );
}
