import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  bromptonFund,
  bromptonFundByName,
  bromptonHoldings,
  classifyBromptonRow,
  isBlockedPage,
  parseBromptonHtml,
  parsePortfolioSummaryLeverage,
} from "./brompton.ts";
import {
  BROMPTON_DELAY_MS,
  fetchBromptonFund,
  readCachedFund,
  refreshBromptonTree,
  resetPoliteGate,
} from "./brompton.server.ts";
import { lookupFund, type FundLookupDeps } from "./fund-lookup.ts";
import { disclosedCoverage } from "./holdings-parse.ts";
import { composeLookthrough } from "./lookthrough.ts";
import { equityKey } from "./tickers.ts";
import type { HoldingLine, Instrument } from "./types.ts";

/** Minimal copy of the bromptongroup.com markup: name, % of portfolio, % of NAV. */
function page(title: string, asOf: string, rows: [string, string, string][], pdf?: string): string {
  const trs = rows
    .map(([n, p, v], i) => `<tr class="${i % 2 ? "even" : "odd"} -${i + 1}"><td class="first">${n}</td><td class="second"><center>${p}</center></td><td class="third">${v}</td></tr>`)
    .join("");
  return `<html><head><title>${title}</title></head><body>
<div>Summary of Investment Portfolio as at ${asOf}&sup1; &sup2;</div>
${pdf ? `<a href="${pdf}">Portfolio Summary</a>` : ""}
<div class="holding_table container"><h3>Top Holdings</h3><table class="portfolio_holding_tbls"><thead><th class="first"></th><th class="second"><center>% of Portfolio</center></th><th class="third">% of Net Asset Value</th></thead><tbody>${trs}<tr><td class="first">Total</td><td class="second"><center>100%</center></td><td class="third"></td></tr></tbody></table></div></body></html>`;
}

const BMAX_PDF = "https://www.bromptongroup.com/wp-content/uploads/2018/11/BMAX_Portfolio_Summary.pdf";

const BMAX_HTML = page(
  "BMAX | Brompton Enhanced Multi-Asset Income ETF",
  "October 31, 2026",
  [
    ["Brompton Tech Leaders Income ETF", "50.0%", ""],
    ["Brompton Split Corp. Preferred Share ETF", "30.0%", ""],
    ["Brompton Wellington Square Investment Grade CLO ETF", "20.0%", ""],
  ],
  BMAX_PDF,
);

const TLF_HTML = page("TLF | Brompton Tech Leaders Income ETF", "October 31, 2026", [
  ["Apple Inc.", "", "60.0%"],
  ["NVIDIA Corporation", "", "40.8%"],
  ["Other net assets (liabilities)", "", "-0.8%"],
]);

const SPLT_HTML = page("SPLT | Brompton Split Corp. Preferred Share ETF", "October 31, 2026", [
  ["Dividend 15 Split Corp. Preferred Shares", "", "70.0%"],
  ["Brompton Wellington Square AAA CLO ETF", "", "20.0%"],
  ["Cash", "", "10.0%"],
]);

const BAAA_HTML = page("BAAA | Brompton Wellington Square AAA CLO ETF", "October 31, 2026", [
  ["BBAM US CLO VII Ltd. 5.0081% due July 27, 2039", "", "50.0%"],
  ["Janus Henderson AAA CLO ETF", "", "30.0%"],
]);

/** `pdftotext -layout` lines from the BMAX Portfolio Summary (as at September 30, 2026). */
const BMAX_PDF_TEXT = `Brompton Enhanced Multi-Asset Income ETF
Summary of Investment Portfolio
as at September 30, 2026
Total Investments                            100.0%              129.4%
Cash                                           0.0%                0.0%
Loans payable                                                    (28.3%)
Other net assets (liabilities)                                    (1.1%)
Total                                        100.0%              100.0%
`;

describe("Brompton page parsing", () => {
  it("reads % of portfolio rows, as-of date and the summary PDF link", () => {
    const p = parseBromptonHtml(BMAX_HTML);
    assert.ok(p);
    assert.equal(p.basis, "portfolio");
    assert.equal(p.asOf, "2026-10-31");
    assert.equal(p.summaryPdfUrl, BMAX_PDF);
    assert.deepEqual(p.rows.map((r) => r.weight), [0.5, 0.3, 0.2]);
  });

  it("prefers the % of NAV column when the page fills it", () => {
    const p = parseBromptonHtml(TLF_HTML);
    assert.ok(p);
    assert.equal(p.basis, "nav");
    assert.equal(p.rows.length, 3);
    assert.equal(p.rows[2]!.weight, -0.008);
  });

  it("detects a Cloudflare block page", () => {
    assert.equal(isBlockedPage("<title>Attention Required! | Cloudflare</title>"), true);
    assert.equal(isBlockedPage(TLF_HTML), false);
  });

  it("reads leverage from the Portfolio Summary text", () => {
    const lev = parsePortfolioSummaryLeverage(BMAX_PDF_TEXT);
    assert.ok(lev);
    assert.equal(lev.asOf, "2026-09-30");
    assert.ok(Math.abs(lev.grossInvested - 1.294) < 1e-9);
    assert.ok(Math.abs(lev.netOther - -0.294) < 1e-9);
  });

  it("classifies funds, preferred shares, CLO tranches, cash and companies", () => {
    assert.equal(bromptonFundByName("Brompton Global Infrastucture ETF")?.ticker, "BGIE.TO");
    assert.equal(bromptonFund("HIG.U")?.ticker, "HIG.TO");
    assert.equal(classifyBromptonRow("Brompton Tech Leaders Income ETF"), "fund");
    assert.equal(classifyBromptonRow("Dividend 15 Split Corp. Preferred Shares"), "fixed-income");
    assert.equal(classifyBromptonRow("Partners Value Split Corp. Class AA Preferred Shares Series 15"), "fixed-income");
    assert.equal(classifyBromptonRow("BBAM US CLO VII Ltd. 5.0081% due July 27, 2039"), "fixed-income");
    assert.equal(classifyBromptonRow("Other net assets (liabilities)"), "cash");
    assert.equal(classifyBromptonRow("Fifth Third Bancorp., 6.875%"), "fixed-income");
    assert.equal(classifyBromptonRow("Apple Inc."), "equity");
  });

  it("scales % of portfolio to % of NAV and books the loan as negative cash, total unchanged", () => {
    const p = parseBromptonHtml(BMAX_HTML)!;
    const h = bromptonHoldings(p, () => null, parsePortfolioSummaryLeverage(BMAX_PDF_TEXT));
    const total = h.reduce((s, x) => s + x.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `total ${total}`);
    assert.equal(h[0]!.symbol, "TLF.TO");
    assert.ok(Math.abs(h[0]!.weight - 0.647) < 1e-9);
    assert.equal(h[1]!.symbol, "SPLT.TO");
    assert.ok(h[2]!.symbol.startsWith("FI:"), "unlisted CLO fund kept as a named fixed-income line");
    const cash = h.find((x) => x.symbol === "CASH")!;
    assert.ok(Math.abs(cash.weight - -0.294) < 1e-9);
  });
});

describe("Brompton fetcher (fake network, temp cache)", () => {
  let dir = "";
  let clock = 0;
  const sleeps: number[] = [];
  const urls: string[] = [];
  const pages: Record<string, string> = {
    "brompton-enhanced-multi-asset-income-etf": BMAX_HTML,
    "tech-leaders-income-etf": TLF_HTML,
    "brompton-split-corp-preferred-share-etf": SPLT_HTML,
    "brompton-wellington-square-aaa-clo-etf": BAAA_HTML,
  };
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith(".pdf")) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    if (url.includes("finance.yahoo.com")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      const symbol = /janus/i.test(q) ? "JAAA" : "";
      return new Response(
        JSON.stringify({
          quotes: symbol ? [{ symbol: "VALE", quoteType: "ETF", shortname: "Vale S.A." }, { symbol, quoteType: "ETF", longname: "Janus Henderson AAA CLO ETF" }] : [],
        }),
        { status: 200 },
      );
    }
    const slug = url.match(/product\/([^/]+)\//)?.[1] ?? "";
    const html = pages[slug];
    return html ? new Response(html, { status: 200 }) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  const deps = () => ({
    fetch: fakeFetch,
    dir,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    pdfToText: async () => BMAX_PDF_TEXT,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brompton-test-"));
    clock = 1_000_000;
    sleeps.length = 0;
    urls.length = 0;
    resetPoliteGate();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("walks BMAX → TLF / SPLT → BAAA, honouring the 10 s crawl delay, and caches each fund", async () => {
    const fetched = await refreshBromptonTree("BMAX.TO", deps());
    assert.equal(fetched, 4);
    const bromptonCalls = urls.filter((u) => u.includes("bromptongroup.com"));
    assert.equal(bromptonCalls.length, 5, "4 pages + 1 PDF");
    assert.ok(sleeps.filter((ms) => ms >= BROMPTON_DELAY_MS - 1).length >= 4, `sleeps ${sleeps}`);
    const bmax = readCachedFund("BMAX.TO", dir)!;
    assert.equal(bmax.asOf, "2026-10-31");
    assert.equal(bmax.leverage?.asOf, "2026-09-30");
    const baaa = readCachedFund("BAAA.TO", dir)!;
    assert.equal(baaa.holdings.find((h) => /Janus/.test(h.name))?.symbol, "JAAA");
    const names = JSON.parse(readFileSync(join(dir, "name-tickers.json"), "utf8"));
    assert.ok(Object.keys(names).length >= 1);

    // Fresh cache: a second walk makes no requests.
    urls.length = 0;
    assert.equal(await refreshBromptonTree("BMAX.TO", deps()), 0);
    assert.equal(urls.length, 0);
  });

  it("keeps the old cache when Cloudflare blocks a refresh", async () => {
    await fetchBromptonFund("TLF.TO", deps());
    const before = readCachedFund("TLF.TO", dir)!;
    const blocked = (async () => new Response("<title>Attention Required! | Cloudflare</title>", { status: 200 })) as unknown as typeof fetch;
    const got = await fetchBromptonFund("TLF.TO", { ...deps(), fetch: blocked });
    assert.equal(got, null);
    assert.deepEqual(readCachedFund("TLF.TO", dir), before);
  });

  it("unrolls the cached BMAX tree to single stocks with totals preserved", async () => {
    await refreshBromptonTree("BMAX.TO", deps());
    const bag: Record<string, Instrument> = {};
    for (const t of ["BMAX.TO", "TLF.TO", "SPLT.TO", "BAAA.TO"]) {
      const c = readCachedFund(t, dir)!;
      bag[t] = inst(t, c.holdings, t === "BMAX.TO" ? 13.35 : 10);
    }
    const r = composeLookthrough([{ id: "1", ticker: "BMAX.TO", shares: 100 }], bag, { "BMAX.TO": "BMAX.TO" }, 1.4, "CAD");
    assert.ok(Math.abs(r.nav - 1335) < 1e-9);
    const total = r.leaves.reduce((s, l) => s + l.value, 0);
    assert.ok(Math.abs(total - 1335) < 1e-6, `leaf total ${total}`);
    const w = (k: string) => r.leaves.filter((l) => equityKey(l.symbol) === k).reduce((s, l) => s + l.weight, 0);
    // TLF 50% × 1.294 = 64.7% of NAV; Apple is 60% of TLF.
    assert.ok(Math.abs(w("AAPL") - 0.647 * 0.6) < 1e-9, JSON.stringify(r.leaves.map((l) => [l.symbol, l.weight])));
    assert.ok(Math.abs(w("NVDA") - 0.647 * 0.408) < 1e-9);
    // Cash = BMAX loan -29.4% + TLF other -0.8% × 64.7% + SPLT cash 10% × 38.82%.
    assert.ok(Math.abs(w("CASH") - (-0.294 + 0.647 * -0.008 + 0.3882 * 0.1)) < 1e-9);
    // Nothing undisclosed in this fixture except BAAA's 20% (top holdings only) → 1.552% of NAV.
    const other = w("OTHER");
    assert.ok(Math.abs(other - 0.3882 * 0.2 * 0.2) < 1e-9, `other ${other}`);
    assert.ok(r.warnings.some((m) => /BAAA: the issuer names 80% of holdings; the other 20% shows as OTHER/.test(m)));
    const pref = r.leaves.find((l) => l.symbol.startsWith("FI:DIVIDEND-15"));
    assert.equal(pref?.kind, "other");
    assert.equal(pref?.sector, "Fixed Income");
  });
});

describe("partial catalog snapshots", () => {
  it("disclosedCoverage ignores OTHER rows", () => {
    const h: HoldingLine[] = [
      { symbol: "MSFT", name: "Microsoft", weight: 0.032 },
      { symbol: "OTHER", name: "Other", weight: 0.852 },
      { symbol: "CASH", name: "Cash", weight: 0.005 },
    ];
    assert.ok(Math.abs(disclosedCoverage(h) - 0.037) < 1e-12);
  });

  it("Fund Lookup asks the issuer before settling for a mostly-OTHER catalog entry", async () => {
    const partial: HoldingLine[] = [
      { symbol: "MSFT", name: "Microsoft", weight: 0.03 },
      { symbol: "AAPL", name: "Apple", weight: 0.03 },
      { symbol: "NVDA", name: "NVIDIA", weight: 0.03 },
      { symbol: "OTHER", name: "Other", weight: 0.91 },
    ];
    const full: HoldingLine[] = [
      { symbol: "TLF.TO", name: "Brompton Tech Leaders Income ETF", weight: 0.6, sector: "Fund" },
      { symbol: "BFIN.TO", name: "Brompton North American Financials Dividend ETF", weight: 0.4, sector: "Fund" },
    ];
    let issuerCalls = 0;
    const deps: FundLookupDeps = {
      fromFile: () => null,
      fromCatalog: (s) => (s === "XYZ.TO" ? { symbol: s, holdings: partial, source: "catalog" } : null),
      fromIssuer: async (s) => {
        issuerCalls++;
        return { symbol: s, holdings: full, source: "issuer" };
      },
      isFund: () => true,
      knownName: () => undefined,
    };
    const r = await lookupFund("XYZ", deps);
    assert.equal(issuerCalls, 1);
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.source, "issuer");
  });
});

function inst(symbol: string, holdings: HoldingLine[], price: number): Instrument {
  return {
    symbol,
    displaySymbol: symbol.replace(/\.TO$/, ""),
    name: symbol,
    kind: "etf",
    currency: "CAD",
    price,
    changePct: null,
    holdings,
    sectors: [],
    source: "issuer",
    coverage: disclosedCoverage(holdings),
  };
}
