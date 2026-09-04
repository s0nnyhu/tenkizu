#!/usr/bin/env python3
"""Collecteur autonome Tmax / METAR / PWS / WU / GEFS / favori Polymarket.

Tourne en avant-plan (systemd Type=simple) et écrit une ligne CSV toutes
les 30 minutes, un fichier par station. Aucune dépendance pip : stdlib only.

  python3 collect.py --once          # un cycle, puis exit
  python3 collect.py                 # boucle 30 min
  sudo ./deploy/install-wx-archive.sh
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

log = logging.getLogger("wx-archive")

INTERVAL_SEC = 30 * 60
UA = "TenkiZu-archive/1.0 (personal research; lightsail collector)"
UA_BROWSER = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

STATIONS: dict[str, dict[str, Any]] = {
    "LFPB": {
        "city": "Paris",
        "lat": 48.9694,
        "lon": 2.44139,
        "tz": "Europe/Paris",
        "metar": "LFPB",
    },
    "LIMC": {
        "city": "Milan",
        "lat": 45.6306,
        "lon": 8.72811,
        "tz": "Europe/Rome",
        "metar": "LIMC",
    },
    "EHAM": {
        "city": "Amsterdam",
        "lat": 52.3086,
        "lon": 4.76389,
        "tz": "Europe/Amsterdam",
        "metar": "EHAM",
    },
}

CITY_TO_ICAO = {s["city"].lower(): icao for icao, s in STATIONS.items()}

# Même liste / fallback que lib/models.ts
MODELS: list[dict[str, Any]] = [
    {"id": "ecmwf_ifs", "om": ["ecmwf_ifs"]},
    {"id": "icon", "om": ["icon_eu", "icon_global"]},
    {"id": "icon_d2", "om": ["icon_d2"]},
    {"id": "icon_2i", "om": ["italia_meteo_arpae_icon_2i"]},
    {"id": "arome", "om": ["meteofrance_arome_france"]},
    {"id": "harmonie", "om": ["knmi_harmonie_arome_netherlands", "knmi_harmonie_arome_europe"]},
    {"id": "met_norway", "om": ["metno_nordic"]},
    {"id": "gfs", "om": ["gfs013"]},
    {"id": "arpege", "om": ["meteofrance_seamless"]},
    {"id": "ukmo", "om": ["ukmo_global_deterministic_10km"]},
    {"id": "hrrr", "om": ["ncep_hrrr_conus"]},
    {"id": "cma", "om": ["cma_grapes_global"]},
]

ALL_OM_IDS = list(dict.fromkeys(om for m in MODELS for om in m["om"]))

# Même mapping que lib/pws.ts
PWS_STATIONS: dict[str, list[str]] = {
    "LFPB": ["https://www.awekas.at/fr/instrument.php?id=46887"],
    "EHAM": ["https://www.awekas.at/fr/instrument.php?id=31057"],
    "EDDM": ["https://www.awekas.at/fr/instrument.php?id=44077"],
}

GAMMA = "https://gamma-api.polymarket.com"
TITLE_RE = re.compile(
    r"^Highest temperature in (.+?) on ([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\??$",
    re.I,
)
MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}


def fieldnames() -> list[str]:
    cols = [
        "fetched_at_utc",
        "local_datetime",
        "local_date",
        "local_hour",
        "metar_temp_c",
        "metar_obs_utc",
        "pws_temp_c",
        "pws_id",
        "pws_name",
        "pws_obs_utc",
    ]
    for m in MODELS:
        cols += [f"{m['id']}_now_c", f"{m['id']}_tmax_j", f"{m['id']}_tmax_j1", f"{m['id']}_tmax_j2"]
        if len(m["om"]) > 1:
            cols.append(f"{m['id']}_submodel")
    cols += [
        "wu_now_c",
        "wu_tmax_j",
        "wu_tmax_j1",
        "wu_tmax_j2",
        "wu_obs_tmax_j",
        # Consensus = NWP ok hors CMA + WU (même règle que lib/dashboard.ts)
        "cons_mean_j",
        "cons_median_j",
        "cons_min_j",
        "cons_max_j",
        "cons_n_j",
        "cons_mean_trunc_j",
        "cons_mean_j1",
        "cons_median_j1",
        "cons_min_j1",
        "cons_max_j1",
        "cons_n_j1",
        "cons_mean_trunc_j1",
        "cons_mean_j2",
        "cons_median_j2",
        "cons_min_j2",
        "cons_max_j2",
        "cons_n_j2",
        "cons_mean_trunc_j2",
        "gefs_cycle",
        "gefs_mean_j",
        "gefs_min_j",
        "gefs_max_j",
        "gefs_spread_j",
        "gefs_n_j",
        "gefs_mean_j1",
        "gefs_min_j1",
        "gefs_max_j1",
        "gefs_spread_j1",
        "gefs_n_j1",
        "gefs_mean_j2",
        "gefs_min_j2",
        "gefs_max_j2",
        "gefs_spread_j2",
        "gefs_n_j2",
        "poly_favorite",
        "poly_favorite_lo",
        "poly_favorite_hi",
        "poly_favorite_yes",
        "poly_event_date",
        "poly_slug",
        "errors",
    ]
    return cols


FIELDS = fieldnames()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class HttpError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def http_get(url: str, timeout: int = 20, headers: dict[str, str] | None = None) -> str:
    hdrs = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    last: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as err:
            last = HttpError(f"HTTP {err.code} {err.reason}", err.code)
            if err.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(2 * 2**attempt)
                continue
            raise last from err
        except Exception as err:
            last = err
            if attempt < 3:
                time.sleep(1.5 * 2**attempt)
                continue
            raise
    raise last or RuntimeError(url)


def http_json(url: str, timeout: int = 25, headers: dict[str, str] | None = None) -> Any:
    return json.loads(http_get(url, timeout=timeout, headers=headers))


# ---------------------------------------------------------------------------
# Temps / CSV
# ---------------------------------------------------------------------------

def add_days(iso: str, days: int) -> str:
    y, m, d = (int(x) for x in iso.split("-"))
    dt = datetime(y, m, d) + timedelta(days=days)
    return dt.strftime("%Y-%m-%d")


def fmt_num(v: float | None, digits: int = 1) -> str:
    if v is None or not isinstance(v, (int, float)):
        return ""
    return f"{v:.{digits}f}"


def parse_num(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def consensus_of(tmaxes: list[float]) -> dict[str, float | int | None]:
    """Aligné sur lib/units.ts consensusOf + Math.trunc."""
    n = len(tmaxes)
    if not n:
        return {"mean": None, "median": None, "min": None, "max": None, "n": 0, "mean_trunc": None}
    mean = sum(tmaxes) / n
    ordered = sorted(tmaxes)
    mid = n // 2
    median = ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2
    return {
        "mean": mean,
        "median": median,
        "min": min(tmaxes),
        "max": max(tmaxes),
        "n": n,
        "mean_trunc": int(mean),  # toward zero, like Math.trunc
    }


def consensus_columns(row: dict[str, str]) -> dict[str, str]:
    """NWP status ok hors CMA + WU forecast, comme dashboard.consensusFrom(..., includeWu=true)."""
    out: dict[str, str] = {}
    for suffix in ("j", "j1", "j2"):
        vals: list[float] = []
        for m in MODELS:
            if m["id"] == "cma":
                continue
            v = parse_num(row.get(f"{m['id']}_tmax_{suffix}", ""))
            if v is not None:
                vals.append(v)
        wu = parse_num(row.get(f"wu_tmax_{suffix}", ""))
        if wu is not None:
            vals.append(wu)
        c = consensus_of(vals)
        out[f"cons_mean_{suffix}"] = fmt_num(c["mean"])  # type: ignore[arg-type]
        out[f"cons_median_{suffix}"] = fmt_num(c["median"])  # type: ignore[arg-type]
        out[f"cons_min_{suffix}"] = fmt_num(c["min"])  # type: ignore[arg-type]
        out[f"cons_max_{suffix}"] = fmt_num(c["max"])  # type: ignore[arg-type]
        out[f"cons_n_{suffix}"] = str(int(c["n"])) if c["n"] else ""
        out[f"cons_mean_trunc_{suffix}"] = "" if c["mean_trunc"] is None else str(int(c["mean_trunc"]))
    return out


def append_row(path: Path, row: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        if new_file:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in FIELDS})


# ---------------------------------------------------------------------------
# Open-Meteo
# ---------------------------------------------------------------------------

def om_series(hourly: dict[str, Any], om_id: str) -> list[float | None]:
    raw = hourly.get(f"temperature_2m_{om_id}")
    if raw is None:
        raw = hourly.get("temperature_2m")
    if not isinstance(raw, list):
        return []
    out: list[float | None] = []
    for v in raw:
        if isinstance(v, (int, float)):
            out.append(float(v))
        else:
            out.append(None)
    return out


def pick_submodel(hourly: dict[str, Any], times: list[str], date: str, om_ids: list[str]) -> tuple[str, list[float | None]] | None:
    for om_id in om_ids:
        temps = om_series(hourly, om_id)
        if any(t.startswith(date) and temps[i] is not None for i, t in enumerate(times) if i < len(temps)):
            return om_id, temps
    for om_id in om_ids:
        temps = om_series(hourly, om_id)
        if any(v is not None for v in temps):
            return om_id, temps
    return None


def tmax_for(times: list[str], temps: list[float | None], date: str) -> float | None:
    best: float | None = None
    for i, t in enumerate(times):
        if not t.startswith(date) or i >= len(temps):
            continue
        v = temps[i]
        if v is None:
            continue
        if best is None or v > best:
            best = v
    return best


def temp_at_hour(times: list[str], temps: list[float | None], hour_iso: str) -> float | None:
    for i, t in enumerate(times):
        if t.startswith(hour_iso) and i < len(temps):
            return temps[i]
    return None


def fetch_models(lat: float, lon: float, tz_name: str) -> dict[str, Any]:
    params = {
        "latitude": f"{lat:.5f}",
        "longitude": f"{lon:.5f}",
        "hourly": "temperature_2m",
        "forecast_days": "4",
        "past_days": "1",
        "timezone": tz_name,
        "models": ",".join(ALL_OM_IDS),
        "cell_selection": "nearest",
        "temperature_unit": "celsius",
    }
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
    data = http_json(url, timeout=30)
    if isinstance(data, list):
        data = data[0]
    if data.get("error"):
        raise HttpError(str(data.get("reason") or "Open-Meteo error"))
    return data.get("hourly") or {}


def model_columns(hourly: dict[str, Any], local_date: str, hour_iso: str) -> dict[str, str]:
    times = [str(t) for t in (hourly.get("time") or [])]
    d1 = add_days(local_date, 1)
    d2 = add_days(local_date, 2)
    row: dict[str, str] = {}
    for m in MODELS:
        pick = pick_submodel(hourly, times, local_date, m["om"])
        now = tmax_j = tmax_j1 = tmax_j2 = None
        sub = ""
        if pick:
            om_id, temps = pick
            sub = om_id if len(m["om"]) > 1 else ""
            now = temp_at_hour(times, temps, hour_iso)
            tmax_j = tmax_for(times, temps, local_date)
            tmax_j1 = tmax_for(times, temps, d1)
            tmax_j2 = tmax_for(times, temps, d2)
        row[f"{m['id']}_now_c"] = fmt_num(now)
        row[f"{m['id']}_tmax_j"] = fmt_num(tmax_j)
        row[f"{m['id']}_tmax_j1"] = fmt_num(tmax_j1)
        row[f"{m['id']}_tmax_j2"] = fmt_num(tmax_j2)
        if len(m["om"]) > 1:
            row[f"{m['id']}_submodel"] = sub
    return row


# ---------------------------------------------------------------------------
# Wunderground (même chaîne que lib/wunderground.ts)
# ---------------------------------------------------------------------------

_wu_key: str | None = None
_wu_key_at = 0.0


def wu_api_key() -> str:
    global _wu_key, _wu_key_at
    if _wu_key and (time.monotonic() - _wu_key_at) < 12 * 3600:
        return _wu_key
    html = http_get(
        "https://www.wunderground.com/",
        timeout=12,
        headers={"User-Agent": UA_BROWSER, "Accept": "text/html"},
    )
    m = re.search(r"apiKey=([A-Za-z0-9]{20,})", html)
    if not m:
        raise HttpError("apiKey WU introuvable dans le HTML")
    _wu_key = m.group(1)
    _wu_key_at = time.monotonic()
    return _wu_key


def _wu_by_date(times: list[Any], values: list[Any]) -> dict[str, float]:
    out: dict[str, float] = {}
    for t, v in zip(times, values):
        if not t or not isinstance(v, (int, float)):
            continue
        date = str(t)[:10]
        out[date] = float(v)
    return out


def fetch_wunderground(icao: str, hour_iso: str, local_date: str) -> dict[str, str]:
    blank = {
        "wu_now_c": "",
        "wu_tmax_j": "",
        "wu_tmax_j1": "",
        "wu_tmax_j2": "",
        "wu_obs_tmax_j": "",
    }
    key = wu_api_key()
    common = (
        f"apiKey={urllib.parse.quote(key)}"
        f"&icaoCode={urllib.parse.quote(icao)}"
        "&units=m&language=en-US&format=json"
    )
    hdrs = {"User-Agent": UA_BROWSER, "Accept": "application/json"}
    forecast: dict[str, float] = {}
    hourly_max: dict[str, float] = {}
    now: float | None = None
    obs: dict[str, float] = {}

    try:
        daily = http_json(
            f"https://api.weather.com/v3/wx/forecast/daily/7day?{common}",
            timeout=12,
            headers=hdrs,
        )
        highs = daily.get("calendarDayTemperatureMax") or daily.get("temperatureMax") or []
        forecast = _wu_by_date(daily.get("validTimeLocal") or [], highs)
    except Exception as err:
        log.warning("wu daily/7day %s: %s", icao, err)

    try:
        hist = http_json(
            f"https://api.weather.com/v3/wx/conditions/historical/dailysummary/30day?{common}",
            timeout=12,
            headers=hdrs,
        )
        obs = _wu_by_date(hist.get("validTimeLocal") or [], hist.get("temperatureMax") or [])
    except Exception as err:
        log.warning("wu dailysummary %s: %s", icao, err)

    try:
        hr = http_json(
            f"https://api.weather.com/v3/wx/forecast/hourly/15day?{common}",
            timeout=12,
            headers=hdrs,
        )
        times = [str(t) for t in (hr.get("validTimeLocal") or [])]
        temps = hr.get("temperature") or []
        peaks: dict[str, float] = {}
        for t, v in zip(times, temps):
            if not isinstance(v, (int, float)):
                continue
            fv = float(v)
            if t.startswith(hour_iso):
                now = fv
            date = t[:10]
            prev = peaks.get(date)
            if prev is None or fv > prev:
                peaks[date] = fv
        hourly_max = peaks
    except Exception as err:
        log.warning("wu hourly/15day %s: %s", icao, err)

    if not forecast and not hourly_max and now is None and not obs:
        raise HttpError("wunderground: aucune donnée")

    def tmax(date: str) -> float | None:
        if date in hourly_max:
            return hourly_max[date]
        return forecast.get(date)

    d1 = add_days(local_date, 1)
    d2 = add_days(local_date, 2)
    blank["wu_now_c"] = fmt_num(now)
    blank["wu_tmax_j"] = fmt_num(tmax(local_date))
    blank["wu_tmax_j1"] = fmt_num(tmax(d1))
    blank["wu_tmax_j2"] = fmt_num(tmax(d2))
    blank["wu_obs_tmax_j"] = fmt_num(obs.get(local_date))
    return blank


# ---------------------------------------------------------------------------
# GEFS ensemble (même API que lib/gefs.ts)
# ---------------------------------------------------------------------------

def gefs_cycle_label(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    utc_h = now.hour + now.minute / 60
    run = int((utc_h - 5) // 6) * 6
    while run < 0:
        run += 24
    return f"{run:02d}Z"


def _gefs_members(daily: dict[str, Any]) -> list[list[float | None]]:
    cols: list[list[float | None]] = []

    def as_nums(raw: Any) -> list[float | None]:
        if not isinstance(raw, list):
            return []
        out: list[float | None] = []
        for v in raw:
            out.append(float(v) if isinstance(v, (int, float)) else None)
        return out

    control = as_nums(daily.get("temperature_2m_max"))
    if control:
        cols.append(control)
    for i in range(1, 31):
        col = as_nums(daily.get(f"temperature_2m_max_member{i:02d}"))
        if col:
            cols.append(col)
    return cols


def _gefs_stats(cols: list[list[float | None]], idx: int) -> dict[str, float | None]:
    vals = [col[idx] for col in cols if idx < len(col) and col[idx] is not None]
    nums = [float(v) for v in vals if v is not None]
    if not nums:
        return {"mean": None, "min": None, "max": None, "spread": None, "n": 0}
    lo, hi = min(nums), max(nums)
    return {
        "mean": sum(nums) / len(nums),
        "min": lo,
        "max": hi,
        "spread": hi - lo,
        "n": len(nums),
    }


def fetch_gefs(lat: float, lon: float, tz_name: str, local_date: str) -> dict[str, str]:
    params = {
        "latitude": f"{lat:.5f}",
        "longitude": f"{lon:.5f}",
        "daily": "temperature_2m_max",
        "models": "gfs025",
        "timezone": tz_name,
        "forecast_days": "4",
        "temperature_unit": "celsius",
        "cell_selection": "nearest",
    }
    url = "https://ensemble-api.open-meteo.com/v1/ensemble?" + urllib.parse.urlencode(params)
    data = http_json(url, timeout=25)
    if data.get("error"):
        raise HttpError(str(data.get("reason") or "GEFS Open-Meteo error"))
    daily = data.get("daily") or {}
    times = [str(t) for t in (daily.get("time") or [])]
    cols = _gefs_members(daily)
    if not cols:
        raise HttpError("GEFS: pas de temperature_2m_max")

    row = {"gefs_cycle": gefs_cycle_label()}
    for suffix, date in (("j", local_date), ("j1", add_days(local_date, 1)), ("j2", add_days(local_date, 2))):
        try:
            idx = times.index(date)
        except ValueError:
            idx = -1
        stats = _gefs_stats(cols, idx) if idx >= 0 else {"mean": None, "min": None, "max": None, "spread": None, "n": 0}
        n = stats["n"] or 0
        row[f"gefs_mean_{suffix}"] = fmt_num(stats["mean"])  # type: ignore[arg-type]
        row[f"gefs_min_{suffix}"] = fmt_num(stats["min"])  # type: ignore[arg-type]
        row[f"gefs_max_{suffix}"] = fmt_num(stats["max"])  # type: ignore[arg-type]
        row[f"gefs_spread_{suffix}"] = fmt_num(stats["spread"])  # type: ignore[arg-type]
        row[f"gefs_n_{suffix}"] = str(int(n)) if n else ""
    return row


# ---------------------------------------------------------------------------
# METAR
# ---------------------------------------------------------------------------

def parse_metar_temp_c(raw: str) -> float | None:
    t = re.search(r"\bT([01])(\d{3})[01]\d{3}\b", raw)
    if t:
        sign = -1 if t.group(1) == "1" else 1
        return sign * int(t.group(2)) / 10
    m = re.search(r"(?:^|\s)(M?\d{2})/(M?\d{2}|//)(?:\s|$)", raw)
    if not m:
        return None
    tt = m.group(1)
    return -int(tt[1:]) if tt.startswith("M") else float(int(tt))


def parse_tgftp_stamp(header: str) -> datetime | None:
    m = re.match(r"^(\d{4})/(\d{2})/(\d{2})\s+(\d{2}):(\d{2})", header)
    if not m:
        return None
    return datetime(
        int(m.group(1)), int(m.group(2)), int(m.group(3)),
        int(m.group(4)), int(m.group(5)), tzinfo=timezone.utc,
    )


def fetch_metar(icao: str) -> tuple[float | None, str]:
    url = f"https://tgftp.nws.noaa.gov/data/observations/metar/stations/{icao}.TXT"
    try:
        text = http_get(url, timeout=8, headers={"Accept": "text/plain"})
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        stamp = parse_tgftp_stamp(lines[0]) if lines else None
        raw = next((ln for ln in lines if ln.startswith(icao)), lines[1] if len(lines) > 1 else (lines[0] if lines else ""))
        temp = parse_metar_temp_c(raw)
        if temp is not None:
            obs = stamp.strftime("%Y-%m-%dT%H:%M:%SZ") if stamp else ""
            return temp, obs
    except Exception as err:
        log.warning("tgftp %s: %s", icao, err)

    url = f"https://aviationweather.gov/api/data/metar?ids={icao}&format=json&hours=2"
    try:
        data = http_json(url, timeout=8)
        row = data[0] if isinstance(data, list) and data else None
        if not row:
            return None, ""
        raw = row.get("rawOb") or ""
        temp = parse_metar_temp_c(raw) if raw else None
        if temp is None and isinstance(row.get("temp"), (int, float)):
            temp = float(row["temp"])
        obs = row.get("reportTime") or ""
        if not obs and row.get("obsTime"):
            obs = datetime.fromtimestamp(row["obsTime"], tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return temp, str(obs)
    except Exception as err:
        log.warning("aviationweather %s: %s", icao, err)
        return None, ""


# ---------------------------------------------------------------------------
# PWS AWEKAS
# ---------------------------------------------------------------------------

def fetch_awekas(url: str) -> dict[str, str]:
    empty = {"pws_temp_c": "", "pws_id": "", "pws_name": "", "pws_obs_utc": ""}
    pws_id = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("id", [""])[0]
    hdrs = {"User-Agent": UA_BROWSER, "Accept": "text/html,application/xhtml+xml"}

    def load_secid() -> tuple[str, str]:
        html = http_get(url, timeout=12, headers=hdrs)
        m = re.search(r"var\s+secid\s*=\s*['\"]([^'\"]+)['\"]", html, re.I)
        if not m:
            raise HttpError("secid AWEKAS introuvable")
        name_m = re.search(r"de la station\s+([^<]+)", html, re.I) or re.search(
            r"station\.php\?id=\d+[^>]*>([^<]+)<", html, re.I
        )
        name = re.sub(r"\s+", " ", name_m.group(1)).strip() if name_m else ""
        return m.group(1), name

    try:
        secid, name = load_secid()
        data_url = f"https://www.awekas.at/common/ajax_instrument_data.php?secid={secid}&teh=c"
        payload = http_json(
            data_url,
            timeout=10,
            headers={"User-Agent": UA_BROWSER, "Accept": "*/*", "Referer": "https://www.awekas.at/"},
        )
        if str(payload.get("status")) != "1":
            secid, name = load_secid()
            data_url = f"https://www.awekas.at/common/ajax_instrument_data.php?secid={secid}&teh=c"
            payload = http_json(
                data_url,
                timeout=10,
                headers={"User-Agent": UA_BROWSER, "Accept": "*/*", "Referer": "https://www.awekas.at/"},
            )
        if str(payload.get("status")) != "1":
            raise HttpError(f"AWEKAS status {payload.get('status')}")
        raw_temp = (payload.get("data") or [None])[0]
        temp = float(str(raw_temp).replace(",", ".")) if raw_temp not in (None, "") else None
        report = payload.get("reporttime")
        obs = ""
        if report not in (None, ""):
            n = float(report)
            ms = n * 1000 if n < 1e12 else n
            obs = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if temp is None:
            raise HttpError("température AWEKAS absente")
        return {
            "pws_temp_c": fmt_num(temp),
            "pws_id": pws_id,
            "pws_name": name,
            "pws_obs_utc": obs,
        }
    except Exception as err:
        log.warning("pws %s: %s", url, err)
        empty["pws_id"] = pws_id
        raise


def fetch_pws(icao: str) -> tuple[dict[str, str], str | None]:
    urls = PWS_STATIONS.get(icao, [])
    blank = {"pws_temp_c": "", "pws_id": "", "pws_name": "", "pws_obs_utc": ""}
    if not urls:
        return blank, None
    try:
        return fetch_awekas(urls[0]), None
    except Exception as err:
        return blank, f"pws: {err}"


# ---------------------------------------------------------------------------
# Polymarket
# ---------------------------------------------------------------------------

def as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def parse_bucket_bounds(label: str) -> tuple[float | None, float | None]:
    compact = re.sub(r"\s+", " ", label).strip()
    n = r"(-?\d+(?:\.\d+)?)"
    m = re.match(rf"^{n}\s*°?\s*[CF]?\s+or\s+(below|lower|under)\b", compact, re.I)
    if m:
        return None, float(m.group(1))
    m = re.match(rf"^{n}\s*°?\s*[CF]?\s+or\s+(higher|above|over|more)\b", compact, re.I)
    if m:
        return float(m.group(1)), None
    m = re.match(rf"^{n}\s*[-–—]\s*{n}", compact)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.match(rf"^{n}", compact)
    if m:
        return float(m.group(1)), float(m.group(1))
    return None, None


def icao_from_event(city: str, description: str, resolution: str) -> str | None:
    blob = f"{resolution}\n{description}"
    wu = re.search(r"wunderground\.com/(?:history/daily|hourly)/([A-Z][A-Z0-9]{3})", blob, re.I)
    if wu:
        code = wu.group(1).upper()
        if code in STATIONS:
            return code
    wrh = re.search(r"[?&]site=([A-Za-z0-9]{3,5})", blob)
    if wrh and wrh.group(1).upper() in STATIONS:
        return wrh.group(1).upper()
    return CITY_TO_ICAO.get(city.lower())


def parse_poly_event(raw: dict[str, Any]) -> dict[str, Any] | None:
    title = str(raw.get("title") or "").strip()
    m = TITLE_RE.match(title)
    if not m:
        return None
    city = m.group(1).strip()
    month = MONTHS.get(m.group(2).lower(), 0)
    day = int(m.group(3))
    year = int(m.group(4)) if m.group(4) else 0
    if not year:
        dm = re.search(r"on\s+(\d{1,2})\s+([A-Za-z]+)\s+'(\d{2})\b", str(raw.get("description") or ""), re.I)
        if dm:
            year = 2000 + int(dm.group(3))
    if not year or not month or not day:
        return None
    icao = icao_from_event(city, str(raw.get("description") or ""), str(raw.get("resolutionSource") or ""))
    if not icao:
        return None
    buckets = []
    for mk in raw.get("markets") or []:
        label = str(mk.get("groupItemTitle") or mk.get("question") or "").strip()
        lo, hi = parse_bucket_bounds(label)
        outcomes = as_list(mk.get("outcomes"))
        prices = as_list(mk.get("outcomePrices"))
        yes_idx = next((i for i, o in enumerate(outcomes) if str(o).lower() == "yes"), 0)
        try:
            yes = float(prices[yes_idx]) if yes_idx < len(prices) else 0.0
        except (TypeError, ValueError):
            yes = 0.0
        buckets.append({"label": label, "lo": lo, "hi": hi, "yes": yes})
    fav = max(buckets, key=lambda b: b["yes"]) if buckets else None
    return {
        "icao": icao,
        "local_date": f"{year:04d}-{month:02d}-{day:02d}",
        "slug": str(raw.get("slug") or ""),
        "favorite": fav,
    }


def fetch_poly_events() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    q = urllib.parse.quote("Highest temperature in")
    for page in range(1, 9):
        url = f"{GAMMA}/public-search?q={q}&events_status=active&limit_per_type=50&page={page}"
        res = http_json(url, timeout=25)
        events = res.get("events") or []
        if not events:
            break
        for raw in events:
            parsed = parse_poly_event(raw)
            if not parsed or parsed["slug"] in seen:
                continue
            seen.add(parsed["slug"])
            out.append(parsed)
        if not (res.get("pagination") or {}).get("hasMore"):
            break
    return out


def poly_columns(events: list[dict[str, Any]], icao: str, local_date: str) -> dict[str, str]:
    blank = {
        "poly_favorite": "",
        "poly_favorite_lo": "",
        "poly_favorite_hi": "",
        "poly_favorite_yes": "",
        "poly_event_date": "",
        "poly_slug": "",
    }
    hits = [e for e in events if e["icao"] == icao]
    event = next((e for e in hits if e["local_date"] == local_date), None)
    if not event:
        event = next(iter(hits), None)
    if not event:
        return blank
    fav = event.get("favorite")
    return {
        "poly_favorite": (fav or {}).get("label", ""),
        "poly_favorite_lo": "" if not fav or fav.get("lo") is None else str(int(fav["lo"])),
        "poly_favorite_hi": "" if not fav or fav.get("hi") is None else str(int(fav["hi"])),
        "poly_favorite_yes": fmt_num((fav or {}).get("yes"), 4) if fav else "",
        "poly_event_date": event["local_date"],
        "poly_slug": event["slug"],
    }


# ---------------------------------------------------------------------------
# Cycle
# ---------------------------------------------------------------------------

def collect_station(
    icao: str,
    fetched_at: datetime,
    poly_events: list[dict[str, Any]] | None,
    poly_err: str | None,
) -> dict[str, str]:
    meta = STATIONS[icao]
    tz = ZoneInfo(meta["tz"])
    local = fetched_at.astimezone(tz)
    local_date = local.strftime("%Y-%m-%d")
    hour_iso = local.strftime("%Y-%m-%dT%H")
    errors: list[str] = []

    row: dict[str, str] = {k: "" for k in FIELDS}
    row["fetched_at_utc"] = fetched_at.strftime("%Y-%m-%dT%H:%M:%SZ")
    row["local_datetime"] = local.isoformat(timespec="seconds")
    row["local_date"] = local_date
    row["local_hour"] = f"{local.hour:02d}"

    try:
        temp, obs = fetch_metar(meta["metar"])
        row["metar_temp_c"] = fmt_num(temp)
        row["metar_obs_utc"] = obs
        if temp is None:
            errors.append("metar: no temp")
    except Exception as err:
        errors.append(f"metar: {err}")

    pws_row, pws_err = fetch_pws(icao)
    row.update(pws_row)
    if pws_err:
        errors.append(pws_err)

    try:
        hourly = fetch_models(meta["lat"], meta["lon"], meta["tz"])
        row.update(model_columns(hourly, local_date, hour_iso))
    except Exception as err:
        errors.append(f"open-meteo: {err}")
        log.warning("open-meteo %s: %s", icao, err)

    try:
        row.update(fetch_wunderground(meta["metar"], hour_iso, local_date))
    except Exception as err:
        errors.append(f"wunderground: {err}")
        log.warning("wunderground %s: %s", icao, err)

    row.update(consensus_columns(row))

    try:
        row.update(fetch_gefs(meta["lat"], meta["lon"], meta["tz"], local_date))
    except Exception as err:
        errors.append(f"gefs: {err}")
        log.warning("gefs %s: %s", icao, err)

    if poly_err:
        errors.append(f"polymarket: {poly_err}")
    else:
        row.update(poly_columns(poly_events or [], icao, local_date))
        if not row.get("poly_favorite"):
            errors.append("polymarket: no market")

    row["errors"] = "; ".join(errors)
    return row


def run_cycle(out_dir: Path, icaos: list[str]) -> None:
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0)
    log.info("cycle %s stations=%s", fetched_at.strftime("%Y-%m-%dT%H:%M:%SZ"), ",".join(icaos))

    poly_events: list[dict[str, Any]] = []
    poly_err: str | None = None
    try:
        poly_events = fetch_poly_events()
        log.info("polymarket %d events", len(poly_events))
    except Exception as err:
        poly_err = str(err)
        log.warning("polymarket: %s", err)

    for icao in icaos:
        try:
            row = collect_station(icao, fetched_at, poly_events, poly_err)
            path = out_dir / f"{icao}.csv"
            append_row(path, row)
            log.info(
                "%s metar=%s pws=%s ecmwf=%s wu=%s cons=%s gefs=%s fav=%s (%s) -> %s",
                icao,
                row.get("metar_temp_c") or "n/a",
                row.get("pws_temp_c") or "n/a",
                row.get("ecmwf_ifs_tmax_j") or "n/a",
                row.get("wu_tmax_j") or "n/a",
                row.get("cons_mean_j") or "n/a",
                row.get("gefs_mean_j") or "n/a",
                row.get("poly_favorite") or "n/a",
                row.get("poly_favorite_yes") or "",
                path,
            )
        except Exception:
            log.exception("station %s failed", icao)


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive Tmax modèles / METAR / PWS / WU / GEFS / Polymarket")
    parser.add_argument("--once", action="store_true", help="un seul cycle puis exit")
    parser.add_argument("--interval", type=int, default=INTERVAL_SEC, help="secondes entre cycles (défaut 1800)")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "data",
        help="répertoire des CSV",
    )
    parser.add_argument(
        "--stations",
        default="LFPB,LIMC,EHAM",
        help="ICAO séparés par des virgules",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)sZ %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    logging.Formatter.converter = time.gmtime

    icaos = [s.strip().upper() for s in args.stations.split(",") if s.strip()]
    unknown = [s for s in icaos if s not in STATIONS]
    if unknown:
        log.error("stations inconnues: %s (connues: %s)", ",".join(unknown), ",".join(STATIONS))
        return 2

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stop = False

    def _handle(signum: int, _frame: Any) -> None:
        nonlocal stop
        log.info("signal %s, arrêt après ce cycle", signum)
        stop = True

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)

    log.info("start out=%s interval=%ss stations=%s", args.out_dir, args.interval, ",".join(icaos))
    while not stop:
        t0 = time.monotonic()
        try:
            run_cycle(args.out_dir, icaos)
        except Exception:
            log.exception("cycle crashed")
        if args.once or stop:
            break
        wait = max(0, args.interval - (time.monotonic() - t0))
        log.info("sleep %.0fs", wait)
        # sleep par tranches pour réagir à SIGTERM
        end = time.monotonic() + wait
        while not stop and time.monotonic() < end:
            time.sleep(min(5, end - time.monotonic()))
    log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
