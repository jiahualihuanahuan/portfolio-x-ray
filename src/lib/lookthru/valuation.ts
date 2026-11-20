/**
 * Forward P/E math. Pure — no I/O, no Yahoo, no SQLite.
 *
 * NTM EPS blends FY1 and FY2 by the fraction of the current fiscal year remaining.
 * Portfolio / sector / index P/E is aggregate value over aggregate earnings
 * (a harmonic mean of the names' P/Es), not an average of P/Es.
 */

export const NM = "n/m" as const;
export type PeValue = number | typeof NM;

export type ValuationKind = "equity" | "cash" | "options" | "other" | "etf" | "fund" | "bond";

/** A weighted name with an optional next-twelve-months EPS and last price, same currency. */
export type ValuationHolding = {
  symbol: string;
  name?: string;
  weight: number;
  sector?: string;
  kind?: ValuationKind;
  /** Next-twelve-months EPS, in the same currency as `price`. */
  ntmEps?: number | null;
  price?: number | null;
  analystCount?: number | null;
  /** True when this is an unresolved nested fund (excluded). */
  unresolved?: boolean;
};

export type ForwardPeResult = {
  /** Harmonic / aggregate P/E, or 'n/m' when aggregate earnings are not positive. */
  pe: PeValue;
  /** Σ w_i × (NTM EPS_i / price_i) over names used in the P/E. */
  impliedEarningsPerDollar: number;
  /** Weight with usable estimates / gross equity weight. */
  coverage: number;
  namesCovered: number;
  namesEligible: number;
  medianAnalystCount: number | null;
  /** Gross (positive) equity weight; negative cash is ignored. */
  equityWeight: number;
  estimatedWeight: number;
  /** Sum of weights actually used in the harmonic P/E (usually equals estimatedWeight). */
  peWeight: number;
};

export type SectorPeRow = ForwardPeResult & { sector: string; weight: number };

const CASH_SYMBOLS = new Set(["CASH", "USD", "CAD", "EUR", "GBP", "CCE"]);
const OPTIONS_SYMBOLS = new Set(["OPTIONS", "OPT"]);
const OTHER_SYMBOLS = new Set(["OTHER"]);
const BOND_SECTORS = new Set(["fixed income", "bond", "bonds", "government", "treasury"]);
const CASH_SECTORS = new Set(["cash"]);
const OPTIONS_SECTORS = new Set(["options", "option"]);

export function monthsLeftInFiscalYear(
  asOf: Date,
  nextFiscalYearEnd?: Date | null,
  lastFiscalYearEnd?: Date | null,
): number {
  const start = lastFiscalYearEnd && Number.isFinite(lastFiscalYearEnd.getTime()) ? lastFiscalYearEnd : null;
  const end =
    nextFiscalYearEnd && Number.isFinite(nextFiscalYearEnd.getTime())
      ? nextFiscalYearEnd
      : start
        ? addYears(start, 1)
        : endOfCalendarYear(asOf);
  const yearMs =
    start && end.getTime() > start.getTime() ? end.getTime() - start.getTime() : 365.25 * 24 * 60 * 60 * 1000;
  const leftMs = end.getTime() - asOf.getTime();
  const months = (leftMs / yearMs) * 12;
  if (!Number.isFinite(months)) return 6;
  return Math.min(12, Math.max(0, months));
}

function addYears(d: Date, years: number): Date {
  const next = new Date(d.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function endOfCalendarYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
}

/**
 * Next-twelve-months EPS: FY1 × (months left / 12) + FY2 × (1 − that).
 * FY1 is the current fiscal year (Yahoo period 0y), FY2 is the next (Yahoo +1y).
 */
export function ntmEps(fy1: number, fy2: number, monthsLeft: number): number {
  const frac = Math.min(1, Math.max(0, monthsLeft / 12));
  return fy1 * frac + fy2 * (1 - frac);
}

export function earningsYield(ntmEps: number, price: number): number | null {
  if (!Number.isFinite(ntmEps) || !Number.isFinite(price) || price === 0) return null;
  return ntmEps / price;
}

export function isCashLike(h: ValuationHolding): boolean {
  const sym = (h.symbol || "").toUpperCase();
  const kind = h.kind;
  const sec = (h.sector || "").trim().toLowerCase();
  if (kind === "cash") return true;
  if (CASH_SYMBOLS.has(sym)) return true;
  if (CASH_SECTORS.has(sec)) return true;
  return false;
}

export function isOptionsLike(h: ValuationHolding): boolean {
  const sym = (h.symbol || "").toUpperCase();
  if (h.kind === "options") return true;
  if (OPTIONS_SYMBOLS.has(sym)) return true;
  if (OPTIONS_SECTORS.has((h.sector || "").trim().toLowerCase())) return true;
  return false;
}

export function isBondLike(h: ValuationHolding): boolean {
  if (h.kind === "bond") return true;
  const sec = (h.sector || "").trim().toLowerCase();
  return BOND_SECTORS.has(sec);
}

export function isUnresolvedFund(h: ValuationHolding): boolean {
  // Only fund lines that could not be unrolled. Flattened equity leaves
  // must not set `unresolved`.
  return h.unresolved === true;
}

/**
 * Names that contribute to equity weight. Cash (including negative cash on
 * leveraged funds), bonds, options, other residual, and unresolved funds are out.
 * Loss-makers stay in.
 */
export function isEquityForPe(h: ValuationHolding): boolean {
  const sym = (h.symbol || "").toUpperCase();
  if (!sym) return false;
  if (OTHER_SYMBOLS.has(sym) || h.kind === "other") return false;
  if (isCashLike(h) || isOptionsLike(h) || isBondLike(h) || isUnresolvedFund(h)) return false;
  // Negative cash already caught; drop non-positive equity weights from the
  // gross equity denominator (gross leaf weights only).
  if ((h.weight ?? 0) <= 0) return false;
  return true;
}

export function hasUsableEstimate(h: ValuationHolding): boolean {
  return (
    isEquityForPe(h) &&
    h.ntmEps != null &&
    Number.isFinite(h.ntmEps) &&
    h.price != null &&
    Number.isFinite(h.price) &&
    h.price !== 0
  );
}

export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!;
}

/**
 * Aggregate forward P/E for a set of holdings: Σ w / Σ (w × E/P).
 * That is aggregate value / aggregate earnings — a harmonic mean — not the
 * arithmetic average of the names' P/Es.
 *
 * If aggregate earnings are 0 or below, returns 'n/m'. (A non-positive
 * denominator is not a meaningful P/E; the phrasing "10 or below" in the
 * brief is treated as non-positive earnings, since a P/E of 10 is normal.)
 */
export function aggregateForwardPe(holdings: ValuationHolding[]): ForwardPeResult {
  const eligible = holdings.filter(isEquityForPe);
  const equityWeight = eligible.reduce((s, h) => s + h.weight, 0);
  const estimated = eligible.filter(hasUsableEstimate);
  const estimatedWeight = estimated.reduce((s, h) => s + h.weight, 0);
  let earnings = 0;
  let peWeight = 0;
  for (const h of estimated) {
    const y = earningsYield(h.ntmEps as number, h.price as number);
    if (y == null) continue;
    earnings += h.weight * y;
    peWeight += h.weight;
  }
  const coverage = equityWeight > 0 ? estimatedWeight / equityWeight : 0;
  const analystCounts = estimated
    .map((h) => h.analystCount)
    .filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
  const impliedEarningsPerDollar = peWeight > 0 ? earnings / peWeight : earnings;
  const pe: PeValue = peWeight > 0 && earnings > 0 ? peWeight / earnings : NM;
  return {
    pe,
    impliedEarningsPerDollar,
    coverage,
    namesCovered: estimated.length,
    namesEligible: eligible.length,
    medianAnalystCount: median(analystCounts),
    equityWeight,
    estimatedWeight,
    peWeight,
  };
}

export function arithmeticAveragePe(holdings: ValuationHolding[]): PeValue {
  const estimated = holdings.filter(hasUsableEstimate);
  if (!estimated.length) return NM;
  let sum = 0;
  let w = 0;
  for (const h of estimated) {
    const y = earningsYield(h.ntmEps as number, h.price as number);
    if (y == null || y <= 0) continue;
    sum += h.weight * (1 / y);
    w += h.weight;
  }
  return w > 0 ? sum / w : NM;
}

export function sectorForwardPes(holdings: ValuationHolding[]): SectorPeRow[] {
  const bySector = new Map<string, ValuationHolding[]>();
  for (const h of holdings) {
    if (!isEquityForPe(h)) continue;
    const sector = (h.sector || "").trim() || "Unclassified";
    const list = bySector.get(sector) ?? [];
    list.push(h);
    bySector.set(sector, list);
  }
  const rows: SectorPeRow[] = [];
  for (const [sector, list] of bySector) {
    const agg = aggregateForwardPe(list);
    rows.push({ ...agg, sector, weight: agg.equityWeight });
  }
  rows.sort((a, b) => b.weight - a.weight || a.sector.localeCompare(b.sector));
  return rows;
}

/**
 * Percentile rank of `value` in `history`: the share of historical points
 * that are less than or equal to `value`, in 0–100. Returns null when there
 * are fewer than two finite history points.
 *
 * Do not compare a name to another sector's history — pass only that
 * name's (or that sector's) own series.
 */
export function percentileRank(value: number, history: number[]): number | null {
  if (!Number.isFinite(value)) return null;
  const xs = history.filter((v) => Number.isFinite(v) && v > 0);
  if (xs.length < 2) return null;
  let le = 0;
  for (const v of xs) if (v <= value) le += 1;
  return (le / xs.length) * 100;
}

export function formatPe(pe: PeValue, digits = 1): string {
  if (pe === NM || !Number.isFinite(pe)) return NM;
  return `${pe.toFixed(digits)}x`;
}

export const REAL_SERIES_MIN_DAYS = 250;


export type ValuationSector = {
  sector: string;
  pe: PeValue;
  peLabel: string;
  percentile: number | null;
  percentileLabel: string;
  weight: number;
  coverage: number;
  namesCovered: number;
};

export type ValuationReport = {
  status: "ok" | "error";
  symbol: string;
  displaySymbol: string;
  name?: string;
  asOf: string;
  pe: PeValue;
  peLabel: string;
  coverage: number;
  namesCovered: number;
  namesEligible: number;
  medianAnalystCount: number | null;
  equityWeight: number;
  percentile: number | null;
  percentileKind: "forward" | "proxy" | null;
  percentileLabel: string;
  historyLength: number;
  sectors: ValuationSector[];
  benchmark?: {
    symbol: string;
    label: string;
    pe: PeValue;
    peLabel: string;
    coverage: number;
  };
  methodology: string[];
  constituents?: {
    source: string;
    sourceUrl?: string;
    proxyFor?: string;
    partial: boolean;
    coverage: number;
    count: number;
  };
  message?: string;
};
