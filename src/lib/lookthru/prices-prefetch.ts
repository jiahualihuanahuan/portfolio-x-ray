import { fundCandidates, normalizeFundQuery } from "./fund-lookup.ts";
import {
  buildHistoryFromRows,
  parseYahooChart,
  yahooChartUrl,
  unixFromDate,
  type FundHistoryResult,
} from "./fund-history.ts";
import {
  getDividends,
  getPrices,
  getSplits,
  getTickerMeta,
  hasCachedPrices,
  isTickerStale,
  priceDateRange,
  STALE_AFTER_MS,
  upsertDividends,
  upsertPrices,
  upsertSplits,
  upsertTickerMeta,
  type TickerMeta,
} from "./prices-db.ts";
import { loadTickerUniverse } from "./ticker-search.ts";

/** Same single User-Agent the rest of this app uses for Yahoo. No rotation, no proxies, no login. */
export const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const REQUEST_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 20_000;
const OVERLAP_DAYS = 3;
const MAX_RETRIES = 3;

export type PrefetchDeps = {
  fetch?: typeof fetch;
  now?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  dbPath?: string;
  tickersPath?: string;
  holdingsPath?: string;
  onTicker?: (event: { ticker: string; status: "ok" | "error" | "empty" | "skipped"; error?: string }) => void;
};

export type PrefetchResult = {
  ok: number;
  failed: number;
  skipped: number;
  elapsedMs: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isDisabled(): boolean {
  const v = (process.env["PRICES_PREFETCH"] ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function shouldAutostart(): boolean {
  if (typeof process.env["NODE_TEST_CONTEXT"] === "string") return false;
  if (isDisabled()) return false;
  const life = process.env["npm_lifecycle_event"] ?? "";
  if (["build", "build:dev", "typecheck", "lint", "test", "test:scripts"].includes(life)) return false;
  const argv = process.argv.join(" ");
  if (/\bvite\b/.test(argv) && /\bbuild\b/.test(argv)) return false;
  return true;
}

async function yahooGet(url: string, deps: PrefetchDeps): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  let wait = 15_000;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": YAHOO_UA, Accept: "application/json,text/plain,*/*" },
      });
      if (res.status === 429) {
        lastErr = new Error(`Yahoo rate-limited (429) for ${url}`);
        await sleep(wait);
        wait = Math.min(wait * 2, 120_000);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("Yahoo request failed");
}

export function incrementalPeriod(lastDate: string, nowMs: number): { period1: number; period2: number } {
  const last = unixFromDate(lastDate);
  const period1 = last - OVERLAP_DAYS * 86_400;
  const period2 = Math.floor(nowMs / 1000);
  return { period1, period2: Math.max(period2, period1 + 86_400) };
}

function storeParsed(
  ticker: string,
  parsed: NonNullable<ReturnType<typeof parseYahooChart>>,
  now: number,
  dbPath?: string,
): TickerMeta {
  upsertPrices(
    parsed.prices.map((p) => ({ ticker, date: p.date, close: p.close, adjclose: p.adjclose })),
    dbPath,
  );
  upsertDividends(
    parsed.dividends.map((d) => ({ ticker, date: d.date, amount: d.amount })),
    dbPath,
  );
  upsertSplits(
    parsed.splits.map((s) => ({ ticker, date: s.date, numerator: s.numerator, denominator: s.denominator })),
    dbPath,
  );
  const range = priceDateRange(ticker, dbPath);
  const meta: TickerMeta = {
    ticker,
    lastFetched: now,
    firstDate: range.firstDate,
    lastDate: range.lastDate,
    status: range.count > 0 ? "ok" : "empty",
    error: range.count > 0 ? null : "Yahoo returned no usable daily prices.",
  };
  upsertTickerMeta(meta, dbPath);
  return meta;
}

function markError(ticker: string, now: number, error: string, dbPath?: string): TickerMeta {
  const range = priceDateRange(ticker, dbPath);
  const meta: TickerMeta = {
    ticker,
    lastFetched: now,
    firstDate: range.firstDate,
    lastDate: range.lastDate,
    status: range.count > 0 ? "ok" : "error",
    error,
  };
  upsertTickerMeta(meta, dbPath);
  return meta;
}

/** Fetch one ticker from Yahoo and upsert into SQLite. Uses incremental range when last_date is known. */
export async function fetchAndStoreTicker(ticker: string, deps: PrefetchDeps = {}): Promise<TickerMeta> {
  const now = deps.now ?? Date.now();
  const meta = getTickerMeta(ticker, deps.dbPath);
  const url =
    meta?.lastDate && meta.status === "ok"
      ? yahooChartUrl(ticker, incrementalPeriod(meta.lastDate, now))
      : yahooChartUrl(ticker);
  try {
    const res = await yahooGet(url, deps);
    if (!res.ok) {
      return markError(ticker, now, `Yahoo HTTP ${res.status}`, deps.dbPath);
    }
    const payload: unknown = await res.json();
    const parsed = parseYahooChart(payload, ticker);
    if (!parsed) return markError(ticker, now, "Yahoo returned no chart data.", deps.dbPath);
    return storeParsed(ticker, parsed, now, deps.dbPath);
  } catch (err) {
    return markError(ticker, now, err instanceof Error ? err.message : String(err), deps.dbPath);
  }
}

export function historyFromCache(query: string, symbol: string, dbPath?: string): FundHistoryResult {
  const prices = getPrices(symbol, dbPath);
  if (!prices.length) {
    return { status: "empty", query, symbol, message: "No price history is available for this fund." };
  }
  return buildHistoryFromRows(query, symbol, {
    prices,
    dividends: getDividends(symbol, dbPath),
    splits: getSplits(symbol, dbPath),
  });
}

function resolveCachedSymbol(raw: string, dbPath?: string): string | null {
  for (const c of fundCandidates(raw)) {
    if (hasCachedPrices(c, dbPath)) return c;
  }
  return null;
}

/**
 * History for Fund Lookup: read only from SQLite. If the ticker isn't cached yet,
 * fetch it once on demand and store it, then read again.
 */
export async function ensureTickerHistory(raw: string, deps: PrefetchDeps = {}): Promise<FundHistoryResult> {
  const query = normalizeFundQuery(raw) || String(raw ?? "").trim();
  const candidates = fundCandidates(raw);
  if (!query || !candidates.length) {
    return { status: "empty", query, symbol: null, message: "Enter a fund ticker such as HDIV, HYLD or BMAX." };
  }

  const cached = resolveCachedSymbol(raw, deps.dbPath);
  if (cached) return historyFromCache(query, cached, deps.dbPath);

  const symbol = candidates[0]!;
  const meta = await fetchAndStoreTicker(symbol, deps);
  if (meta.status === "ok" || hasCachedPrices(symbol, deps.dbPath)) {
    return historyFromCache(query, symbol, deps.dbPath);
  }
  return {
    status: meta.status === "empty" ? "empty" : "error",
    query,
    symbol,
    message: meta.error || "No price history is available for this fund.",
  };
}

export type StalePlan = { ticker: string; stale: boolean };

export function planPrefetch(deps: PrefetchDeps = {}): { refresh: string[]; skip: string[] } {
  const now = deps.now ?? Date.now();
  const universe = loadTickerUniverse({ tickersPath: deps.tickersPath, holdingsPath: deps.holdingsPath });
  const refresh: string[] = [];
  const skip: string[] = [];
  for (const rec of universe) {
    const meta = getTickerMeta(rec.ticker, deps.dbPath);
    if (isTickerStale(meta, now, STALE_AFTER_MS)) refresh.push(rec.ticker);
    else skip.push(rec.ticker);
  }
  return { refresh, skip };
}

/** Serial prefetch of stale tickers (funds first, then holdings). */
export async function runPrefetch(deps: PrefetchDeps = {}): Promise<PrefetchResult> {
  const started = Date.now();
  const sleep = deps.sleep ?? defaultSleep;
  const delay = deps.delayMs ?? REQUEST_DELAY_MS;
  const { refresh, skip } = planPrefetch(deps);
  let ok = 0;
  let failed = 0;
  let first = true;
  for (const ticker of refresh) {
    if (!first && delay > 0) await sleep(delay);
    first = false;
    const meta = await fetchAndStoreTicker(ticker, deps);
    if (meta.status === "ok") {
      ok += 1;
      deps.onTicker?.({ ticker, status: "ok" });
    } else {
      failed += 1;
      deps.onTicker?.({ ticker, status: meta.status === "empty" ? "empty" : "error", error: meta.error ?? undefined });
    }
  }
  for (const ticker of skip) deps.onTicker?.({ ticker, status: "skipped" });
  return { ok, failed, skipped: skip.length, elapsedMs: Date.now() - started };
}

export function msUntilNextTorontoHour(hour: number, now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const minutesNow = get("hour") * 60 + get("minute") + get("second") / 60;
  const target = hour * 60;
  let deltaMin = target - minutesNow;
  if (deltaMin <= 0) deltaMin += 24 * 60;
  return Math.max(1_000, Math.round(deltaMin * 60_000));
}

let started = false;
let dailyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDaily(): void {
  if (dailyTimer) clearTimeout(dailyTimer);
  const wait = msUntilNextTorontoHour(18);
  dailyTimer = setTimeout(() => {
    void runPrefetch({}).catch((err) => {
      console.error("[prices] daily prefetch failed:", err);
    });
    scheduleDaily();
  }, wait);
  dailyTimer.unref?.();
}

/** In-process scheduler: one run at app start, then around 6 PM America/Toronto daily. */
export function startPricePrefetchScheduler(): void {
  if (started || !shouldAutostart()) return;
  started = true;
  void runPrefetch({}).catch((err) => {
    console.error("[prices] startup prefetch failed:", err);
  });
  scheduleDaily();
}

export function stopPricePrefetchScheduler(): void {
  started = false;
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
}
