import { bromptonFund } from "./brompton";
import { bromptonHoldingsCached } from "./brompton.server";
import { catalogInstrument } from "./catalog";
import { fileHoldingName, fileHoldings } from "./holdings-file";
import { holdingsAreUsable } from "./holdings-parse";
import { fetchIssuerHoldings, isIssuerFundTicker } from "./issuers.server";
import { lookupFund, type FundLookupDeps, type FundLookupResult } from "./fund-lookup";

const ISSUER_LABEL: Record<string, string> = {
  harvest: "Harvest ETFs (live)",
  hamilton: "Hamilton ETFs (live)",
  evolve: "Evolve ETFs (live)",
  purpose: "Purpose Investments (live)",
  brompton: "Brompton Group (bromptongroup.com, cached)",
  index: "Index holdings file (issuer CSV)",
  file: "Holdings file",
};

export const serverFundLookupDeps: FundLookupDeps = {
  fromFile(symbol) {
    const f = fileHoldings(symbol);
    if (!f) return null;
    return {
      symbol: symbol.toUpperCase(),
      holdings: f.holdings,
      name: f.name,
      asOf: f.asOf,
      source: f.issuer ? `Holdings file (${f.issuer})` : "Holdings file",
      sourceUrl: f.source && /^https?:\/\//.test(f.source) ? f.source : undefined,
      scope: f.scope,
    };
  },
  fromCatalog(symbol) {
    // Brompton funds: the cached bromptongroup.com list (with leverage) is newer than the snapshot.
    if (bromptonFund(symbol)) {
      const cached = bromptonHoldingsCached(symbol);
      if (cached && holdingsAreUsable(cached.holdings)) {
        return { symbol: cached.ticker, holdings: cached.holdings, name: cached.name, asOf: cached.asOf, source: "Brompton Group (bromptongroup.com, cached)", sourceUrl: cached.source, scope: "top 25 holdings (quarterly)" };
      }
    }
    const c = catalogInstrument(symbol);
    if (!c || !holdingsAreUsable(c.holdings)) return null;
    return { symbol: c.symbol, holdings: c.holdings!, name: c.name, asOf: c.asOf, source: "Bundled catalog snapshot" };
  },
  async fromIssuer(symbol) {
    const hit = await fetchIssuerHoldings(symbol);
    if (!hit || !holdingsAreUsable(hit.holdings)) return null;
    return { symbol, holdings: hit.holdings, asOf: hit.asOf, source: ISSUER_LABEL[hit.issuer] ?? hit.issuer };
  },
  isFund(symbol) {
    if (isIssuerFundTicker(symbol)) return true;
    const c = catalogInstrument(symbol);
    return Boolean(c && (c.kind === "etf" || holdingsAreUsable(c.holdings)));
  },
  knownName(symbol) {
    const c = catalogInstrument(symbol);
    if (c?.name) return c.name;
    const n = fileHoldingName(symbol);
    return n;
  },
};

export function lookupFundServer(ticker: string): Promise<FundLookupResult> {
  return lookupFund(ticker, serverFundLookupDeps);
}
