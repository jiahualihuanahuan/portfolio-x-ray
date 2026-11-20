/**
 * Nightly estimate + realized-EPS prefetch, on the same schedule as prices.
 * Stocks from tickers.json and holdings leaves first, then index constituents.
 */
import { isSynthetic, sectorOf } from "./catalog.ts";
import { loadHoldingsFile } from "./holdings-file.ts";
import { fetchIndexHoldings, INDEX_SPECS } from "./index-holdings.ts";
import { getEstimate, getPrices, getRealizedEps, torontoDate, upsertEstimates, upsertRealizedEps } from "./prices-db.ts";
import { rebuildPeSeries } from "./pe-history.ts";
import { loadTickerUniverse } from "./ticker-search.ts";
import { fetchFxQuote, fetchRealizedEps, fetchYahooEstimates } from "./yahoo.server.ts";
import { applyFxQuote, fxPairSymbol } from "./estimates.ts";

export type EstimatePrefetchDeps = {
  dbPath?: string;
  holdingsPath?: string;
  tickersPath?: string;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: number;
  onTicker?: (event: { ticker: string; status: "ok" | "error" | "skipped"; error?: string }) => void;
};

function looksLikeEquity(ticker: string, isFund: boolean): boolean {
  if (isFund) return false;
  if (isSynthetic(ticker)) return false;
  if (/^=X$|\=X$/i.test(ticker)) return false;
  const sector = sectorOf(ticker);
  if (sector === "Cash" || sector === "Fixed Income") return false;
  return true;
}


async function fxRate(from: string | null, to: string | null, dbPath?: string): Promise<number | null> {
  if (!from || !to || from.toUpperCase() === to.toUpperCase()) return 1;
  for (const { pair, invert } of fxPairSymbol(from, to)) {
    const cached = getPrices(pair, dbPath).at(-1);
    const px = cached?.close ?? cached?.adjclose;
    if (px != null && px > 0) {
      const rate = applyFxQuote(px, invert);
      if (rate) return rate;
    }
  }
  for (const { pair, invert } of fxPairSymbol(from, to)) {
    const live = await fetchFxQuote(pair);
    if (live) {
      const rate = applyFxQuote(live, invert);
      if (rate) return rate;
    }
  }
  return null;
}

export async function planEstimateTickers(deps: EstimatePrefetchDeps = {}): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string) => {
    const ticker = t.toUpperCase();
    if (!ticker || seen.has(ticker)) return;
    seen.add(ticker);
    out.push(ticker);
  };
  const universe = loadTickerUniverse({ tickersPath: deps.tickersPath, holdingsPath: deps.holdingsPath });
  for (const rec of universe) {
    if (looksLikeEquity(rec.ticker, rec.role === "fund" || rec.isFund)) add(rec.ticker);
  }
  const funds = loadHoldingsFile(deps.holdingsPath);
  for (const fund of new Set(funds.values())) {
    for (const h of fund.holdings) {
      if (h.sector === "Fund" || h.sector === "Cash" || h.sector === "Fixed Income") continue;
      if (isSynthetic(h.symbol)) continue;
      add(h.symbol);
    }
  }
  for (const spec of INDEX_SPECS) {
    const key = spec.keys[0]!;
    try {
      const idx = await fetchIndexHoldings(key);
      if (!idx) continue;
      for (const h of idx.holdings) add(h.symbol);
    } catch {
      /* ignore a missing public file; the valuation route will flag partial */
    }
  }
  return out;
}

export async function prefetchEstimates(deps: EstimatePrefetchDeps = {}): Promise<{ ok: number; failed: number; skipped: number }> {
  const asof = torontoDate(deps.now ? new Date(deps.now) : undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = deps.delayMs ?? 500;
  const tickers = await planEstimateTickers(deps);
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let first = true;
  for (const ticker of tickers) {
    const existing = getEstimate(ticker, asof, deps.dbPath);
    if (existing) {
      skipped += 1;
      deps.onTicker?.({ ticker, status: "skipped" });
      continue;
    }
    if (!first && delay > 0) await sleep(delay);
    first = false;
    try {
      const row = await fetchYahooEstimates(ticker, asof);
      if (!row) {
        failed += 1;
        deps.onTicker?.({ ticker, status: "error", error: "No estimate payload" });
        continue;
      }
      upsertEstimates([row], deps.dbPath);
      if (!getRealizedEps(ticker, deps.dbPath).length) {
        if (delay > 0) await sleep(delay);
        const realized = await fetchRealizedEps(ticker);
        if (realized.length) upsertRealizedEps(realized, deps.dbPath);
      }
      rebuildPeSeries(ticker, deps.dbPath, {
        fx: await fxRate(row.financialCurrency, row.currency, deps.dbPath),
        fromCurrency: row.financialCurrency,
        toCurrency: row.currency,
      });
      ok += 1;
      deps.onTicker?.({ ticker, status: "ok" });
    } catch (err) {
      failed += 1;
      deps.onTicker?.({ ticker, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok, failed, skipped };
}
