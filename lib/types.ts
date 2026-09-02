export type TempUnit = "C" | "F";

export type ResolutionKind = "noaa_wrh" | "wunderground" | "hko" | "other";

export type Horizon = "J" | "J+1" | "J+2" | "past" | "later";

export type MarketStatus =
  | "live"
  | "awaiting_daily"
  | "resolved"
  | "upcoming";

export type ModelStatus = "ok" | "out_of_domain" | "out_of_horizon" | "unavailable" | "error";

export type Bucket = {
  id: string;
  label: string;
  lo: number | null;
  hi: number | null;
  yesPrice: number;
  volume: number;
  slug: string;
  question: string;
};

export type ParsedEvent = {
  eventId: string;
  slug: string;
  title: string;
  city: string;
  localDate: string;
  unit: TempUnit;
  icao: string;
  metarIcao: string;
  resolutionKind: ResolutionKind;
  resolutionUrl: string;
  wuHistoryUrl: string | null;
  wuHourlyUrlTemplate: string | null;
  description: string;
  buckets: Bucket[];
  volume: number;
  closed: boolean;
  polymarketUrl: string;
};

export type StationMeta = {
  icao: string;
  metarIcao: string;
  name: string;
  lat: number;
  lon: number;
  elevM: number | null;
  country: string;
  region: string;
  timezone: string;
  site: string;
};

export type MetarSnapshot = {
  icao: string;
  obsTimeIso: string;
  obsAgeMin: number;
  tempC: number | null;
  tempMarket: number | null;
  windDir: number | null;
  windKt: number | null;
  wx: string | null;
  raw: string | null;
  fetchedAt: string;
};

export type DailyObs = {
  date: string;
  runningMaxMarket: number | null;
  runningMaxC: number | null;
  nObs: number;
  lastObsIso: string | null;
  finalized: boolean;
  source: string;
};

export type ModelDayValue = {
  modelId: string;
  label: string;
  group: "primary" | "extra";
  submodel: string | null;
  tmax: number | null;
  tmaxTrunc: number | null;
  peakLocal: string | null;
  status: ModelStatus;
  runLabel: string | null;
  runAgeHours: number | null;
  beatenByMetar: boolean;
};

export type GefsDay = {
  date: string;
  mean: number | null;
  min: number | null;
  max: number | null;
  spread: number | null;
  n: number;
};

export type Consensus = {
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  n: number;
  meanTrunc: number | null;
  includesWu: boolean;
};

export type SourceError = {
  source: string;
  message: string;
};

export type HourlyPoint = {
  time: string;
  gfs: number | null;
  ecmwf: number | null;
  metar: number | null;
};

export type HourlyRow = {
  id: string;
  label: string;
  kind: "metar" | "wu" | "primary" | "extra";
  temps: Array<number | null>;
  status: ModelStatus | "ok";
};

export type HourlyDayGrid = {
  date: string;
  horizon: Horizon;
  hours: string[];
  rows: HourlyRow[];
};

export type StationIndexItem = {
  icao: string;
  metarIcao: string;
  city: string;
  stationName: string;
  country: string;
  unit: TempUnit;
};

export type DashboardRow = {
  slug: string;
  eventId: string;
  city: string;
  icao: string;
  metarIcao: string;
  localDate: string;
  horizon: Horizon;
  unit: TempUnit;
  timezone: string;
  country: string;
  region: string;
  volume: number;
  status: MarketStatus;
  polymarketUrl: string;
  resolutionKind: ResolutionKind;
  resolutionUrl: string;
  wuHistoryUrl: string | null;
  wuHourlyUrl: string | null;
  metarRawUrl: string;
  stationName: string;
  lat: number;
  lon: number;
  lastMetar: MetarSnapshot | null;
  runningMax: number | null;
  runningMaxFinalized: boolean;
  wuForecastTmax: number | null;
  wuForecastTmaxTrunc: number | null;
  wuDailyTmax: number | null;
  wuDailyStatus: "ok" | "provisional" | "missing" | "error";
  consensus: Consensus;
  favoriteBucket: string | null;
  consensusBucket: string | null;
  wuBucket: string | null;
  runningMaxBucket: string | null;
  marketFavoriteBucket: string | null;
  buckets: Bucket[];
  models: ModelDayValue[];
  errors: SourceError[];
  metarAgeMin: number | null;
  wuFetchedAt: string | null;
  modelsFetchedAt: string | null;
};

export type StationDay = {
  localDate: string;
  horizon: Horizon;
  market: ParsedEvent | null;
  runningMax: DailyObs | null;
  wuForecastTmax: number | null;
  wuDailyTmax: number | null;
  wuDailyStatus: "ok" | "provisional" | "missing" | "error";
  consensus: Consensus;
  models: ModelDayValue[];
  buckets: Bucket[];
  gefs: GefsDay | null;
};

export type WxChip = {
  kind: "fair" | "cloud" | "rain" | "storm" | "wind" | "fog";
  label: string;
};

export type WxOutlook = {
  chips: WxChip[];
  summary: string;
};

export type StationPayload = {
  station: StationMeta;
  unit: TempUnit;
  days: StationDay[];
  lastMetar: MetarSnapshot | null;
  wxOutlook: WxOutlook | null;
  hourlyJ: HourlyPoint[];
  hourlyDays: HourlyDayGrid[];
  errors: SourceError[];
  polymarketUrl: string | null;
  resolutionUrl: string | null;
  wuHistoryUrl: string | null;
  wuHourlyUrl: string | null;
  metarRawUrl: string;
  fetchedAt: string;
};
