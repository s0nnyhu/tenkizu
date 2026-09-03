import { fetchText } from "./http";
import type { PwsReading, TempUnit } from "./types";
import { toMarketUnit } from "./units";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

type AwekasData = {
  status?: number | string;
  data?: Array<number | string | null>;
  reporttime?: string | number | null;
};

export type AwekasPws = Omit<PwsReading, "id" | "source" | "url">;

function parseSecid(html: string): string {
  const m = html.match(/var\s+secid\s*=\s*['"]([^'"]+)['"]/i);
  if (!m) throw new Error("secid AWEKAS introuvable");
  return m[1];
}

function parseName(html: string): string | null {
  const m =
    html.match(/de la station\s+([^<]+)/i) ??
    html.match(/station\.php\?id=\d+[^>]*>([^<]+)</i);
  const name = m?.[1]?.replace(/\s+/g, " ").trim();
  return name || null;
}

function toIso(reporttime: string | number | null | undefined): string | null {
  if (reporttime == null || reporttime === "") return null;
  const n = Number(reporttime);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function loadPage(url: string): Promise<{ html: string; secid: string }> {
  const html = await fetchText(url, {
    timeoutMs: 12_000,
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
  });
  return { html, secid: parseSecid(html) };
}

async function loadData(secid: string): Promise<AwekasData> {
  const url = `https://www.awekas.at/common/ajax_instrument_data.php?secid=${secid}&teh=c`;
  const text = await fetchText(url, {
    timeoutMs: 10_000,
    headers: {
      "User-Agent": UA,
      Accept: "*/*",
      Referer: "https://www.awekas.at/",
    },
  });
  return JSON.parse(text) as AwekasData;
}

export async function fetchAwekasPws(url: string, unit: TempUnit): Promise<AwekasPws> {
  const { html, secid } = await loadPage(url);
  let json = await loadData(secid);
  if (String(json.status) !== "1") {
    const retry = await loadPage(url);
    json = await loadData(retry.secid);
  }
  if (String(json.status) !== "1") {
    throw new Error(`AWEKAS status ${json.status ?? "?"}`);
  }
  const tempC = toNum(json.data?.[0]);
  return {
    name: parseName(html),
    tempC,
    tempMarket: tempC == null ? null : toMarketUnit(tempC, unit),
    obsTimeIso: toIso(json.reporttime),
    status: tempC == null ? "error" : "ok",
    error: tempC == null ? "température AWEKAS absente" : undefined,
  };
}
