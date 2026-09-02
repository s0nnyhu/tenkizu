export type ModelDef = {
  id: string;
  label: string;
  group: "primary" | "extra";
  /** Open-Meteo `models=` ids, preferred first (regional then global). */
  openMeteoIds: string[];
  coverage: "global" | "regional";
  cycleHours: number;
  lagHours: number;
  notes: string;
};

export const MODELS: ModelDef[] = [
  {
    id: "ecmwf_ifs",
    label: "ECMWF IFS",
    group: "primary",
    openMeteoIds: ["ecmwf_ifs"],
    coverage: "global",
    cycleHours: 6,
    lagHours: 7,
    notes: "ECMWF IFS ~9 km",
  },
  {
    id: "icon",
    label: "ICON",
    group: "primary",
    openMeteoIds: ["icon_eu", "icon_global"],
    coverage: "global",
    cycleHours: 3,
    lagHours: 4,
    notes: "DWD ICON-EU si dispo, sinon ICON global",
  },
  {
    id: "icon_d2",
    label: "ICON-D2",
    group: "extra",
    openMeteoIds: ["icon_d2"],
    coverage: "regional",
    cycleHours: 3,
    lagHours: 2,
    notes: "DWD ICON-D2 Europe centrale",
  },
  {
    id: "arome",
    label: "AROME",
    group: "primary",
    openMeteoIds: ["meteofrance_arome_france"],
    coverage: "regional",
    cycleHours: 3,
    lagHours: 2,
    notes: "Météo-France AROME France",
  },
  {
    id: "harmonie",
    label: "HARMONIE",
    group: "extra",
    openMeteoIds: ["knmi_harmonie_arome_netherlands", "knmi_harmonie_arome_europe"],
    coverage: "regional",
    cycleHours: 1,
    lagHours: 1,
    notes: "KNMI HARMONIE-AROME NL 2 km si dispo, sinon Europe 5.5 km",
  },
  {
    id: "gfs",
    label: "GFS",
    group: "primary",
    openMeteoIds: ["gfs013"],
    coverage: "global",
    cycleHours: 6,
    lagHours: 5,
    notes: "NOAA GFS 0.13°",
  },
  {
    id: "arpege",
    label: "ARPEGE",
    group: "primary",
    openMeteoIds: ["meteofrance_seamless"],
    coverage: "global",
    cycleHours: 6,
    lagHours: 4,
    notes: "Météo-France seamless (AROME si dispo, sinon ARPEGE)",
  },
  {
    id: "ukmo",
    label: "UKMO",
    group: "extra",
    openMeteoIds: ["ukmo_global_deterministic_10km"],
    coverage: "global",
    cycleHours: 6,
    lagHours: 4,
    notes: "Met Office global 10 km",
  },
  {
    id: "hrrr",
    label: "HRRR",
    group: "primary",
    openMeteoIds: ["ncep_hrrr_conus"],
    coverage: "regional",
    cycleHours: 1,
    lagHours: 1,
    notes: "NOAA HRRR CONUS",
  },
  {
    id: "cma",
    label: "CMA",
    group: "primary",
    openMeteoIds: ["cma_grapes_global"],
    coverage: "global",
    cycleHours: 6,
    lagHours: 6,
    notes: "CMA GRAPES",
  },
];

export const ALL_OPEN_METEO_IDS = [
  ...new Set(MODELS.flatMap((m) => m.openMeteoIds)),
];

export const PRIMARY_OM_IDS = [
  ...new Set(
    MODELS.filter((m) => m.group === "primary").flatMap((m) => m.openMeteoIds),
  ),
];

export const EXTRA_OM_IDS = [
  ...new Set(
    MODELS.filter((m) => m.group === "extra").flatMap((m) => m.openMeteoIds),
  ),
];

export function estimateRun(
  def: ModelDef,
  now = new Date(),
): { runUtc: string; ageHours: number } {
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const lag = def.lagHours;
  const cycle = def.cycleHours;
  let runHour = Math.floor((utcH - lag) / cycle) * cycle;
  let dayOffset = 0;
  while (runHour < 0) {
    runHour += 24;
    dayOffset -= 1;
  }
  const runDate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
      runHour,
      0,
      0,
    ),
  );
  const ageHours = (now.getTime() - runDate.getTime()) / 3_600_000;
  const hh = String(runDate.getUTCHours()).padStart(2, "0");
  return { runUtc: `${hh}Z (est.)`, ageHours };
}
