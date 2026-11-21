import { COMPLETE_COVERAGE, disclosedCoverage, nameLooksLikeFund } from "./holdings-parse.ts";
import { candidateSymbols, displaySymbol, issuerKey, normalizeTicker } from "./tickers.ts";
import type { HoldingLine } from "./types.ts";

/**
 * Single-fund lookup ("Fund Lookup" tab): one ticker in, that fund's own holdings out.
 * Pure; the server wires the sources (holdings file, issuer adapters, catalog) in
 * fund-lookup.server.ts so this stays testable without network or disk.
 */

export type FundHoldingKind = "stock" | "fund" | "cash" | "options" | "other";

export type FundHoldingRow = {
  symbol: string;
  displaySymbol: string;
  name: string;
  kind: FundHoldingKind;
  /** Fraction of the fund (0.199 = 19.9%). Leverage can make cash negative. */
  weight: number;
  sector?: string;
  country?: string;
  /** Ticker to look up next when this holding is itself a fund; null otherwise. */
  lookup: string | null;
};

/** One source's view of a fund, before shaping. */
export type FundSource = {
  symbol: string;
  holdings: HoldingLine[];
  name?: string;
  asOf?: string;
  /** Human label, e.g. "Holdings file (Hamilton ETFs)". */
  source: string;
  sourceUrl?: string;
  scope?: string;
};

export type FundLookupFound = {
  status: "ok";
  query: string;
  symbol: string;
  displaySymbol: string;
  name: string;
  asOf: string | null;
  source: string;
  sourceUrl: string | null;
  scope: string | null;
  /** Sum of all holding weights (negative cash included). */
  coverage: number;
  holdings: FundHoldingRow[];
};

export type FundLookupMissing = {
  status: "not_found" | "no_holdings";
  query: string;
  symbol: string | null;
  name: string | null;
  message: string;
};

export type FundLookupResult = FundLookupFound | FundLookupMissing;

export type FundLookupDeps = {
  /** Pre-scraped holdings file. */
  fromFile: (symbol: string) => FundSource | null;
  /** Bundled catalog snapshot (only when it has usable holdings). */
  fromCatalog: (symbol: string) => FundSource | null;
  /** Live issuer adapters (cached). Optional so callers can stay offline. */
  fromIssuer?: (symbol: string) => Promise<FundSource | null>;
  /** True when a holding should be treated as a fund (file/issuer/catalog know it). */
  isFund: (symbol: string) => boolean;
  /** A known name for a ticker that has no holdings of its own (catalog or file labels). */
  knownName: (symbol: string) => string | undefined;
};

const MAX_QUERY = 40;

/** "bmax", " HYLD.to ", "hdiv" → upper-case ticker, or "" when unusable. */
export function normalizeFundQuery(raw: string): string {
  const n = normalizeTicker(String(raw ?? "")).slice(0, MAX_QUERY);
  return /^[A-Z0-9][A-Z0-9.\-=]*$/.test(n) ? n : "";
}

/** Symbols to try in order; a bare ticker prefers its TSX listing (BMAX → BMAX.TO). */
export function fundCandidates(raw: string): string[] {
  const q = normalizeFundQuery(raw);
  if (!q) return [];
  const all = candidateSymbols(q);
  if (q.includes(".")) return all;
  const tsx = all.filter((s) => s.endsWith(".TO"));
  return [...new Set([...tsx, ...all])];
}

export function classifyHolding(h: HoldingLine, isFund: (symbol: string) => boolean): FundHoldingKind {
  const key = issuerKey(h.symbol || "");
  if (key === "CASH" || h.sector === "Cash") return "cash";
  if (key === "OPTIONS" || h.sector === "Options") return "options";
  if (key === "OTHER" || !h.symbol) return "other";
  if (h.sector === "Fund" || nameLooksLikeFund(h.name || "") || isFund(h.symbol)) return "fund";
  return "stock";
}

export function shapeHoldings(holdings: HoldingLine[], isFund: (symbol: string) => boolean): FundHoldingRow[] {
  return holdings
    .filter((h) => Number.isFinite(h.weight))
    .map((h) => {
      const kind = classifyHolding(h, isFund);
      const symbol = h.symbol || "OTHER";
      return {
        symbol,
        displaySymbol: displaySymbol(symbol),
        name: h.name || symbol,
        kind,
        weight: h.weight,
        sector: h.sector,
        country: h.country,
        lookup: kind === "fund" && h.symbol ? h.symbol : null,
      };
    })
    .sort((a, b) => b.weight - a.weight || a.displaySymbol.localeCompare(b.displaySymbol));
}

function found(query: string, src: FundSource, deps: FundLookupDeps): FundLookupFound {
  const holdings = shapeHoldings(src.holdings, deps.isFund);
  return {
    status: "ok",
    query,
    symbol: src.symbol,
    displaySymbol: displaySymbol(src.symbol),
    name: src.name || deps.knownName(src.symbol) || displaySymbol(src.symbol),
    asOf: src.asOf ?? null,
    source: src.source,
    sourceUrl: src.sourceUrl ?? null,
    scope: src.scope ?? null,
    coverage: holdings.reduce((s, h) => s + h.weight, 0),
    holdings,
  };
}

export async function lookupFund(raw: string, deps: FundLookupDeps): Promise<FundLookupResult> {
  const query = normalizeFundQuery(raw);
  const candidates = fundCandidates(raw);
  if (!query || !candidates.length) {
    return { status: "not_found", query: String(raw ?? "").trim(), symbol: null, name: null, message: "Enter a fund ticker such as HDIV, HYLD or BMAX." };
  }

  for (const c of candidates) {
    const hit = deps.fromFile(c);
    if (hit) return found(query, hit, deps);
  }
  let partialCatalog: FundSource | null = null;
  for (const c of candidates) {
    const hit = deps.fromCatalog(c);
    if (!hit) continue;
    // A catalog snapshot that names only the top holdings (the rest is OTHER) is a fallback:
    // try the issuer first so a full list wins.
    if (deps.fromIssuer && disclosedCoverage(hit.holdings) < COMPLETE_COVERAGE) {
      partialCatalog ??= hit;
      continue;
    }
    return found(query, hit, deps);
  }
  if (deps.fromIssuer) {
    // Live issuer pages: only the preferred listing, to keep one lookup to a few requests.
    const hit = await deps.fromIssuer(candidates[0]!);
    if (hit && (!partialCatalog || disclosedCoverage(hit.holdings) >= disclosedCoverage(partialCatalog.holdings))) {
      return found(query, hit, deps);
    }
  }
  if (partialCatalog) return found(query, partialCatalog, deps);

  for (const c of candidates) {
    const name = deps.knownName(c);
    if (name || deps.isFund(c)) {
      return {
        status: "no_holdings",
        query,
        symbol: c,
        name: name ?? null,
        message: `${displaySymbol(c)}${name ? ` (${name})` : ""} is known, but no holdings have been published or loaded for it.`,
      };
    }
  }
  return {
    status: "not_found",
    query,
    symbol: null,
    name: null,
    message: `No fund found for ${query}. Check the ticker, or load a newer holdings file.`,
  };
}
