import { issuerKey } from "./tickers.ts";
import type { HistoryPoint, HistoryRange } from "./fund-history.ts";
import { historySummary, rebasePoints, sliceHistory } from "./fund-history.ts";

/** Canadian-listed benchmarks used on the Fund Lookup total-return chart. */
export type BenchmarkId =
  | "sp500"
  | "nasdaq100"
  | "canada"
  | "canada-banks"
  | "canada-utilities"
  | "canada-energy"
  | "canada-tech";

export type BenchmarkLeg = { ticker: string; name: string; hedge: "unhedged" | "hedged" | "none" };

export type BenchmarkDef = {
  id: BenchmarkId;
  label: string;
  legs: BenchmarkLeg[];
};

export const BENCHMARKS: Record<BenchmarkId, BenchmarkDef> = {
  sp500: {
    id: "sp500",
    label: "S&P 500",
    legs: [
      { ticker: "VFV.TO", name: "S&P 500, unhedged", hedge: "unhedged" },
      { ticker: "VSP.TO", name: "S&P 500, hedged", hedge: "hedged" },
    ],
  },
  nasdaq100: {
    id: "nasdaq100",
    label: "Nasdaq-100",
    legs: [
      { ticker: "ZNQ.TO", name: "Nasdaq-100, unhedged", hedge: "unhedged" },
      { ticker: "XQQ.TO", name: "Nasdaq-100, hedged", hedge: "hedged" },
    ],
  },
  canada: {
    id: "canada",
    label: "S&P/TSX 60",
    legs: [{ ticker: "XIU.TO", name: "S&P/TSX 60", hedge: "none" }],
  },
  "canada-banks": {
    id: "canada-banks",
    label: "Canadian banks",
    legs: [{ ticker: "ZEB.TO", name: "Canadian banks", hedge: "none" }],
  },
  "canada-utilities": {
    id: "canada-utilities",
    label: "Canadian utilities",
    legs: [{ ticker: "ZUT.TO", name: "Canadian utilities", hedge: "none" }],
  },
  "canada-energy": {
    id: "canada-energy",
    label: "Canadian energy",
    legs: [{ ticker: "XEG.TO", name: "Canadian energy", hedge: "none" }],
  },
  "canada-tech": {
    id: "canada-tech",
    label: "Canadian tech",
    legs: [{ ticker: "XIT.TO", name: "Canadian tech", hedge: "none" }],
  },
};

/** Always prefetched, even when they are not in tickers.json or holdings.json. */
export const PREFETCH_BENCHMARK_TICKERS: string[] = [
  ...new Set(Object.values(BENCHMARKS).flatMap((b) => b.legs.map((l) => l.ticker))),
];

export type BenchmarkBasis = "manual" | "canada-sector" | "canada-broad" | "us-nasdaq" | "us-sp" | "mixed" | "single-stock";

export type HoldingLike = {
  symbol: string;
  name?: string;
  weight: number;
  sector?: string;
  country?: string;
};

export type BenchmarkMatch = {
  id: BenchmarkId;
  def: BenchmarkDef;
  basis: BenchmarkBasis;
  reason: string;
  canadaWeight: number;
  usWeight: number;
  nasdaqOverlap: number;
  topSector: { name: string; weight: number } | null;
};

/** Manual overrides for known Canadian funds (bare ticker, no suffix). */
export const MANUAL_BENCHMARKS: Record<string, BenchmarkId> = {
  HMAX: "canada-banks",
  ZWB: "canada-banks",
  BANK: "canada-banks",
  QMAX: "nasdaq100",
  ZWQ: "nasdaq100",
  USCL: "sp500",
  HYLD: "sp500",
  UTES: "canada-utilities",
  HUTL: "canada-utilities",
};

const SINGLE_STOCK_CC = new Set([
  "HHIS",
  "YNVD",
  "LLHE",
  "MSHE",
  "APLE",
  "NVHE",
  "PLTE",
  "AMHE",
  "CRWY",
  "TSLY",
  "GOGY",
  "COSY",
  "AVGY",
  "AMDY",
  "METE",
  "SPXE",
  "SOFY",
  "HODY",
  "MSTE",
  "CNYE",
  "CRCY",
  "RDDY",
]);

/**
 * Nasdaq-100 constituents used when XQQ.TO / ZNQ.TO holdings are not in the file.
 * Symbols are bare (no exchange suffix).
 */
export const NASDAQ_100_FALLBACK = new Set([
  "AAPL", "ABNB", "ADBE", "ADI", "ADP", "ADSK", "AEP", "AMAT", "AMD", "AMGN",
  "AMZN", "APP", "ARM", "ASML", "AVGO", "AXON", "AZN", "BIIB", "BKNG", "BKR",
  "CCEP", "CDNS", "CEG", "CHTR", "CMCSA", "COST", "CPRT", "CRWD", "CSCO", "CSGP",
  "CSX", "CTAS", "CTSH", "DASH", "DDOG", "DLTR", "DXCM", "EA", "EXC", "FANG",
  "FAST", "FTNT", "GEHC", "GFS", "GILD", "GOOG", "GOOGL", "HON", "IDXX", "INTC",
  "INTU", "ISRG", "KDP", "KHC", "KLAC", "LIN", "LRCX", "LULU", "MAR", "MCHP",
  "MDB", "MDLZ", "MELI", "META", "MNST", "MRVL", "MSFT", "MSTR", "MU", "NFLX",
  "NVDA", "NXPI", "ODFL", "ON", "ORLY", "PANW", "PAYX", "PCAR", "PDD", "PEP",
  "PLTR", "PYPL", "QCOM", "REGN", "ROP", "ROST", "SBUX", "SNPS", "TEAM", "TMUS",
  "TSLA", "TTD", "TTWO", "TXN", "VRSK", "VRTX", "WBD", "WDAY", "XEL", "ZS",
]);

const SECTOR_BENCHMARK: Record<string, BenchmarkId> = {
  financials: "canada-banks",
  financial: "canada-banks",
  banks: "canada-banks",
  utilities: "canada-utilities",
  utility: "canada-utilities",
  energy: "canada-energy",
  technology: "canada-tech",
  "information technology": "canada-tech",
  "info tech": "canada-tech",
  "information-technology": "canada-tech",
};

const TECH_SECTORS = new Set(["technology", "information technology", "info tech", "information-technology"]);

export function normalizeCountry(raw?: string): "Canada" | "United States" | "Other" | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^(canada|ca|can|cdn)$/.test(s) || s.startsWith("canada")) return "Canada";
  if (/^(united states|united states of america|usa|us|u\.s\.|u\.s\.a\.)$/.test(s) || s.startsWith("united states")) {
    return "United States";
  }
  return "Other";
}

export function inferCountry(h: HoldingLike): "Canada" | "United States" | "Other" | null {
  const tagged = normalizeCountry(h.country);
  if (tagged) return tagged;
  const sym = (h.symbol || "").toUpperCase();
  if (!sym || ["CASH", "OPTIONS", "OTHER"].includes(sym) || ["Cash", "Options"].includes(h.sector || "")) return null;
  if (/\.(TO|NE|V|CN|NEO)$/.test(sym)) return "Canada";
  if (!sym.includes(".")) return "United States";
  return null;
}

export function normalizeSector(raw?: string): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/_/g, " ");
  if (!s || s === "cash" || s === "options" || s === "other" || s === "fund" || s === "equity") return null;
  if (s === "financial" || s === "financials" || s === "banks") return "Financials";
  if (s === "utilities" || s === "utility") return "Utilities";
  if (s === "energy") return "Energy";
  if (s === "information technology" || s === "technology" || s === "info tech" || s === "information-technology") {
    return "Information Technology";
  }
  if (s === "consumer, non-cyclical" || s === "consumer staples") return "Consumer Staples";
  if (s === "consumer, cyclical" || s === "consumer discretionary") return "Consumer Discretionary";
  if (s === "communications" || s === "communication services") return "Communication Services";
  if (s === "industrial" || s === "industrials") return "Industrials";
  if (s === "basic materials" || s === "materials") return "Materials";
  if (s === "health care" || s === "healthcare") return "Health Care";
  return raw.trim().replace(/\s+/g, " ");
}

export type HoldingsLookup = (symbol: string) => HoldingLike[] | null;

function isPassThrough(h: HoldingLike): boolean {
  const key = issuerKey(h.symbol || "");
  return key === "CASH" || key === "OPTIONS" || key === "OTHER" || h.sector === "Cash" || h.sector === "Options";
}

/** Recurse through nested funds (weights multiplied, never renormalized). */
export function flattenHoldings(
  holdings: HoldingLike[],
  lookup: HoldingsLookup,
  depth = 0,
  trail: Set<string> = new Set(),
): HoldingLike[] {
  const out: HoldingLike[] = [];
  for (const h of holdings) {
    if (!Number.isFinite(h.weight)) continue;
    const sym = (h.symbol || "").toUpperCase();
    if (!sym || isPassThrough(h)) {
      out.push(h);
      continue;
    }
    if (depth >= 5 || trail.has(sym)) {
      out.push(h);
      continue;
    }
    const child = lookup(sym);
    if (!child || !child.length) {
      out.push(h);
      continue;
    }
    const next = new Set(trail);
    next.add(sym);
    const rolled = flattenHoldings(child, lookup, depth + 1, next).map((c) => ({
      ...c,
      weight: c.weight * h.weight,
    }));
    out.push(...rolled);
  }
  return out;
}

export function nasdaqConstituents(lookup?: HoldingsLookup): Set<string> {
  const set = new Set<string>();
  for (const t of ["XQQ.TO", "ZNQ.TO"]) {
    const rows = lookup?.(t);
    if (!rows) continue;
    for (const h of rows) {
      if (isPassThrough(h) || !h.symbol) continue;
      set.add(issuerKey(h.symbol));
    }
  }
  if (!set.size) {
    for (const s of NASDAQ_100_FALLBACK) set.add(s);
  }
  return set;
}

function looksLikeSingleStockCC(ticker: string, name?: string, holdings?: HoldingLike[]): boolean {
  const key = issuerKey(ticker);
  if (SINGLE_STOCK_CC.has(key)) return true;
  if (name && /high income shares/i.test(name)) return true;
  if (!holdings || !holdings.length) return false;
  const meaningful = holdings.filter((h) => !isPassThrough(h) && Number.isFinite(h.weight));
  if (!meaningful.length) return false;
  const his = meaningful.filter((h) => SINGLE_STOCK_CC.has(issuerKey(h.symbol)) || /high income shares/i.test(h.name || ""));
  const hisWeight = his.reduce((s, h) => s + Math.max(h.weight, 0), 0);
  const total = meaningful.reduce((s, h) => s + Math.max(h.weight, 0), 0);
  return total > 0 && hisWeight / total >= 0.5;
}

export type Exposure = {
  equity: number;
  canada: number;
  us: number;
  nasdaq: number;
  tech: number;
  topSector: { name: string; weight: number } | null;
};

export function measureExposure(leaves: HoldingLike[], constituents: Set<string>): Exposure {
  let equity = 0;
  let canada = 0;
  let us = 0;
  let nasdaq = 0;
  let tech = 0;
  const sectors = new Map<string, number>();
  for (const h of leaves) {
    if (isPassThrough(h) || !Number.isFinite(h.weight)) continue;
    const w = h.weight;
    if (w <= 0) continue;
    equity += w;
    const country = inferCountry(h);
    if (country === "Canada") canada += w;
    else if (country === "United States") us += w;
    const key = issuerKey(h.symbol);
    if (constituents.has(key)) nasdaq += w;
    const sector = normalizeSector(h.sector);
    if (sector) sectors.set(sector, (sectors.get(sector) ?? 0) + w);
    if (sector && TECH_SECTORS.has(sector.toLowerCase())) tech += w;
  }
  let topSector: Exposure["topSector"] = null;
  for (const [name, weight] of sectors) {
    if (!topSector || weight > topSector.weight) topSector = { name, weight };
  }
  return { equity, canada, us, nasdaq, tech, topSector };
}

function frac(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function sectorId(name: string | undefined): BenchmarkId | null {
  if (!name) return null;
  return SECTOR_BENCHMARK[name.toLowerCase()] ?? null;
}

export function matchBenchmark(
  ticker: string,
  holdings: HoldingLike[],
  opts?: { lookup?: HoldingsLookup; name?: string },
): BenchmarkMatch {
  const key = issuerKey(ticker);
  const manual = MANUAL_BENCHMARKS[key];
  const lookup = opts?.lookup ?? (() => null);
  const leaves = flattenHoldings(holdings, lookup);
  const constituents = nasdaqConstituents(lookup);
  const exp = measureExposure(leaves, constituents);
  const canadaWeight = frac(exp.canada, exp.equity);
  const usWeight = frac(exp.us, exp.equity);
  const nasdaqOverlap = frac(exp.nasdaq, exp.equity);
  const topSector = exp.topSector
    ? { name: exp.topSector.name, weight: frac(exp.topSector.weight, exp.equity) }
    : null;

  const pack = (id: BenchmarkId, basis: BenchmarkBasis, reason: string): BenchmarkMatch => ({
    id,
    def: BENCHMARKS[id],
    basis,
    reason,
    canadaWeight,
    usWeight,
    nasdaqOverlap,
    topSector,
  });

  if (manual) {
    return pack(manual, "manual", "manual mapping");
  }

  if (looksLikeSingleStockCC(ticker, opts?.name, holdings)) {
    const usTech = nasdaqOverlap >= 0.5 || frac(exp.tech, exp.equity) >= 0.5;
    const id: BenchmarkId = usTech ? "nasdaq100" : "sp500";
    const why = usTech
      ? `single-stock covered-call, US tech names${nasdaqOverlap ? ` (Nasdaq-100 overlap ${(nasdaqOverlap * 100).toFixed(0)}%)` : ""}`
      : "single-stock covered-call";
    return pack(id, "single-stock", why);
  }

  if (canadaWeight >= 0.6) {
    if (topSector && topSector.weight >= 0.6) {
      const id = sectorId(topSector.name);
      if (id) {
        return pack(
          id,
          "canada-sector",
          `Canadian ${topSector.name.toLowerCase()} exposure ${(topSector.weight * 100).toFixed(0)}%`,
        );
      }
    }
    return pack( "canada", "canada-broad", `Canadian exposure ${(canadaWeight * 100).toFixed(0)}%`);
  }

  if (usWeight >= 0.5) {
    if (nasdaqOverlap >= 0.5) {
      return pack("nasdaq100", "us-nasdaq", `US large-cap exposure ${(usWeight * 100).toFixed(0)}%, Nasdaq-100 overlap ${(nasdaqOverlap * 100).toFixed(0)}%`);
    }
    return pack("sp500", "us-sp", `US large-cap exposure ${(usWeight * 100).toFixed(0)}%`);
  }

  return pack("sp500", "mixed", "closest broad benchmark");
}

export type AlignedPoint = { date: string; t: number; values: Record<string, number> };

/** Intersect dates, start at the later first date, rebase each series to 1.0 (0%). */
export function alignSeries(series: Record<string, HistoryPoint[]>): AlignedPoint[] {
  const keys = Object.keys(series).filter((k) => (series[k]?.length ?? 0) >= 2);
  if (!keys.length) return [];
  const firsts = keys.map((k) => series[k]![0]!.date);
  const start = firsts.reduce((a, b) => (a > b ? a : b));
  const maps = new Map<string, Map<string, HistoryPoint>>();
  const dateSets: string[][] = [];
  for (const k of keys) {
    const m = new Map<string, HistoryPoint>();
    for (const p of series[k]!) {
      if (p.date >= start) m.set(p.date, p);
    }
    maps.set(k, m);
    dateSets.push([...m.keys()]);
  }
  const common = dateSets.reduce((acc, dates) => {
    const set = new Set(dates);
    return acc.filter((d) => set.has(d));
  });
  if (common.length < 2) return [];
  const rebased: Record<string, Map<string, number>> = {};
  for (const k of keys) {
    const pts = common.map((d) => maps.get(k)!.get(d)!);
    const rb = rebasePoints(pts);
    rebased[k] = new Map(rb.map((p) => [p.date, p.totalIndex]));
  }
  return common.map((date) => {
    const values: Record<string, number> = {};
    for (const k of keys) values[k] = rebased[k]!.get(date)!;
    return { date, t: maps.get(keys[0]!)!.get(date)!.t, values };
  });
}

export function alignRange(series: Record<string, HistoryPoint[]>, range: HistoryRange): AlignedPoint[] {
  const sliced: Record<string, HistoryPoint[]> = {};
  for (const [k, pts] of Object.entries(series)) sliced[k] = sliceHistory(pts, range);
  return alignSeries(sliced);
}

export function formatSignedPct(fraction: number, digits = 1): string {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

export function benchmarkSummaryLine(
  match: BenchmarkMatch,
  range: HistoryRange,
  fundReturn: { total: number; annualized: number | null; years: number },
  benchReturns: Array<{ ticker: string; name: string; total: number; annualized: number | null }>,
): string {
  const def = match.def;
  const unhedged = def.legs.find((l) => l.hedge === "unhedged");
  const hedged = def.legs.find((l) => l.hedge === "hedged");
  let compared: string;
  if (unhedged && hedged) {
    compared = `Compared with ${unhedged.ticker} (${def.label}, unhedged) and ${hedged.ticker} (hedged), based on: ${match.reason}.`;
  } else {
    const leg = def.legs[0]!;
    compared = `Compared with ${leg.ticker} (${leg.name}), based on: ${match.reason}.`;
  }
  const rangeLabel = range === "MAX" ? "Max" : range;
  const useAnn = fundReturn.years > 1 && fundReturn.annualized != null;
  const primary = benchReturns[0];
  if (!primary) return compared;
  const fundBit = useAnn
    ? `fund ${formatSignedPct(fundReturn.total)} (ann. ${formatSignedPct(fundReturn.annualized!)})`
    : `fund ${formatSignedPct(fundReturn.total)}`;
  const benchBit = useAnn && primary.annualized != null
    ? `${primary.ticker.replace(".TO", "")} ${formatSignedPct(primary.total)} (ann. ${formatSignedPct(primary.annualized)})`
    : `${primary.ticker.replace(".TO", "")} ${formatSignedPct(primary.total)}`;
  const diffPts = (fundReturn.total - primary.total) * 100;
  const sign = diffPts > 0 ? "+" : "";
  return `${compared} Over ${rangeLabel}: ${fundBit}, ${benchBit} (difference ${sign}${diffPts.toFixed(1)} pts).`;
}

/** Convenience: total-return change from an aligned series column. */
export function alignedReturn(points: AlignedPoint[], key: string): { total: number; annualized: number | null; years: number } | null {
  if (points.length < 2) return null;
  const fake = points
    .filter((p) => p.values[key] != null)
    .map((p) => ({ date: p.date, t: p.t, close: 0, priceIndex: p.values[key]!, totalIndex: p.values[key]! }));
  const s = historySummary(fake);
  return s ? { total: s.totalReturn, annualized: s.annualized, years: s.years } : null;
}
