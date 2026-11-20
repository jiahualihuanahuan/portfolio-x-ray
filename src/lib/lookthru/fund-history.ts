import { displaySymbol } from "./tickers.ts";

/** Daily total-return series built from cached Yahoo chart rows. */
export type HistoryRange = "1Y" | "3Y" | "5Y" | "MAX";

export type HistoryPoint = {
  date: string;
  t: number;
  close: number;
  /** Split-adjusted price index, 1.0 at the first point of this series. */
  priceIndex: number;
  /** Total-return index (distributions reinvested when available), 1.0 at the first point. */
  totalIndex: number;
};

export type TotalReturnSource = "adjclose" | "dividends" | "price_only";

export type FundHistoryOk = {
  status: "ok";
  query: string;
  symbol: string;
  displaySymbol: string;
  currency: string | null;
  source: "Yahoo Finance chart";
  totalReturnSource: TotalReturnSource;
  dividendsIncluded: boolean;
  dividendCount: number;
  points: HistoryPoint[];
};

export type FundHistoryMissing = {
  status: "empty" | "error";
  query: string;
  symbol: string | null;
  message: string;
};

export type FundHistoryResult = FundHistoryOk | FundHistoryMissing;

export type ParsedChart = {
  symbol: string;
  currency: string | null;
  prices: Array<{ date: string; close: number | null; adjclose: number | null }>;
  dividends: Array<{ date: string; amount: number }>;
  splits: Array<{ date: string; numerator: number; denominator: number }>;
};

const DAY_MS = 86_400_000;

export function dateFromUnix(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function unixFromDate(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Build the public Yahoo chart URL. Full history uses range=max; incremental uses period1/period2. */
export function yahooChartUrl(symbol: string, opts?: { period1?: number; period2?: number }): string {
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const params = new URLSearchParams({ interval: "1d", events: "div,split" });
  if (opts?.period1 != null && opts?.period2 != null) {
    params.set("period1", String(opts.period1));
    params.set("period2", String(opts.period2));
  } else {
    params.set("range", "max");
  }
  return `${base}?${params.toString()}`;
}

export function parseYahooChart(payload: unknown, fallbackSymbol: string): ParsedChart | null {
  const chart = (payload as { chart?: { result?: unknown[]; error?: { description?: string } | null } })?.chart;
  const result = chart?.result?.[0] as
    | {
        meta?: { currency?: string; symbol?: string };
        timestamp?: number[];
        events?: {
          dividends?: Record<string, { amount?: number; date?: number }>;
          splits?: Record<string, { date?: number; numerator?: number; denominator?: number }>;
        };
        indicators?: {
          quote?: Array<{ close?: Array<number | null> }>;
          adjclose?: Array<{ adjclose?: Array<number | null> }>;
        };
      }
    | undefined;
  if (!result || !Array.isArray(result.timestamp) || result.timestamp.length === 0) return null;

  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const prices: ParsedChart["prices"] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const ts = result.timestamp[i];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    prices.push({
      date: dateFromUnix(ts),
      close: finite(closes[i]),
      adjclose: finite(adj[i]),
    });
  }
  if (!prices.some((p) => p.close != null)) return null;

  const dividends: ParsedChart["dividends"] = [];
  for (const ev of Object.values(result.events?.dividends ?? {})) {
    const amount = finite(ev?.amount);
    const date = typeof ev?.date === "number" ? dateFromUnix(ev.date) : null;
    if (amount != null && amount !== 0 && date) dividends.push({ date, amount });
  }

  const splits: ParsedChart["splits"] = [];
  for (const ev of Object.values(result.events?.splits ?? {})) {
    const numerator = finite(ev?.numerator);
    const denominator = finite(ev?.denominator);
    const date = typeof ev?.date === "number" ? dateFromUnix(ev.date) : null;
    if (numerator && denominator && date) splits.push({ date, numerator, denominator });
  }

  return {
    symbol: result.meta?.symbol || fallbackSymbol,
    currency: result.meta?.currency ?? null,
    prices,
    dividends,
    splits,
  };
}

function hasAdjClose(prices: ParsedChart["prices"]): boolean {
  return prices.some((p) => p.adjclose != null && p.close != null);
}

/**
 * Build a total-return series from stored rows.
 * Prefers Yahoo adjclose when present; otherwise reinvests dividend events at the close.
 * The price-only line is split-adjusted so splits don't look like crashes.
 */
export function buildHistoryFromRows(
  query: string,
  symbol: string,
  rows: {
    currency?: string | null;
    prices: Array<{ date: string; close: number | null; adjclose: number | null }>;
    dividends: Array<{ date: string; amount: number }>;
    splits: Array<{ date: string; numerator: number; denominator: number }>;
  },
): FundHistoryResult {
  const splitByDate = new Map<string, number>();
  for (const s of rows.splits) {
    if (s.denominator) splitByDate.set(s.date, s.numerator / s.denominator);
  }
  const divByDate = new Map<string, number>();
  for (const d of rows.dividends) {
    divByDate.set(d.date, (divByDate.get(d.date) ?? 0) + d.amount);
  }

  const days = rows.prices
    .filter((p) => p.close != null && p.close > 0)
    .map((p) => ({ date: p.date, close: p.close as number, adjclose: p.adjclose }));
  if (days.length < 2) {
    return {
      status: "empty",
      query,
      symbol,
      message: "No price history is available for this fund.",
    };
  }

  const useAdj = hasAdjClose(days);
  let shares = 1;
  let reinvestShares = 1;
  const raw: Array<{ date: string; t: number; close: number; priceValue: number; totalValue: number }> = [];

  for (const day of days) {
    const ratio = splitByDate.get(day.date);
    if (ratio && ratio > 0) {
      shares *= ratio;
      reinvestShares *= ratio;
    }
    const priceValue = shares * day.close;
    let totalValue: number;
    if (useAdj && day.adjclose != null && day.adjclose > 0) {
      totalValue = day.adjclose;
    } else {
      totalValue = reinvestShares * day.close;
    }
    raw.push({ date: day.date, t: unixFromDate(day.date), close: day.close, priceValue, totalValue });
    const div = divByDate.get(day.date);
    if (!useAdj && div && day.close > 0) {
      reinvestShares += (div * reinvestShares) / day.close;
    }
  }

  const p0 = raw[0]!;
  if (!(p0.priceValue > 0) || !(p0.totalValue > 0)) {
    return { status: "empty", query, symbol, message: "No price history is available for this fund." };
  }

  const points: HistoryPoint[] = raw.map((r) => ({
    date: r.date,
    t: r.t,
    close: r.close,
    priceIndex: r.priceValue / p0.priceValue,
    totalIndex: r.totalValue / p0.totalValue,
  }));

  const dividendCount = rows.dividends.length;
  const totalReturnSource: TotalReturnSource = useAdj ? "adjclose" : dividendCount > 0 ? "dividends" : "price_only";

  return {
    status: "ok",
    query,
    symbol,
    displaySymbol: displaySymbol(symbol),
    currency: rows.currency ?? null,
    source: "Yahoo Finance chart",
    totalReturnSource,
    dividendsIncluded: totalReturnSource !== "price_only",
    dividendCount,
    points,
  };
}

export function rebasePoints(points: HistoryPoint[]): HistoryPoint[] {
  const first = points[0];
  if (!first || !(first.priceIndex > 0) || !(first.totalIndex > 0)) return points;
  return points.map((p) => ({
    ...p,
    priceIndex: p.priceIndex / first.priceIndex,
    totalIndex: p.totalIndex / first.totalIndex,
  }));
}

const RANGE_DAYS: Record<Exclude<HistoryRange, "MAX">, number> = {
  "1Y": 365,
  "3Y": 365 * 3,
  "5Y": 365 * 5,
};

/** Slice a full-history series to a window and rebase both lines to 1.0 at the start. */
export function sliceHistory(points: HistoryPoint[], range: HistoryRange): HistoryPoint[] {
  if (range === "MAX" || points.length < 2) return rebasePoints(points);
  const end = points[points.length - 1]!.t;
  const cutoff = end - RANGE_DAYS[range] * 86_400;
  let start = points.findIndex((p) => p.t >= cutoff);
  if (start < 0) return rebasePoints(points);
  if (start > 0 && points[start]!.t > cutoff) start -= 1;
  return rebasePoints(points.slice(start));
}

export type HistorySummary = {
  totalReturn: number;
  priceReturn: number;
  annualized: number | null;
  years: number;
};

export function historySummary(points: HistoryPoint[]): HistorySummary | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (!(first.totalIndex > 0) || !(first.priceIndex > 0)) return null;
  const totalReturn = last.totalIndex / first.totalIndex - 1;
  const priceReturn = last.priceIndex / first.priceIndex - 1;
  const years = (last.t - first.t) / (365.25 * 86_400);
  const annualized = years >= 1 / 365 ? (last.totalIndex / first.totalIndex) ** (1 / years) - 1 : null;
  return { totalReturn, priceReturn, annualized, years };
}

export const HISTORY_RANGES: HistoryRange[] = ["1Y", "3Y", "5Y", "MAX"];

/** Unused but keeps DAY_MS referenced if a caller wants ms cutoffs. */
export function rangeDurationMs(range: HistoryRange): number | null {
  if (range === "MAX") return null;
  return RANGE_DAYS[range] * DAY_MS;
}
