/**
 * Build and label forward-P/E history.
 *
 * (a) Real series: nightly consensus snapshots in `estimates` / `pe_series`
 *     kind='forward'. Used once at least 250 days exist.
 * (b) Proxy series: daily price ÷ realized EPS of the following 12 months
 *     (or trailing annual EPS when the next year is not yet reported),
 *     stored as kind='proxy' and labelled "proxy, based on reported EPS".
 *
 * Percentiles compare a name (or a sector) only to its own history.
 */
import {
  countForwardPeDays,
  getEstimateHistory,
  getPeSeries,
  getPrices,
  getRealizedEps,
  upsertPeSeries,
  type PeSeriesKind,
  type PeSeriesRow,
  type PriceRow,
  type RealizedEpsRow,
} from "./prices-db.ts";
import { REAL_SERIES_MIN_DAYS } from "./valuation.ts";
import { convertEps, forwardRealizedEps } from "./estimates.ts";
import { percentileRank } from "./valuation.ts";

export { REAL_SERIES_MIN_DAYS };

export type HistoryChoice = {
  kind: PeSeriesKind;
  label: "nightly consensus snapshots" | "proxy, based on reported EPS";
  points: PeSeriesRow[];
  /** Days of real forward snapshots on disk, even if the proxy is the one in use. */
  forwardDays: number;
};

export function choosePeHistory(ticker: string, path?: string): HistoryChoice {
  const forwardDays = countForwardPeDays(ticker, path);
  if (forwardDays >= REAL_SERIES_MIN_DAYS) {
    return {
      kind: "forward",
      label: "nightly consensus snapshots",
      points: getPeSeries(ticker, "forward", path),
      forwardDays,
    };
  }
  return {
    kind: "proxy",
    label: "proxy, based on reported EPS",
    points: getPeSeries(ticker, "proxy", path),
    forwardDays,
  };
}

export function percentileAgainstOwnHistory(todayPe: number, ticker: string, path?: string): {
  percentile: number | null;
  kind: PeSeriesKind;
  label: HistoryChoice["label"];
  historyLength: number;
} {
  const hist = choosePeHistory(ticker, path);
  const values = hist.points.map((p) => p.pe).filter((v) => Number.isFinite(v) && v > 0);
  return {
    percentile: percentileRank(todayPe, values),
    kind: hist.kind,
    label: hist.label,
    historyLength: values.length,
  };
}

/**
 * Build a proxy P/E series from daily prices and realized EPS. EPS is converted
 * into the trading currency when `fx` is provided.
 */
export function buildProxyPeSeries(
  ticker: string,
  prices: PriceRow[],
  realized: RealizedEpsRow[],
  opts?: { fx?: number | null; fromCurrency?: string | null; toCurrency?: string | null },
): PeSeriesRow[] {
  const out: PeSeriesRow[] = [];
  for (const p of prices) {
    const close = p.close ?? p.adjclose;
    if (close == null || close <= 0) continue;
    const found = forwardRealizedEps(realized, p.date);
    if (!found || found.eps === 0 || !Number.isFinite(found.eps)) continue;
    const eps = convertEps(found.eps, opts?.fromCurrency ?? null, opts?.toCurrency ?? null, opts?.fx ?? null);
    if (!Number.isFinite(eps) || eps === 0) continue;
    const pe = close / eps;
    if (!Number.isFinite(pe)) continue;
    // A negative proxy P/E (loss year) is stored so the series is complete,
    // but percentileRank ignores non-positive values.
    out.push({ ticker, date: p.date, pe, kind: "proxy" });
  }
  return out;
}

/** Nightly forward P/E point from the latest estimate snapshot. */
export function forwardPeFromEstimates(ticker: string, path?: string): PeSeriesRow[] {
  const rows = getEstimateHistory(ticker, path);
  const out: PeSeriesRow[] = [];
  for (const r of rows) {
    if (r.ntmEps == null || r.price == null || r.price === 0) continue;
    const pe = r.price / r.ntmEps;
    if (!Number.isFinite(pe)) continue;
    out.push({ ticker, date: r.asof, pe, kind: "forward" });
  }
  return out;
}

export function rebuildPeSeries(
  ticker: string,
  path?: string,
  opts?: { fx?: number | null; fromCurrency?: string | null; toCurrency?: string | null },
): { proxy: number; forward: number } {
  const proxy = buildProxyPeSeries(ticker, getPrices(ticker, path), getRealizedEps(ticker, path), opts);
  const forward = forwardPeFromEstimates(ticker, path);
  upsertPeSeries(proxy, path);
  upsertPeSeries(forward, path);
  return { proxy: proxy.length, forward: forward.length };
}

/**
 * Sector (or index / fund) aggregate P/E on a date, using current weights and
 * each name's P/E from the same kind of per-stock series. Point-in-time
 * holdings are not historically available, which is noted by the caller.
 */
export function aggregateSeriesOnDates(
  weights: { ticker: string; weight: number }[],
  seriesByTicker: Record<string, PeSeriesRow[]>,
  dates: string[],
  kind: PeSeriesKind,
  key: string,
): PeSeriesRow[] {
  const lookup = new Map<string, Map<string, number>>();
  for (const [ticker, rows] of Object.entries(seriesByTicker)) {
    const m = new Map<string, number>();
    for (const r of rows) if (r.kind === kind) m.set(r.date, r.pe);
    lookup.set(ticker, m);
  }
  const out: PeSeriesRow[] = [];
  for (const date of dates) {
    let earnings = 0;
    let wSum = 0;
    for (const { ticker, weight } of weights) {
      const pe = lookup.get(ticker)?.get(date);
      if (pe == null || !Number.isFinite(pe) || pe === 0) continue;
      earnings += weight * (1 / pe);
      wSum += weight;
    }
    if (wSum <= 0 || earnings <= 0) continue;
    out.push({ ticker: key, date, pe: wSum / earnings, kind });
  }
  return out;
}
