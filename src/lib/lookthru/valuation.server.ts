/**
 * Assemble a forward P/E report for a fund, index proxy, stock, or portfolio.
 * I/O lives here; the math is in valuation.ts.
 */
import { catalogInstrument, sectorOf } from "./catalog.ts";
import { applyFxQuote, convertEps, fxPairSymbol } from "./estimates.ts";
import { fileHoldings } from "./holdings-file.ts";
import { fetchIndexHoldings, isIndexProxyTicker, type IndexHoldings } from "./index-holdings.ts";
import { fetchIssuerHoldings } from "./issuers.server.ts";
import {
  getEstimate,
  getPeSeries,
  getPrices,
  torontoDate,
  upsertEstimates,
  upsertPeSeries,
  upsertRealizedEps,
  type EstimateRow,
} from "./prices-db.ts";
import { fetchAndStoreTicker } from "./prices-prefetch.ts";
import { aggregateSeriesOnDates, percentileAgainstOwnHistory, rebuildPeSeries } from "./pe-history.ts";
import { fundCandidates, normalizeFundQuery } from "./fund-lookup.ts";
import { isSynthetic } from "./catalog.ts";
import { applyAlias, issuerKey, normalizeTicker } from "./tickers.ts";
import type { HoldingLine } from "./types.ts";
import {
  aggregateForwardPe,
  formatPe,
  isEquityForPe,
  sectorForwardPes,
  type ForwardPeResult,
  type ValuationHolding,
  type ValuationReport,
  type ValuationSector,
} from "./valuation.ts";
import { fetchFxQuote, fetchRealizedEps, fetchYahooEstimates } from "./yahoo.server.ts";

const REQUEST_GAP_MS = Number(process.env["VALUATION_REQUEST_GAP_MS"] ?? 400);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_DEPTH = 5;

export type { ValuationReport, ValuationSector } from "./valuation.ts";

export type PortfolioValuationInput = {
  holdings: Array<{
    symbol: string;
    name?: string;
    weight: number;
    sector?: string;
    kind?: string;
    unresolved?: boolean;
  }>;
  name?: string;
  benchmarkTicker?: string;
};

function displayOf(symbol: string): string {
  return symbol.replace(/\.(TO|NE|V)$/i, "");
}

function kindOf(h: HoldingLine): ValuationHolding["kind"] {
  const sec = (h.sector || "").toLowerCase();
  if (sec === "cash" || h.symbol.toUpperCase() === "CASH") return "cash";
  if (sec === "options" || h.symbol.toUpperCase() === "OPTIONS") return "options";
  if (sec === "fixed income") return "bond";
  if (sec === "fund") return "etf";
  if (sec === "other" || h.symbol.toUpperCase() === "OTHER") return "other";
  return "equity";
}

async function holdingsFor(symbol: string): Promise<{ holdings: HoldingLine[]; name?: string; asOf?: string; index?: IndexHoldings } | null> {
  const file = fileHoldings(symbol);
  if (file?.holdings?.length) return { holdings: file.holdings, name: file.name, asOf: file.asOf };
  if (isIndexProxyTicker(symbol)) {
    const idx = await fetchIndexHoldings(symbol);
    if (idx?.holdings.length) {
      return { holdings: idx.holdings, name: idx.proxyFor, asOf: idx.asOf, index: idx };
    }
  }
  const catalog = catalogInstrument(symbol);
  if (catalog?.holdings?.length) return { holdings: catalog.holdings, name: catalog.name, asOf: catalog.asOf };
  const issuer = await fetchIssuerHoldings(symbol);
  if (issuer?.holdings?.length) return { holdings: issuer.holdings, asOf: issuer.asOf };
  return catalog ? { holdings: catalog.holdings ?? [], name: catalog.name, asOf: catalog.asOf } : null;
}

function childHoldings(symbol: string): HoldingLine[] | null {
  const file = fileHoldings(symbol);
  if (file?.holdings?.length) return file.holdings;
  const catalog = catalogInstrument(symbol);
  if (catalog?.holdings?.length) return catalog.holdings;
  return null;
}

function flatten(holdings: HoldingLine[], depth = 0, trail: Set<string> = new Set()): ValuationHolding[] {
  const out: ValuationHolding[] = [];
  for (const h of holdings) {
    const sym = applyAlias(h.symbol);
    const kind = kindOf(h);
    if (kind === "cash" || kind === "options" || kind === "bond" || kind === "other" || isSynthetic(sym)) {
      out.push({ symbol: sym, name: h.name, weight: h.weight, sector: h.sector, kind });
      continue;
    }
    const kids = depth < MAX_DEPTH && !trail.has(issuerKey(sym)) ? childHoldings(sym) : null;
    if (kids && kids.length) {
      const next = new Set(trail);
      next.add(issuerKey(sym));
      const childLeaves = flatten(kids, depth + 1, next);
      for (const c of childLeaves) out.push({ ...c, weight: c.weight * h.weight });
      continue;
    }
    if (kind === "etf") {
      out.push({ symbol: sym, name: h.name, weight: h.weight, sector: h.sector, kind, unresolved: true });
      continue;
    }
    out.push({
      symbol: sym,
      name: h.name,
      weight: h.weight,
      sector: h.sector || sectorOf(sym),
      kind: "equity",
    });
  }
  return out;
}

const fxCache = new Map<string, number | null>();

export async function fxRate(from: string | null, to: string | null, dbPath?: string): Promise<number | null> {
  if (!from || !to || from.toUpperCase() === to.toUpperCase()) return 1;
  const key = `${from}:${to}`;
  if (fxCache.has(key)) return fxCache.get(key) ?? null;
  for (const { pair, invert } of fxPairSymbol(from, to)) {
    const cached = getPrices(pair, dbPath).at(-1);
    const px = cached?.close ?? cached?.adjclose;
    if (px != null && px > 0) {
      const rate = applyFxQuote(px, invert);
      if (rate) {
        fxCache.set(key, rate);
        return rate;
      }
    }
  }
  for (const { pair, invert } of fxPairSymbol(from, to)) {
    const live = await fetchFxQuote(pair);
    if (live) {
      const rate = applyFxQuote(live, invert);
      if (rate) {
        fxCache.set(key, rate);
        return rate;
      }
    }
  }
  fxCache.set(key, null);
  return null;
}

async function refreshHistory(ticker: string, row: EstimateRow, dbPath?: string): Promise<void> {
  const realized = await fetchRealizedEps(ticker);
  if (realized.length) upsertRealizedEps(realized, dbPath);
  const prices = getPrices(ticker, dbPath);
  if (!prices.length) {
    await fetchAndStoreTicker(ticker, { dbPath, delayMs: 0 });
  }
  rebuildPeSeries(ticker, dbPath, {
    fx: await fxRate(row.financialCurrency, row.currency, dbPath),
    fromCurrency: row.financialCurrency,
    toCurrency: row.currency,
  });
}

export async function ensureEstimate(ticker: string, asof = torontoDate(), dbPath?: string): Promise<EstimateRow | null> {
  const existing = getEstimate(ticker, asof, dbPath) ?? getEstimate(ticker, undefined, dbPath);
  if (existing && existing.asof === asof) {
    if (!getPeSeries(ticker, undefined, dbPath).length) {
      try { await refreshHistory(ticker, existing, dbPath); } catch (err) {
        console.warn(`[valuation] history rebuild failed for ${ticker}:`, err);
      }
    }
    return existing;
  }
  try {
    const row = await fetchYahooEstimates(ticker, asof);
    if (row) {
      upsertEstimates([row], dbPath);
      try {
        await refreshHistory(ticker, row, dbPath);
      } catch (err) {
        console.warn(`[valuation] history rebuild failed for ${ticker}:`, err);
      }
      return row;
    }
  } catch {
    /* keep any stale snapshot */
  }
  return existing;
}

async function decorate(leaves: ValuationHolding[], dbPath?: string, asof = torontoDate()): Promise<ValuationHolding[]> {
  const out: ValuationHolding[] = [];
  let pendingGap = false;
  for (const leaf of leaves) {
    if (!isEquityForPe(leaf) && leaf.kind !== "equity") {
      out.push(leaf);
      continue;
    }
    const have = getEstimate(leaf.symbol, asof, dbPath);
    if (!have && pendingGap && REQUEST_GAP_MS > 0) await sleep(REQUEST_GAP_MS);
    if (!have) pendingGap = true;
    const est = await ensureEstimate(leaf.symbol, asof, dbPath);
    if (!est) {
      out.push(leaf);
      continue;
    }
    const fx = await fxRate(est.financialCurrency, est.currency, dbPath);
    const ntm = est.ntmEps != null ? convertEps(est.ntmEps, est.financialCurrency, est.currency, fx) : null;
    const price = est.price ?? getPrices(leaf.symbol, dbPath).at(-1)?.close ?? null;
    out.push({
      ...leaf,
      sector: leaf.sector || sectorOf(leaf.symbol),
      ntmEps: ntm,
      price,
      analystCount: est.analystCount,
    });
  }
  return out;
}

function methodologyNotes(opts: {
  kind: "stock" | "fund" | "portfolio";
  percentileLabel: string;
  index?: IndexHoldings;
  fxUsed: boolean;
}): string[] {
  const notes = [
    "Forward P/E uses next-twelve-months EPS: FY1 × (months left in the fiscal year / 12) + FY2 × (1 − that).",
    "A portfolio or sector P/E is aggregate value divided by aggregate earnings (a harmonic mean), not an average of P/Es.",
    "Loss-makers are kept (negative earnings reduce the total). Cash, bonds, options and unresolved fund lines are excluded.",
    "Leveraged funds use gross equity leaf weights and ignore the negative cash line.",
    opts.percentileLabel === "nightly consensus snapshots"
      ? "The percentile is today's forward P/E against this name's own history of nightly consensus snapshots (250+ days)."
      : "The percentile is today's forward P/E against a proxy history: daily price ÷ realized EPS of the following 12 months (or trailing annual EPS). Label: proxy, based on reported EPS. Yahoo does not publish a historical consensus.",
    "Sector percentiles are compared only to that sector's own history, never across sectors.",
  ];
  if (opts.fxUsed) notes.push("EPS reported in a different currency than the trading currency is converted with the cached Yahoo FX pair (e.g. USDCAD=X for SHOP.TO).");
  if (opts.index) {
    notes.push(
      opts.index.partial
        ? `Constituents are a partial ${opts.index.proxyFor} book from ${opts.index.source} (coverage ${Math.round(opts.index.coverage * 100)}%).`
        : `Constituents are the full ${opts.index.proxyFor} book from ${opts.index.source}.`,
    );
  }
  return notes;
}

function sectorRows(leaves: ValuationHolding[], dbPath?: string): ValuationSector[] {
  const agg = sectorForwardPes(leaves);
  return agg.map((row) => {
    const key = `sector:${row.sector}`;
    const hist = getPeSeries(key, undefined, dbPath);
    const values = hist.map((p) => p.pe);
    const today = typeof row.pe === "number" ? row.pe : null;
    const fromOwn = today != null ? percentileAgainstOwnHistory(today, key, dbPath) : null;
    return {
      sector: row.sector,
      pe: row.pe,
      peLabel: formatPe(row.pe),
      percentile: fromOwn?.percentile ?? null,
      percentileLabel: fromOwn?.label ?? "proxy, based on reported EPS",
      weight: row.weight,
      coverage: row.coverage,
      namesCovered: row.namesCovered,
    };
  });
}

function storeSectorSeries(leaves: ValuationHolding[], dbPath?: string): void {
  const bySector = new Map<string, ValuationHolding[]>();
  for (const h of leaves) {
    if (!isEquityForPe(h)) continue;
    const sector = h.sector || "Unclassified";
    const list = bySector.get(sector) ?? [];
    list.push(h);
    bySector.set(sector, list);
  }
  for (const [sector, list] of bySector) {
    const key = `sector:${sector}`;
    const weights = list.map((h) => ({ ticker: h.symbol, weight: h.weight }));
    const seriesByTicker: Record<string, ReturnType<typeof getPeSeries>> = {};
    const dates = new Set<string>();
    for (const h of list) {
      const rows = getPeSeries(h.symbol, "proxy", dbPath);
      seriesByTicker[h.symbol] = rows;
      for (const r of rows) dates.add(r.date);
    }
    const sorted = [...dates].sort();
    const series = aggregateSeriesOnDates(weights, seriesByTicker, sorted, "proxy", key);
    if (series.length) upsertPeSeries(series, dbPath);
  }
}

async function maybeBenchmark(
  symbol: string,
  holdings: HoldingLine[],
  dbPath?: string,
): Promise<ValuationReport["benchmark"]> {
  if (isIndexProxyTicker(symbol)) return undefined;
  try {
    const { matchBenchmark } = await import("./benchmarks.ts");
    const lookup = (s: string) => fileHoldings(s)?.holdings ?? catalogInstrument(s)?.holdings ?? null;
    const match = matchBenchmark(symbol, holdings, { lookup });
    const leg = match.def.legs.find((l) => l.hedge === "unhedged") ?? match.def.legs[0];
    if (!leg) return undefined;
    if (issuerKey(leg.ticker) === issuerKey(symbol)) return undefined;
    const report = await valuationForTicker(leg.ticker, dbPath);
    if (report.status !== "ok") return undefined;
    return { symbol: leg.ticker, label: match.def.label, pe: report.pe, peLabel: report.peLabel, coverage: report.coverage };
  } catch {
    return undefined;
  }
}

function pack(
  symbol: string,
  name: string | undefined,
  asOf: string,
  agg: ForwardPeResult,
  leaves: ValuationHolding[],
  opts: { index?: IndexHoldings; fxUsed: boolean; kind: "stock" | "fund" | "portfolio"; benchmark?: ValuationReport["benchmark"]; dbPath?: string },
): ValuationReport {
  const todayPe = typeof agg.pe === "number" ? agg.pe : null;
  const rank = todayPe != null ? percentileAgainstOwnHistory(todayPe, symbol, opts.dbPath) : null;
  const sectors = sectorRows(leaves, opts.dbPath);
  const methodology = methodologyNotes({
    kind: opts.kind,
    percentileLabel: rank?.label ?? "proxy, based on reported EPS",
    index: opts.index,
    fxUsed: opts.fxUsed,
  });
  return {
    status: "ok",
    symbol,
    displaySymbol: displayOf(symbol),
    name,
    asOf,
    pe: agg.pe,
    peLabel: formatPe(agg.pe),
    coverage: agg.coverage,
    namesCovered: agg.namesCovered,
    namesEligible: agg.namesEligible,
    medianAnalystCount: agg.medianAnalystCount,
    equityWeight: agg.equityWeight,
    percentile: rank?.percentile ?? null,
    percentileKind: rank?.kind ?? null,
    percentileLabel: rank?.label ?? "proxy, based on reported EPS",
    historyLength: rank?.historyLength ?? 0,
    sectors,
    benchmark: opts.benchmark,
    methodology,
    constituents: opts.index
      ? {
          source: opts.index.source,
          sourceUrl: opts.index.sourceUrl,
          proxyFor: opts.index.proxyFor,
          partial: opts.index.partial,
          coverage: opts.index.coverage,
          count: opts.index.holdings.length,
        }
      : undefined,
  };
}

export async function valuationForTicker(raw: string, dbPath?: string): Promise<ValuationReport> {
  const query = normalizeFundQuery(raw) || normalizeTicker(raw);
  const symbol = fundCandidates(raw)[0] ?? applyAlias(query);
  const asOf = torontoDate();
  const found = await holdingsFor(symbol);
  const holdings = found?.holdings ?? [];
  const index = found?.index;
  const name = found?.name ?? catalogInstrument(symbol)?.name ?? symbol;

  if (!holdings.length) {
    // Single stock (or an ETF we could not unroll).
    const leaves = await decorate(
      [{ symbol, name, weight: 1, sector: sectorOf(symbol), kind: "equity" }],
      dbPath,
      asOf,
    );
    const agg = aggregateForwardPe(leaves);
    storeSectorSeries(leaves, dbPath);
    const fxUsed = Boolean(getEstimate(symbol, undefined, dbPath)?.financialCurrency && getEstimate(symbol, undefined, dbPath)?.currency && getEstimate(symbol, undefined, dbPath)!.financialCurrency !== getEstimate(symbol, undefined, dbPath)!.currency);
    return pack(symbol, name, asOf, agg, leaves, { fxUsed, kind: "stock", dbPath });
  }

  // Index constituent files are already a flat equity book. Do not unroll
  // them through holdings.json — Canadian fund keys (e.g. HIG.TO) can collide
  // with a US constituent ticker (Hartford's HIG).
  const rawLeaves = index
    ? holdings.map((h) => {
        const kind = kindOf(h);
        const symbol = normalizeTicker(h.symbol);
        return {
          symbol,
          name: h.name,
          weight: h.weight,
          sector: h.sector || sectorOf(symbol),
          kind: kind === "cash" || kind === "bond" || kind === "options" || kind === "other" ? kind : "equity",
        } satisfies ValuationHolding;
      })
    : flatten(holdings);
  const leaves = await decorate(rawLeaves, dbPath, asOf);
  storeSectorSeries(leaves, dbPath);
  const agg = aggregateForwardPe(leaves);
  if (typeof agg.pe === "number") {
    upsertPeSeries([{ ticker: symbol, date: asOf, pe: agg.pe, kind: "forward" }], dbPath);
    const dates = [...new Set(leaves.flatMap((h) => getPeSeries(h.symbol, "proxy", dbPath).map((p) => p.date)))].sort();
    const series = aggregateSeriesOnDates(
      leaves.filter(isEquityForPe).map((h) => ({ ticker: h.symbol, weight: h.weight })),
      Object.fromEntries(leaves.map((h) => [h.symbol, getPeSeries(h.symbol, "proxy", dbPath)])),
      dates,
      "proxy",
      symbol,
    );
    if (series.length) upsertPeSeries(series, dbPath);
  }
  const fxUsed = leaves.some((h) => {
    const e = getEstimate(h.symbol, undefined, dbPath);
    return e?.financialCurrency && e.currency && e.financialCurrency !== e.currency;
  });
  const benchmark = await maybeBenchmark(symbol, holdings, dbPath);
  return pack(symbol, name, asOf, agg, leaves, { index, fxUsed, kind: "fund", benchmark, dbPath });
}

export async function valuationForPortfolio(input: PortfolioValuationInput, dbPath?: string): Promise<ValuationReport> {
  const asOf = torontoDate();
  const rawLeaves: ValuationHolding[] = (input.holdings ?? []).map((h) => ({
    symbol: applyAlias(h.symbol),
    name: h.name,
    weight: h.weight,
    sector: h.sector,
    kind: (h.kind as ValuationHolding["kind"]) ?? kindOf({ symbol: h.symbol, name: h.name ?? "", weight: h.weight, sector: h.sector }),
    unresolved: h.unresolved,
  }));
  const decorated = await decorate(rawLeaves, dbPath, asOf);
  storeSectorSeries(decorated, dbPath);
  const agg = aggregateForwardPe(decorated);
  const fxUsed = decorated.some((h) => {
    const e = getEstimate(h.symbol, undefined, dbPath);
    return e?.financialCurrency && e.currency && e.financialCurrency !== e.currency;
  });
  let benchmark: ValuationReport["benchmark"];
  if (input.benchmarkTicker) {
    const bench = await valuationForTicker(input.benchmarkTicker, dbPath);
    if (bench.status === "ok") {
      benchmark = { symbol: bench.symbol, label: bench.name ?? bench.displaySymbol, pe: bench.pe, peLabel: bench.peLabel, coverage: bench.coverage };
    }
  }
  return pack("PORTFOLIO", input.name ?? "Portfolio", asOf, agg, decorated, { fxUsed, kind: "portfolio", benchmark, dbPath });
}
