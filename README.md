# TenkiZu

Application **read-only** pour suivre les marchés Polymarket actifs du type
« Highest temperature in {ville} on {date} ».

Les stations, unités, buckets et URLs de résolution sont extraits de la
**description officielle** de chaque événement (Gamma API). Aucune liste de
villes n’est hardcodée.

## Lancer

```bash
npm install
npm run dev
```

Ouvre [http://localhost:3014](http://localhost:3014).

Premier chargement : 10–40 s (découverte Polymarket + Open-Meteo + METAR).
Ensuite cache mémoire (prix ~30 s, METAR ~2 min, modèles ~15 min, WU ~10 min).

## Sources

| Source | Usage | TTL | Notes |
|---|---|---|---|
| Polymarket Gamma `public-search` | Marchés, buckets, prix YES | 30 s | Filtre titre `Highest temperature in` |
| AviationWeather stationinfo | ICAO → lat/lon/pays | 24 h | Timezone IANA via `tz-lookup` |
| AviationWeather METAR | Dernier relevé + running max depuis minuit **local** | 2 min | Même famille ASOS que NOAA WRH |
| Open-Meteo `models=` explicites | Tmax = max horaire `temperature_2m` sur le jour civil local | 15 min | `cell_selection=nearest`, pas de `best_match` |
| Wunderground / weather.com v3 | Prévision daily + daily summary (ICAO) | 10 min | Clé extraite du HTML WU (`apiKey=`). SPA, pas de table HTML stable. |
| HKO open data `rhrread` | Hong Kong Observatory | 5 min | Résolution = Daily Extract, pas le METAR VHHH |

NOAA n’est **pas** un modèle. Les modèles affichés, côte à côte : ECMWF IFS,
ICON + ICON-D2, AROME, UKMO, GFS, HRRR, CMA. Hors domaine / hors horizon →
`n/a`, jamais une valeur interpolée d’un autre modèle.

## Règles métier

- Jour = calendrier local de la station, pas UTC, pas le TZ du navigateur.
- Troncature vers zéro (`Math.trunc`) dans l’unité du marché : 23.4 → 23, 22.9 → 22.
- La valeur qui **règle** le marché est le max quotidien **finalisé** de la source
  citée dans les règles (souvent `weather.gov/wrh/timeseries?site=ICAO`, WU en
  repli, HKO pour Hong Kong). Ce n’est pas le METAR intra-day, ni un Tmax modèle.
- Consensus = moyenne et médiane des Tmax NWP **disponibles** + Wunderground
  (max du tableau horaire WU).

## Limites / ToS

- **Pas de trading, pas de wallet, pas d’ordres.**
- Wunderground : le site est une SPA ; on utilise les mêmes endpoints
  `api.weather.com` que la page (clé extraite du HTML, non commitée). Un 403
  s’affiche sur la carte. Respecter les ToS ; usage personnel / recherche.
- Open-Meteo : quota non commercial (faire un miroir self-hosted ou une clé si
  le trafic dépasse le fair use).
- Les heures de run modèle (`12Z, âge 4 h`) sont **estimées** à partir du cycle
  et du lag de diffusion typiques : l’API Open-Meteo forecast ne expose pas
  l’init exacte du run.
- Cache in-process : un seul processus Node. Pas de Redis.

## API internes

- `GET /api/dashboard` — toutes les lignes
- `GET /api/station/:icao` — détail J / J+1 / J+2 + profil horaire
