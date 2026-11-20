import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_HOLDINGS_FILE, loadHoldingsFile, type FileFund } from "./holdings-file.ts";
import { PREFETCH_BENCHMARK_TICKERS } from "./benchmarks.ts";
import { displaySymbol, issuerKey } from "./tickers.ts";

/**
 * Optional pre-built ticker catalog (market-desk-tickers/v1), kept next to holdings.json
 * and never committed. Override with LOOKTHRU_TICKERS_FILE.
 */
export const DEFAULT_TICKERS_FILE = "/data/lookthru/tickers.json";

export const TICKER_SEARCH_LIMIT = 10;

export type TickerRecord = {
  raw: string[];
  ticker: string;
  name: string;
  provider: string;
  exchange: string;
  isFund: boolean;
  yahooVerified: boolean;
};

export type TickerSearchHit = {
  ticker: string;
  displaySymbol: string;
  name: string;
  provider: string;
  isFund: boolean;
};

type LoadedTickers = { path: string; mtime: number; records: TickerRecord[] };
let loaded: LoadedTickers | null = null;

function holdingsPath(path?: string): string {
  return path || process.env["LOOKTHRU_HOLDINGS_FILE"] || DEFAULT_HOLDINGS_FILE;
}

/** Default tickers.json sits next to the holdings file. */
export function tickersFilePath(path?: string): string {
  if (path) return path;
  if (process.env["LOOKTHRU_TICKERS_FILE"]) return process.env["LOOKTHRU_TICKERS_FILE"];
  const holdings = holdingsPath();
  if (holdings.toLowerCase().endsWith("holdings.json")) {
    return holdings.slice(0, -"holdings.json".length) + "tickers.json";
  }
  return join(dirname(holdings), "tickers.json");
}

function asRecord(raw: unknown): TickerRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
  if (!ticker) return null;
  const rawSpellings = Array.isArray(r.raw) ? r.raw.filter((s): s is string => typeof s === "string") : [];
  return {
    raw: rawSpellings,
    ticker,
    name: typeof r.name === "string" ? r.name : "",
    provider: typeof r.provider === "string" ? r.provider : "",
    exchange: typeof r.exchange === "string" ? r.exchange : "",
    isFund: r.isFund !== false,
    yahooVerified: r.yahooVerified === true,
  };
}

export function loadTickersFile(path?: string): TickerRecord[] | null {
  const file = tickersFilePath(path);
  try {
    const mtime = statSync(file).mtimeMs;
    if (loaded && loaded.path === file && loaded.mtime === mtime) return loaded.records;
    const json = JSON.parse(readFileSync(file, "utf8")) as { tickers?: unknown };
    const records: TickerRecord[] = [];
    const seen = new Set<string>();
    const items = Array.isArray(json.tickers) ? json.tickers : [];
    for (const item of items) {
      const rec = asRecord(item);
      if (!rec || seen.has(rec.ticker)) continue;
      seen.add(rec.ticker);
      records.push(rec);
    }
    loaded = { path: file, mtime, records };
    return records;
  } catch {
    return loaded && loaded.path === file ? loaded.records : null;
  }
}

function looksLikeTicker(symbol: string): boolean {
  return /^[A-Z0-9][A-Z0-9.\-=]*$/.test(symbol) && !["CASH", "OPTIONS", "OTHER"].includes(symbol);
}

function preferredSymbol(symbols: string[]): string {
  return symbols.find((s) => /\.(TO|NE|V|CN|NEO)$/i.test(s)) ?? symbols[0] ?? "";
}

/** Fund keys (and optional holding names) from holdings.json when tickers.json is missing. */
export function holdingsFallbackTickers(holdingsFile?: string): TickerRecord[] {
  const funds = loadHoldingsFile(holdingsFile);
  const byFund = new Map<FileFund, string[]>();
  for (const [symbol, fund] of funds) {
    const list = byFund.get(fund) ?? [];
    list.push(symbol);
    byFund.set(fund, list);
  }
  const records: TickerRecord[] = [];
  const seen = new Set<string>();
  for (const [fund, symbols] of byFund) {
    const ticker = preferredSymbol(symbols).toUpperCase();
    if (!ticker || !looksLikeTicker(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    const raw = [...new Set(symbols.map((s) => s.toUpperCase()).concat(displaySymbol(ticker)))];
    records.push({
      raw,
      ticker,
      name: fund.name || displaySymbol(ticker),
      provider: fund.issuer || "",
      exchange: /\.TO$/i.test(ticker) ? "TSX" : "",
      isFund: true,
      yahooVerified: false,
    });
  }
  return records;
}

export type UniverseTicker = TickerRecord & { role: "fund" | "holding" };

/**
 * Tickers to prefetch: funds first, then other catalog names, then remaining holding symbols.
 * Uses tickers.json when present, otherwise holdings.json fund keys.
 */
export function loadTickerUniverse(opts?: { tickersPath?: string; holdingsPath?: string }): UniverseTicker[] {
  const catalog = loadTickersFile(opts?.tickersPath);
  const fundsFromFile = holdingsFallbackTickers(opts?.holdingsPath);
  const out: UniverseTicker[] = [];
  const seen = new Set<string>();

  function add(rec: TickerRecord, role: UniverseTicker["role"]) {
    if (!looksLikeTicker(rec.ticker) || seen.has(rec.ticker)) return;
    seen.add(rec.ticker);
    out.push({ ...rec, role });
  }

  for (const ticker of PREFETCH_BENCHMARK_TICKERS) {
    add(
      {
        raw: [ticker],
        ticker,
        name: ticker,
        provider: "",
        exchange: "TSX",
        isFund: true,
        yahooVerified: true,
      },
      "fund",
    );
  }

  const source = catalog && catalog.length ? catalog : fundsFromFile;
  for (const rec of source.filter((r) => r.isFund)) add(rec, "fund");
  for (const rec of source.filter((r) => !r.isFund)) add(rec, "holding");

  // Holding-level tickers from the holdings file, after funds.
  const fundsMap = loadHoldingsFile(opts?.holdingsPath);
  for (const fund of new Set(fundsMap.values())) {
    for (const h of fund.holdings) {
      const symbol = (h.symbol || "").toUpperCase();
      if (!looksLikeTicker(symbol)) continue;
      add(
        {
          raw: [symbol, displaySymbol(symbol)],
          ticker: symbol,
          name: h.name || displaySymbol(symbol),
          provider: "",
          exchange: "",
          isFund: false,
          yahooVerified: false,
        },
        "holding",
      );
    }
  }
  return out;
}

function nameWordPrefix(name: string, q: string): boolean {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .some((w) => w.toUpperCase().startsWith(q));
}

export function tickerMatches(rec: TickerRecord, rawQuery: string): { matched: boolean; exact: boolean } {
  const q = rawQuery.trim().toUpperCase();
  if (!q) return { matched: false, exact: false };
  const bare = issuerKey(rec.ticker).toUpperCase();
  const ticker = rec.ticker.toUpperCase();
  const raws = rec.raw.map((s) => s.toUpperCase());
  const exact = bare === q || ticker === q || raws.includes(q);
  const prefix =
    exact ||
    bare.startsWith(q) ||
    ticker.startsWith(q) ||
    raws.some((s) => s.startsWith(q)) ||
    nameWordPrefix(rec.name, q);
  return { matched: prefix, exact };
}

export function searchTickers(query: string, records: TickerRecord[], limit = TICKER_SEARCH_LIMIT): TickerSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const ranked = records
    .map((rec) => ({ rec, ...tickerMatches(rec, q) }))
    .filter((x) => x.matched)
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.rec.isFund !== b.rec.isFund) return a.rec.isFund ? -1 : 1;
      return a.rec.ticker.localeCompare(b.rec.ticker);
    })
    .slice(0, limit);
  return ranked.map(({ rec }) => ({
    ticker: rec.ticker,
    displaySymbol: displaySymbol(rec.ticker),
    name: rec.name || displaySymbol(rec.ticker),
    provider: rec.provider,
    isFund: rec.isFund,
  }));
}

/** Load the catalog (or holdings fallback) and prefix-search it. */
export function searchFundTickers(
  query: string,
  opts?: { tickersPath?: string; holdingsPath?: string; limit?: number },
): TickerSearchHit[] {
  const catalog = loadTickersFile(opts?.tickersPath);
  const records = catalog && catalog.length ? catalog : holdingsFallbackTickers(opts?.holdingsPath);
  return searchTickers(query, records, opts?.limit ?? TICKER_SEARCH_LIMIT);
}

export function tickersFileExists(path?: string): boolean {
  return existsSync(tickersFilePath(path));
}
