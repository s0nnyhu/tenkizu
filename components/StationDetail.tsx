"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ModelDayValue, StationDay, StationPayload } from "@/lib/types";
import { findBucket, marketFavorite, truncateTemp } from "@/lib/units";
import { bucketColor, fmtProb, fmtTemp, relTime, tempToBucketColor } from "@/lib/format";
import { localDateTime, stationLocalParts } from "@/lib/time";
import { gfsCycleClock } from "@/lib/gfs-cycle";
import { BucketBars } from "./BucketBars";
import { Sparkline } from "./Sparkline";
import { HourlyTable } from "./HourlyTable";
import { useFavorites } from "@/lib/favorites";

export function StationDetail({ icao }: { icao: string }) {
  const [data, setData] = useState<StationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());
  const { has, toggle } = useFavorites();

  async function load() {
    try {
      const res = await fetch(`/api/station/${icao}`, { cache: "no-store" });
      const json = (await res.json()) as StationPayload & { error?: string };
      if (!res.ok) throw new Error(json.error || res.statusText);
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [icao]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const j = data?.days.find((d) => d.horizon === "J");
  const unit = data?.unit ?? "C";

  const modelIds = useMemo(() => {
    if (!data) return [];
    const first = data.days[0]?.models ?? [];
    return first
      .filter((m) =>
        data.days.some((d) => {
          const x = d.models.find((y) => y.modelId === m.modelId);
          return x && x.status !== "out_of_domain";
        }),
      )
      .map((m) => m.modelId);
  }, [data]);

  if (error && !data) {
    return (
      <div className="app-shell">
        <Link className="back" href="/">
          ← accueil
        </Link>
        <div className="loading">
          <b>Erreur {icao}</b>
          {error}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="app-shell">
        <div className="loading">
          <b>Chargement {icao}</b>
          Modèles + METAR + scrape WU…
        </div>
      </div>
    );
  }

  const st = data.station;
  const cons = j?.consensus;
  const last = data.lastMetar;
  const cluster = voteCluster(j);
  const clock = stationLocalParts(st.timezone, now);
  const gfsCycle = gfsCycleClock(new Date(now));
  const fav = j?.buckets.length ? marketFavorite(j.buckets) : null;
  const favOn = has(st.icao);

  return (
    <div className="app-shell">
      <Link className="back" href="/">
        ← accueil
      </Link>
      <header className="topbar" style={{ marginTop: 8 }}>
        <div className="brand">
          <h1>
            {st.site} <span>{st.icao}</span>
          </h1>
          <p>
            {st.timezone} · {st.country} · {st.lat.toFixed(4)}, {st.lon.toFixed(4)} · unité marché °
            {unit}
            {st.icao !== st.metarIcao ? ` · METAR ${st.metarIcao}` : ""}
          </p>
        </div>
        <div className="legend">
          <button
            type="button"
            className={`star-btn ${favOn ? "on" : ""}`}
            title={favOn ? "Retirer des favoris" : "Ajouter aux favoris"}
            onClick={() => toggle(st.icao)}
          >
            {favOn ? "★ Favori" : "☆ Favori"}
          </button>
          <span className="pill">METAR {data.lastMetar ? `${data.lastMetar.obsAgeMin} min` : "—"}</span>
          <span className="pill">modèles {relTime(data.fetchedAt)}</span>
          <span
            className="pill"
            title={`Prochain cycle NOAA ${gfsCycle.nextLabel} · ${gfsCycle.nextWhen}`}
          >
            GFS {gfsCycle.currentLabel} · {gfsCycle.nextLabel} dans {gfsCycle.remain}
          </span>
        </div>
      </header>

      <div className="links">
        {data.polymarketUrl && (
          <a href={data.polymarketUrl} target="_blank" rel="noreferrer">
            Polymarket
          </a>
        )}
        {data.resolutionUrl && (
          <a href={data.resolutionUrl} target="_blank" rel="noreferrer">
            Source de résolution
          </a>
        )}
        {data.wuHistoryUrl && (
          <a href={data.wuHistoryUrl} target="_blank" rel="noreferrer">
            WU history
          </a>
        )}
        {data.wuHourlyUrl && (
          <a href={data.wuHourlyUrl} target="_blank" rel="noreferrer">
            WU hourly
          </a>
        )}
        <a href={data.metarRawUrl} target="_blank" rel="noreferrer">
          METAR brut
        </a>
      </div>

      <div className="card clock-banner">
        <div>
          <h2>Heure locale station</h2>
          <div className="muted">
            {st.timezone}
            {clock.offset ? ` · ${clock.offset}` : ""} · {clock.date}
          </div>
          {data.wxOutlook?.chips.length ? (
            <div className="wx-chips">
              {data.wxOutlook.chips.map((c) => (
                <span key={c.label} className={`wx-chip ${c.kind}`}>
                  {c.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="hero clock-hero">{clock.time}</div>
      </div>

      <section className="header-card">
        <div className="card" title={last?.raw ?? undefined}>
          <h2>Dernier METAR</h2>
          <div className="hero">{fmtTemp(last?.tempMarket ?? null, unit, 1)}</div>
          <div className="muted">
            {last?.wx ?? "—"} · {last?.obsTimeIso?.slice(11, 16) ?? "—"}Z
            {last?.obsAgeMin != null ? ` · ${last.obsAgeMin} min` : ""}
          </div>
        </div>
        <div className="card">
          <h2>Favori Polymarket</h2>
          {fav ? (
            <>
              <div className="hero">
                <span className="tmax" style={{ background: bucketColor(j?.buckets ?? [], fav.label) }}>
                  {fav.label}
                </span>
              </div>
              <div className="muted">{fmtProb(fav.yesPrice)} yes · tranche la plus chère</div>
            </>
          ) : (
            <>
              <div className="hero">—</div>
              <div className="muted">pas de marché J</div>
            </>
          )}
        </div>
        <div className="card">
          <h2>Consensus (NWP + WU, hors CMA)</h2>
          <div className="hero">
            {fmtTemp(cons?.mean ?? null, unit, 1)}
            <small>méd {fmtTemp(cons?.median ?? null, unit, 1)}</small>
          </div>
          <div className="muted">
            n={cons?.n ?? 0} · spread {fmtTemp(cons?.min ?? null, unit, 1)}–{fmtTemp(cons?.max ?? null, unit, 1)}
          </div>
        </div>
        <div className="card">
          <h2>Convergence Tmax</h2>
          {cluster.n === 0 || cluster.mode == null ? (
            <div className="hero">—</div>
          ) : (
            <>
              <div className="hero">
                {cluster.modeCount}/{cluster.n}
                <small>
                  pointent {fmtTemp(cluster.mode, unit, 0)}
                </small>
              </div>
              <div className="muted">
                {cluster.nTranches} tranche{cluster.nTranches > 1 ? "s" : ""} en jeu
              </div>
              <div className="vote-list">
                {cluster.ranked.map(([t, c]) => (
                  <span key={t} className={t === cluster.mode ? "on" : undefined}>
                    {c}→{fmtTemp(t, unit, 0)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {data.pws.length > 0 && (
        <section className="pws-section">
          <div className="pws-grid">
            {data.pws.map((row) => (
              <div className="card" key={`${row.source}:${row.id}:${row.url}`}>
                <h2>
                  <a href={row.url} target="_blank" rel="noreferrer">
                    PWS
                  </a>
                </h2>
                <div className="hero">
                  {row.status === "ok" ? fmtTemp(row.tempMarket, unit, 1) : "—"}
                </div>
                <div className="muted">
                  {row.source}
                  {row.id ? ` · ${row.id}` : ""}
                  {row.name ? ` · ${row.name}` : ""}
                </div>
                <div className="muted">
                  {row.obsTimeIso
                    ? localDateTime(Date.parse(row.obsTimeIso), st.timezone)
                    : row.error ?? "heure de relevé inconnue"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.errors.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h2>Sources en erreur (le reste continue)</h2>
          {data.errors.map((e, i) => (
            <div key={i} className="warn">
              {e.source}: {e.message}
              {/429/.test(e.message) ? " — quota Open-Meteo, nouvel essai auto dans quelques secondes (rafraîchir)." : ""}
            </div>
          ))}
        </div>
      )}

      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table className="grid model-table">
          <thead>
            <tr>
              <th className="day">Jour</th>
              <th>
                WU
                <span className="sub">horaire</span>
              </th>
              {modelIds.map((id) => {
                const label = data.days[0]?.models.find((m) => m.modelId === id);
                return (
                  <th key={id}>
                    {label?.label}
                    {label?.submodel && <span className="sub">{label.submodel}</span>}
                  </th>
                );
              })}
              <th>
                Consensus
                <span className="sub">NWP + WU · hors CMA</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.localDate}>
                <th className="day">
                  {d.horizon}
                  <span className="sub">{d.localDate}</span>
                  {cellGefs(d, unit)}
                </th>
                <td>{cellWu(d, unit)}</td>
                {modelIds.map((id) => {
                  const m = d.models.find((x) => x.modelId === id);
                  return <td key={id}>{cellModel(m, d, unit)}</td>;
                })}
                <td>
                  <span
                    className="tmax"
                    style={{ background: tempToBucketColor(d.buckets, d.consensus.meanTrunc) }}
                  >
                    {fmtTemp(d.consensus.mean, unit, 1)}
                  </span>
                  <span className="sub">
                    méd {fmtTemp(d.consensus.median, unit, 1)} · {fmtTemp(d.consensus.min, unit, 1)}–
                    {fmtTemp(d.consensus.max, unit, 1)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="header-card" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        {data.days.map((d) => {
          const consB = findBucket(d.buckets, d.consensus.meanTrunc);
          const wuB = findBucket(d.buckets, d.wuForecastTmax == null ? null : truncateTemp(d.wuForecastTmax));
          const runB = findBucket(
            d.buckets,
            d.runningMax?.runningMaxMarket == null ? null : truncateTemp(d.runningMax.runningMaxMarket),
          );
          return (
            <div className="card" key={d.localDate}>
              <h2>
                {d.market ? (
                  <a href={d.market.polymarketUrl} target="_blank" rel="noreferrer">
                    Buckets {d.horizon}
                  </a>
                ) : (
                  <>Buckets {d.horizon} (pas de marché)</>
                )}
              </h2>
              {d.buckets.length ? (
                <BucketBars
                  buckets={d.buckets}
                  consensusLabel={consB?.label ?? null}
                  wuLabel={wuB?.label ?? null}
                  runningLabel={d.horizon === "J" ? runB?.label ?? null : null}
                />
              ) : (
                <div className="muted">Pas de marché Polymarket sur ce jour.</div>
              )}
              {d.market && (
                <div className="links">
                  <a href={d.market.polymarketUrl} target="_blank" rel="noreferrer">
                    {d.market.city} {d.localDate}
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <HourlyTable
        days={data.hourlyDays ?? []}
        unit={unit}
        timezone={st.timezone}
      />

      <div className="card" style={{ marginTop: 12 }}>
        <h2>Profil horaire J — toutes sources</h2>
        <Sparkline grid={data.hourlyDays?.find((d) => d.horizon === "J")} unit={unit} />
      </div>
    </div>
  );
}

function voteCluster(day: StationDay | undefined) {
  const votes: number[] = [];
  for (const m of day?.models ?? []) {
    if (m.status === "ok" && m.tmax != null) votes.push(Math.round(m.tmax));
  }
  if (day?.wuForecastTmax != null) votes.push(Math.round(day.wuForecastTmax));

  const counts = new Map<number, number>();
  for (const t of votes) counts.set(t, (counts.get(t) ?? 0) + 1);

  let mode: number | null = null;
  let modeCount = 0;
  for (const [t, c] of counts) {
    if (c > modeCount || (c === modeCount && (mode == null || t > mode))) {
      mode = t;
      modeCount = c;
    }
  }

  const trancheKeys = new Set<string>();
  for (const t of counts.keys()) {
    const b = findBucket(day?.buckets ?? [], t);
    trancheKeys.add(b?.id ?? `t:${t}`);
  }

  return {
    n: votes.length,
    mode,
    modeCount,
    nTranches: trancheKeys.size,
    ranked: [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]),
  };
}

function cellGefs(d: StationDay, unit: string) {
  const g = d.gefs;
  if (!g || g.mean == null || g.n === 0) {
    return <span className="gefs sub">GEFS —</span>;
  }
  const delta = g.spread;
  return (
    <span className="gefs">
      <span className="gefs-mean">GEFS {fmtTemp(g.mean, unit, 1)}</span>
      <span className="sub">
        {fmtTemp(g.min, unit, 1)}–{fmtTemp(g.max, unit, 1)}
        {delta == null ? "" : ` · Δ${delta.toFixed(1)}`}
      </span>
    </span>
  );
}

function cellWu(d: StationDay, unit: string) {
  if (d.wuForecastTmax == null) {
    return <span className="na">n/a{d.wuDailyStatus === "error" ? " · scrape" : ""}</span>;
  }
  const trunc = truncateTemp(d.wuForecastTmax);
  return (
    <>
      <span className="tmax" style={{ background: tempToBucketColor(d.buckets, trunc) }}>
        {fmtTemp(d.wuForecastTmax, unit, 1)}
      </span>
      <span className="sub">tronc. {trunc}</span>
    </>
  );
}

function cellModel(m: ModelDayValue | undefined, d: StationDay, unit: string) {
  if (!m) return <span className="na">n/a</span>;
  if (m.status === "out_of_domain") return <span className="na">hors domaine</span>;
  if (m.status === "out_of_horizon") return <span className="na">hors horizon</span>;
  if (m.status === "unavailable") return <span className="na">n/a · pas de run</span>;
  if (m.status === "error" || m.tmax == null) return <span className="na">n/a</span>;
  return (
    <div className={m.beatenByMetar ? "beaten" : undefined} title={m.beatenByMetar ? "Running max METAR déjà > Tmax modèle" : undefined}>
      <span className="tmax" style={{ background: tempToBucketColor(d.buckets, m.tmaxTrunc) }}>
        {fmtTemp(m.tmax, unit, 1)}
      </span>
      <span className="sub">
        pic {m.peakLocal ?? "—"} · run {m.runLabel ?? "—"}
        {m.runAgeHours != null ? ` · ${m.runAgeHours.toFixed(0)}h` : ""}
        {m.beatenByMetar ? " · METAR > modèle" : ""}
      </span>
    </div>
  );
}
