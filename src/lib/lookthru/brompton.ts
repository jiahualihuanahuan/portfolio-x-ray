/**
 * Brompton Group fund pages (bromptongroup.com/product/<slug>/) publish a quarterly
 * "Summary of Investment Portfolio": the top 25 holdings by name, either as % of NAV or
 * as % of portfolio. Fund-of-funds like BMAX list other Brompton ETFs, so each row is
 * mapped to a ticker here and the look-through recurses into the child fund.
 *
 * Pure parsing only; fetching and caching live in brompton.server.ts.
 */
import { normalizeCompanyName, sectorOf, tickerFromCompanyName } from "./catalog.ts";
import { parseAsOf, parseWeight, stripTags } from "./holdings-parse.ts";
import { stripShareClass } from "./tickers.ts";
import type { HoldingLine } from "./types.ts";

export type BromptonFund = { ticker: string; slug: string; name: string };

/** Brompton ETFs whose product page has a holdings table. Tickers are TSX listings. */
export const BROMPTON_FUNDS: BromptonFund[] = [
  { ticker: "BMAX.TO", slug: "brompton-enhanced-multi-asset-income-etf", name: "Brompton Enhanced Multi-Asset Income ETF" },
  { ticker: "BFIN.TO", slug: "brompton-north-american-financials-dividend-etf", name: "Brompton North American Financials Dividend ETF" },
  { ticker: "TLF.TO", slug: "tech-leaders-income-etf", name: "Brompton Tech Leaders Income ETF" },
  { ticker: "BGIE.TO", slug: "brompton-global-infrastructure-etf", name: "Brompton Global Infrastructure ETF" },
  { ticker: "BDIV.TO", slug: "brompton-global-dividend-growth-etf", name: "Brompton Global Dividend Growth ETF" },
  { ticker: "BLOV.TO", slug: "brompton-north-american-low-volatility-dividend-etf", name: "Brompton North American Low Volatility Dividend ETF" },
  { ticker: "EDGF.TO", slug: "european-dividend-growth-fund", name: "Brompton European Dividend Growth ETF" },
  { ticker: "HIG.TO", slug: "global-healthcare-income-growth-etf", name: "Brompton Global Healthcare Income & Growth ETF" },
  { ticker: "SPLT.TO", slug: "brompton-split-corp-preferred-share-etf", name: "Brompton Split Corp. Preferred Share ETF" },
  { ticker: "BPRF.TO", slug: "brompton-flaherty-crumrine-investment-grade-preferred-etf", name: "Brompton Flaherty & Crumrine Investment Grade Preferred ETF" },
  { ticker: "BAAA.TO", slug: "brompton-wellington-square-aaa-clo-etf", name: "Brompton Wellington Square AAA CLO ETF" },
];

const BY_BASE = new Map(BROMPTON_FUNDS.map((f) => [stripShareClass(f.ticker), f]));
const BY_NAME = new Map(BROMPTON_FUNDS.map((f) => [normalizeCompanyName(f.name), f]));

export function bromptonFund(symbol: string): BromptonFund | null {
  return BY_BASE.get(stripShareClass(symbol)) ?? null;
}

export function bromptonFundByName(name: string): BromptonFund | null {
  return BY_NAME.get(normalizeCompanyName(name.replace(/infrastucture/i, "infrastructure"))) ?? null;
}

export function bromptonUrl(fund: BromptonFund): string {
  return `https://www.bromptongroup.com/product/${fund.slug}/`;
}

export type BromptonRow = { name: string; weight: number };

export type BromptonPage = {
  rows: BromptonRow[];
  asOf?: string;
  /** "nav" = % of net asset value (includes leverage), "portfolio" = % of invested assets. */
  basis: "nav" | "portfolio";
  /** Linked "Portfolio Summary" PDF, which carries the % of NAV column and loans payable. */
  summaryPdfUrl?: string;
};

export function isBlockedPage(html: string): boolean {
  return /<title>\s*Attention Required!\s*\|\s*Cloudflare/i.test(html) || /cf-error-details|cf-chl-/i.test(html);
}

export function parseBromptonHtml(html: string): BromptonPage | null {
  const start = html.indexOf('class="portfolio_holding_tbls"');
  if (start < 0) return null;
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end < 0 ? undefined : end);
  const portfolio: BromptonRow[] = [];
  const nav: BromptonRow[] = [];
  for (const tr of table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1] ?? ""));
    const name = (cells[0] ?? "").trim();
    if (!name || /^total$/i.test(name)) continue;
    const p = parseWeight(cells[1] ?? "");
    const n = parseWeight(cells[2] ?? "");
    if (p != null) portfolio.push({ name, weight: p });
    if (n != null) nav.push({ name, weight: n });
  }
  const basis = nav.length >= portfolio.length && nav.length > 0 ? "nav" : "portfolio";
  const rows = basis === "nav" ? nav : portfolio;
  if (!rows.length) return null;
  const text = stripTags(html);
  const asOfRaw = text.match(/Summary of Investment Portfolio as at ([A-Za-z]+ \d{1,2}, 20\d\d)/i)?.[1];
  const pdf = html.match(/href="(https:\/\/www\.bromptongroup\.com\/[^"]*_Portfolio_Summary\.pdf)"/i)?.[1];
  return { rows, asOf: asOfRaw ? parseAsOf(asOfRaw) : undefined, basis, summaryPdfUrl: pdf };
}

export type BromptonLeverage = {
  asOf?: string;
  /** Total investments as a fraction of NAV, e.g. 1.294. */
  grossInvested: number;
  /** Loans payable plus other net assets as a fraction of NAV (negative), e.g. -0.294. */
  netOther: number;
};

function pctCells(line: string): number[] {
  return [...line.matchAll(/\(?-?\d+(?:\.\d+)?%\)?/g)]
    .map((m) => parseWeight(m[0]))
    .filter((n): n is number => n != null);
}

/**
 * Reads leverage from `pdftotext -layout` output of a Portfolio Summary PDF:
 *   Total Investments    100.0%   129.4%
 *   Loans payable                 (28.3%)
 *   Other net assets (liabilities) (1.1%)
 */
export function parsePortfolioSummaryLeverage(text: string): BromptonLeverage | null {
  const lines = text.split(/\r?\n/);
  let gross: number | null = null;
  let other = 0;
  let sawLoans = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^Total Investments\b/i.test(t)) {
      const cells = pctCells(t);
      if (cells.length >= 2) gross = cells[1]!;
    } else if (/^Loans payable\b/i.test(t)) {
      const cells = pctCells(t);
      if (cells.length) {
        other += cells[cells.length - 1]!;
        sawLoans = true;
      }
    } else if (/^Other net assets\b/i.test(t)) {
      const cells = pctCells(t.replace(/\(liabilities\)/i, ""));
      if (cells.length) other += cells[cells.length - 1]!;
    }
  }
  if (gross == null || !sawLoans || gross < 1 || gross > 3) return null;
  const asOfRaw = text.match(/as at ([A-Za-z]+ \d{1,2}, 20\d\d)/i)?.[1];
  return {
    asOf: asOfRaw ? parseAsOf(asOfRaw) : undefined,
    grossInvested: gross,
    netOther: Math.round(other * 1e6) / 1e6,
  };
}

export type RowKind = "fund" | "fixed-income" | "cash" | "equity";

export function classifyBromptonRow(name: string): RowKind {
  if (/^(cash|other net assets|net other assets|cash and cash equivalents)\b/i.test(name)) return "cash";
  if (bromptonFundByName(name)) return "fund";
  if (/\bpreferred shares?\b|\bpreferreds?\b.*\bseries\b|\bdue (january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}, 20\d\d\b|\bCLO\b.*\bLtd\b|\b\d+\.\d+% (notes|bonds|debentures)\b|,\s*\d{1,2}\.\d{2,4}%/i.test(name)) {
    return "fixed-income";
  }
  if (/\b(ETF|fund|trust units)\b/i.test(name)) return "fund";
  return "equity";
}

/** Stable pseudo-symbol for a named non-listed line (preferred share, CLO tranche, bond). */
export function fixedIncomeSymbol(name: string): string {
  const slug = normalizeCompanyName(name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `FI:${slug.slice(0, 48)}`;
}

export type NameResolver = (name: string) => string | null | undefined;

/**
 * Turn page rows into look-through holdings. `resolve` maps a company name to a ticker
 * (catalog, holdings file, cached Yahoo search). Unresolved companies keep their name with a
 * `NAME:` pseudo-symbol so they still count as a single disclosed holding rather than OTHER.
 * When the page is % of portfolio and the PDF gives leverage, weights are scaled to % of NAV
 * and the borrowing is added as negative cash, so the weights still sum to the page total.
 */
export function bromptonHoldings(
  page: BromptonPage,
  resolve: NameResolver,
  leverage?: BromptonLeverage | null,
): HoldingLine[] {
  const scale = page.basis === "portfolio" && leverage ? leverage.grossInvested : 1;
  const out: HoldingLine[] = [];
  let cash = 0;
  for (const row of page.rows) {
    const weight = Math.round(row.weight * scale * 1e6) / 1e6;
    const kind = classifyBromptonRow(row.name);
    if (kind === "cash") {
      cash += weight;
      continue;
    }
    if (kind === "fund") {
      const fund = bromptonFundByName(row.name);
      const symbol = fund?.ticker ?? resolve(row.name) ?? fixedIncomeSymbol(row.name);
      out.push({ symbol, name: row.name, weight, sector: "Fund" });
      continue;
    }
    if (kind === "fixed-income") {
      out.push({ symbol: fixedIncomeSymbol(row.name), name: row.name, weight, sector: "Fixed Income" });
      continue;
    }
    const symbol = resolve(row.name) ?? tickerFromCompanyName(row.name) ?? null;
    if (symbol && symbol !== "CASH") {
      out.push({ symbol, name: row.name, weight, sector: sectorOf(symbol) !== "Other" ? sectorOf(symbol) : undefined });
    } else {
      out.push({ symbol: `NAME:${normalizeCompanyName(row.name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 40)}`, name: row.name, weight });
    }
  }
  if (page.basis === "portfolio" && leverage) cash += leverage.netOther;
  if (Math.abs(cash) > 1e-6) {
    out.push({ symbol: "CASH", name: leverage && page.basis === "portfolio" ? "Cash, loans payable & other" : "Cash & other net assets", weight: Math.round(cash * 1e6) / 1e6, sector: "Cash" });
  }
  return out;
}
