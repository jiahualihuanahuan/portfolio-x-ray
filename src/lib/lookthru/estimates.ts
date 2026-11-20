/**
 * Parse Yahoo quoteSummary / fundamentals-timeseries payloads into estimate
 * and realized-EPS rows. Conversion of EPS into the trading currency happens
 * at read time so snapshots stay in the reporting currency.
 */
import { monthsLeftInFiscalYear, ntmEps } from "./valuation.ts";
import type { EstimateRow, RealizedEpsRow } from "./prices-db.ts";

export function rawNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in v) {
    const raw = (v as { raw: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

export function isoFromYahooDate(v: unknown): string | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const n = rawNumber(v);
  if (n == null) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function trendPeriod(
  json: unknown,
  period: string,
): { eps: number | null; analysts: number | null } {
  const result = (json as { quoteSummary?: { result?: Array<Record<string, unknown>> } })
    ?.quoteSummary?.result?.[0];
  const trend = (result?.["earningsTrend"] as { trend?: Array<Record<string, unknown>> } | undefined)?.trend ?? [];
  const row = trend.find((t) => String(t["period"] ?? "") === period);
  if (!row) return { eps: null, analysts: null };
  const est = (row["earningsEstimate"] ?? row) as Record<string, unknown>;
  return {
    eps: rawNumber(est["avg"] ?? est["earningsEstimate"]),
    analysts: rawNumber(est["numberOfAnalysts"]),
  };
}

export function parseQuoteSummaryEstimates(
  json: unknown,
  ticker: string,
  asof: string,
): EstimateRow | null {
  const result = (json as { quoteSummary?: { result?: Array<Record<string, unknown>> } })
    ?.quoteSummary?.result?.[0];
  if (!result) return null;
  const fy0 = trendPeriod(json, "0y");
  const fy1 = trendPeriod(json, "+1y");
  const ks = (result["defaultKeyStatistics"] ?? {}) as Record<string, unknown>;
  const priceMod = (result["price"] ?? {}) as Record<string, unknown>;
  const fin = (result["financialData"] ?? {}) as Record<string, unknown>;
  const summary = (result["summaryDetail"] ?? {}) as Record<string, unknown>;
  const forwardEps = rawNumber(ks["forwardEps"]) ?? rawNumber(fin["forwardEps"]);
  const fy0Eps = fy0.eps;
  const fy1Eps = fy1.eps;
  const lastFyEnd = isoFromYahooDate(ks["lastFiscalYearEnd"]);
  const nextFyEnd = isoFromYahooDate(ks["nextFiscalYearEnd"]);
  const asOfDate = new Date(`${asof}T12:00:00Z`);
  const months = monthsLeftInFiscalYear(
    asOfDate,
    nextFyEnd ? new Date(`${nextFyEnd}T00:00:00Z`) : null,
    lastFyEnd ? new Date(`${lastFyEnd}T00:00:00Z`) : null,
  );
  let ntm: number | null = null;
  if (fy0Eps != null && fy1Eps != null) ntm = ntmEps(fy0Eps, fy1Eps, months);
  else if (fy0Eps != null) ntm = fy0Eps;
  else if (forwardEps != null) ntm = forwardEps;
  const currency =
    (typeof priceMod["currency"] === "string" && priceMod["currency"]) ||
    (typeof summary["currency"] === "string" && summary["currency"]) ||
    null;
  const financialCurrency =
    (typeof fin["financialCurrency"] === "string" && fin["financialCurrency"]) ||
    (typeof ks["financialCurrency"] === "string" && ks["financialCurrency"]) ||
    currency;
  const price = rawNumber(priceMod["regularMarketPrice"]) ?? rawNumber(summary["regularMarketPrice"]);
  const marketCap = rawNumber(priceMod["marketCap"]) ?? rawNumber(summary["marketCap"]) ?? rawNumber(ks["enterpriseValue"]);
  const analystCount = fy0.analysts ?? fy1.analysts;
  if (ntm == null && forwardEps == null && fy0Eps == null) return null;
  return {
    ticker,
    asof,
    fy0Eps,
    fy1Eps,
    ntmEps: ntm,
    forwardEps,
    analystCount,
    sharesOutstanding: rawNumber(ks["sharesOutstanding"]),
    marketCap,
    currency,
    financialCurrency,
    lastFyEnd,
    nextFyEnd,
    price,
  };
}

export function parseFundamentalsTimeseries(json: unknown, ticker: string): RealizedEpsRow[] {
  const results =
    (json as { timeseries?: { result?: Array<Record<string, unknown>> } })?.timeseries?.result ?? [];
  const out: RealizedEpsRow[] = [];
  for (const block of results) {
    for (const [key, val] of Object.entries(block)) {
      if (key === "meta" || key === "timestamp") continue;
      const periodType: "annual" | "quarterly" | null = /^annual/i.test(key)
        ? "annual"
        : /^quarterly/i.test(key)
          ? "quarterly"
          : /trailingDilutedEPS/i.test(key)
            ? "annual"
            : null;
      if (!periodType || !Array.isArray(val)) continue;
      for (const pt of val as Array<Record<string, unknown>>) {
        const periodEnd = typeof pt["asOfDate"] === "string" ? String(pt["asOfDate"]).slice(0, 10) : isoFromYahooDate(pt["asOfDate"]);
        const eps = rawNumber(pt["reportedValue"] ?? pt["value"] ?? pt["eps"]);
        if (!periodEnd || eps == null) continue;
        out.push({ ticker, periodEnd, periodType, eps });
      }
    }
  }
  return out;
}

/** Convert an EPS figure from a reporting currency into the trading currency. */
export function convertEps(eps: number, fromCurrency: string | null, toCurrency: string | null, fx: number | null): number {
  if (!fromCurrency || !toCurrency || fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return eps;
  if (fx == null || !Number.isFinite(fx) || fx <= 0) return eps;
  return eps * fx;
}

/**
 * Yahoo FX pair rate that converts 1 unit of `from` into `to` (e.g. USD→CAD uses USDCAD=X).
 * `quote` is the last price of `pair`, and `inverted` means the cached pair was TOFROM=X.
 */
export function fxPairSymbol(from: string, to: string): { pair: string; invert: boolean }[] {
  const a = from.toUpperCase();
  const b = to.toUpperCase();
  if (a === b) return [];
  return [
    { pair: `${a}${b}=X`, invert: false },
    { pair: `${b}${a}=X`, invert: true },
    // Yahoo sometimes lists USDXXX as XXX=X (USD as the base).
    ...(a === "USD" ? [{ pair: `${b}=X`, invert: false }] : []),
    ...(b === "USD" ? [{ pair: `${a}=X`, invert: true }] : []),
  ];
}

export function applyFxQuote(rate: number, invert: boolean): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return invert ? 1 / rate : rate;
}

/** Trailing twelve-month EPS ending at or before `asOf`, preferring four recent quarters. */
export function trailingEpsAt(rows: RealizedEpsRow[], asOf: string): number | null {
  const quarters = rows
    .filter((r) => r.periodType === "quarterly" && r.eps != null && r.periodEnd <= asOf)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (quarters.length >= 4) {
    const last4 = quarters.slice(-4);
    return last4.reduce((s, r) => s + (r.eps ?? 0), 0);
  }
  const annuals = rows
    .filter((r) => r.periodType === "annual" && r.eps != null && r.periodEnd <= asOf)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  return annuals.at(-1)?.eps ?? null;
}

/**
 * Realized EPS of the twelve months *following* `asOf` (the usual Shiller-style
 * "price today over earnings reported in the next year"). Falls back to trailing
 * annual EPS when the next year has not been reported yet.
 */
export function forwardRealizedEps(rows: RealizedEpsRow[], asOf: string): { eps: number; basis: "next-12m" | "trailing" } | null {
  const end = addDays(asOf, 400);
  const quarters = rows
    .filter((r) => r.periodType === "quarterly" && r.eps != null && r.periodEnd > asOf && r.periodEnd <= end)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (quarters.length >= 4) {
    const first4 = quarters.slice(0, 4);
    const span = daysBetween(first4[0]!.periodEnd, first4[3]!.periodEnd);
    if (span <= 400) return { eps: first4.reduce((s, r) => s + (r.eps ?? 0), 0), basis: "next-12m" };
  }
  const annuals = rows
    .filter((r) => r.periodType === "annual" && r.eps != null && r.periodEnd > asOf && r.periodEnd <= end)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (annuals[0]?.eps != null) return { eps: annuals[0].eps, basis: "next-12m" };
  const trailing = trailingEpsAt(rows, asOf);
  return trailing != null ? { eps: trailing, basis: "trailing" } : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000;
}
