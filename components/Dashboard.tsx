"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { StationIndexItem } from "@/lib/types";
import { fmtTemp, relTime } from "@/lib/format";
import { toMarketUnit } from "@/lib/units";
import { useFavorites } from "@/lib/favorites";

type Payload = {
  stations: StationIndexItem[];
  fetchedAt: string;
  marketCount: number;
  stationCount: number;
  error?: string;
};

type LatestMetar = {
  tempC: number | null;
  obsAgeMin: number | null;
  raw: string | null;
};

export function Dashboard() {
  const router = useRouter();
  const { favs, ready, has, toggle } = useFavorites();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [metars, setMetars] = useState<Record<string, LatestMetar>>({});

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
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, []);

  const stations = data?.stations ?? [];

  const favoriteRows = useMemo(() => {
    const set = new Set(favs);
    return stations.filter((r) => set.has(r.icao));
  }, [stations, favs]);

  const favMetarIds = useMemo(
    () => [...new Set(favoriteRows.map((r) => r.metarIcao || r.icao))],
    [favoriteRows],
  );

  useEffect(() => {
    if (!favMetarIds.length) {
      setMetars({});
      return;
    }
    let cancelled = false;
    async function loadMetars() {
      try {
        const res = await fetch(`/api/metar/latest?ids=${favMetarIds.join(",")}`, { cache: "no-store" });
        const json = (await res.json()) as { byIcao?: Record<string, LatestMetar> };
        if (!res.ok || cancelled) return;
        setMetars(json.byIcao ?? {});
      } catch {
        /* keep last */
      }
    }
    void loadMetars();
    const id = setInterval(() => void loadMetars(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [favMetarIds.join(",")]);

  const searchHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return stations.filter(
      (r) =>
        r.city.toLowerCase().includes(s) ||
        r.icao.toLowerCase().includes(s) ||
        r.stationName.toLowerCase().includes(s) ||
        r.country.toLowerCase().includes(s),
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
            autoComplete="off"
          />
          {q.trim() && (
            <section className="search-hits">
              {loading && !data ? (
                <div className="search-hits-empty">Recherche… chargement des stations</div>
              ) : searchHits.length === 0 ? (
                <div className="search-hits-empty">Aucun résultat pour « {q.trim()} »</div>
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
        <div className="home-meta">
          {data ? `${data.stationCount} stations · MAJ ${relTime(data.fetchedAt)}` : "Chargement des stations…"}
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
          {favoriteRows.map((r) => {
            const m = metars[r.metarIcao || r.icao];
            const temp = m?.tempC == null ? null : toMarketUnit(m.tempC, r.unit);
            return (
              <article
                key={r.icao}
                className="card fav-tile"
                onClick={() => router.push(`/station/${r.icao}`)}
              >
                <div className="fav-tile-head">
                  <div>
                    <h2>
                      {r.city} <span className="icao">{r.icao}</span>
                    </h2>
                    <div className="muted">
                      {r.stationName}
                      {r.country ? ` · ${r.country}` : ""}
                    </div>
                  </div>
                  <StarButton on={has(r.icao)} onClick={() => toggle(r.icao)} />
                </div>
                <div className="fav-tile-metar" title={m?.raw ?? undefined}>
                  <span className="tmax">{fmtTemp(temp, r.unit, 1)}</span>
                  <span className="faint">
                    METAR
                    {m?.obsAgeMin != null ? ` · ${m.obsAgeMin} min` : ""}
                  </span>
                </div>
              </article>
            );
          })}
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
