"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CITIES, type StaticCity } from "@/lib/cities";
import { useFavorites } from "@/lib/favorites";

export function Dashboard() {
  const router = useRouter();
  const { favs, ready, has, toggle } = useFavorites();
  const [q, setQ] = useState("");
  const [autoFocus, setAutoFocus] = useState(false);

  useEffect(() => {
    const touch = window.matchMedia("(pointer: coarse), (max-width: 640px)").matches;
    if (!touch) setAutoFocus(true);
  }, []);

  const favoriteRows = useMemo(() => {
    const byIcao = new Map(CITIES.map((c) => [c.icao, c]));
    return favs
      .map((icao) => byIcao.get(icao) ?? { city: icao, icao })
      .filter(Boolean) as StaticCity[];
  }, [favs]);

  const searchHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return CITIES.filter(
      (r) => r.city.toLowerCase().includes(s) || r.icao.toLowerCase().includes(s),
    );
  }, [q]);

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
            autoFocus={autoFocus}
            autoComplete="off"
            inputMode="search"
          />
          {q.trim() && (
            <section className="search-hits">
              {searchHits.length === 0 ? (
                <div className="search-hits-empty">Aucun résultat pour « {q.trim()} »</div>
              ) : (
                searchHits.map((r) => (
                  <div key={r.icao} className="search-hit">
                    <button type="button" className="search-hit-main" onClick={() => router.push(`/station/${r.icao}`)}>
                      <b>{r.city}</b>
                      <span className="icao">{r.icao}</span>
                    </button>
                    <StarButton on={has(r.icao)} onClick={() => toggle(r.icao)} />
                  </div>
                ))
              )}
            </section>
          )}
        </div>
        <div className="home-meta">{CITIES.length} stations</div>
      </header>

      {ready && favoriteRows.length === 0 && !q.trim() && (
        <p className="home-empty">Aucune station en favori. Cherche une ville, puis clique sur ☆.</p>
      )}

      {ready && favoriteRows.length > 0 && (
        <section className="fav-grid">
          {favoriteRows.map((r) => (
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
                </div>
                <StarButton on={has(r.icao)} onClick={() => toggle(r.icao)} />
              </div>
            </article>
          ))}
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
