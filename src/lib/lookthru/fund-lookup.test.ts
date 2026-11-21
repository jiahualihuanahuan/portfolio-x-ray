import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  classifyHolding,
  fundCandidates,
  lookupFund,
  normalizeFundQuery,
  shapeHoldings,
  type FundLookupDeps,
} from "./fund-lookup.ts";
import { fileHoldingName, fileHoldings } from "./holdings-file.ts";
import type { HoldingLine } from "./types.ts";

const HDIV: HoldingLine[] = [
  { symbol: "HMAX.TO", name: "Hamilton Canadian Financials YIELD MAXIMIZER ETF", weight: 0.199, sector: "Fund" },
  { symbol: "HFIN.TO", name: "Hamilton Enhanced Canadian Financials ETF", weight: 0.236, sector: "Fund" },
  { symbol: "CASH", name: "Cash", weight: -0.02, sector: "Cash" },
  { symbol: "OPTIONS", name: "Options overlay", weight: -0.004, sector: "Options" },
];
const HMAX: HoldingLine[] = [
  { symbol: "RY.TO", name: "Royal Bank of Canada", weight: 0.12, sector: "Financials", country: "Canada" },
  { symbol: "TD.TO", name: "Toronto-Dominion Bank", weight: 0.11, sector: "Financials", country: "Canada" },
  { symbol: "OTHER", name: "Other holdings", weight: 0.01 },
];

function deps(over: Partial<FundLookupDeps> = {}): FundLookupDeps {
  const file: Record<string, HoldingLine[]> = { "HDIV.TO": HDIV, "HMAX.TO": HMAX };
  return {
    fromFile: (s) =>
      file[s] ? { symbol: s, holdings: file[s]!, asOf: "2026-10-30", source: "Holdings file (Hamilton ETFs)" } : null,
    fromCatalog: () => null,
    isFund: (s) => s in file,
    knownName: (s) => (s === "HMAX.TO" ? "Hamilton Canadian Financials YIELD MAXIMIZER ETF" : s === "PHW.TO" ? "Purpose PHW" : undefined),
    ...over,
  };
}

describe("fund lookup", () => {
  it("normalizes queries with or without .TO", () => {
    assert.equal(normalizeFundQuery(" hdiv "), "HDIV");
    assert.equal(normalizeFundQuery("bmax.to"), "BMAX.TO");
    assert.equal(normalizeFundQuery("<script>"), "");
    assert.equal(fundCandidates("hdiv")[0], "HDIV.TO");
    assert.equal(fundCandidates("HDIV.TO")[0], "HDIV.TO");
  });

  it("classifies stock, fund, cash, options and other holdings", () => {
    const isFund = (s: string) => s === "XEQT.TO";
    assert.equal(classifyHolding({ symbol: "RY.TO", name: "Royal Bank", weight: 0.1 }, isFund), "stock");
    assert.equal(classifyHolding({ symbol: "XEQT.TO", name: "iShares Core", weight: 0.1 }, isFund), "fund");
    assert.equal(classifyHolding({ symbol: "ZZZ", name: "Some Covered Call ETF", weight: 0.1 }, isFund), "fund");
    assert.equal(classifyHolding({ symbol: "CASH", name: "Cash", weight: 0.1 }, isFund), "cash");
    assert.equal(classifyHolding({ symbol: "OPTIONS", name: "Calls", weight: -0.01 }, isFund), "options");
    assert.equal(classifyHolding({ symbol: "OTHER", name: "Other", weight: 0.01 }, isFund), "other");
  });

  it("sorts rows by weight and marks nested funds for click-through", () => {
    const rows = shapeHoldings(HDIV, () => false);
    assert.deepEqual(rows.map((r) => r.symbol), ["HFIN.TO", "HMAX.TO", "OPTIONS", "CASH"]);
    assert.equal(rows[1]!.lookup, "HMAX.TO");
    assert.equal(rows[1]!.displaySymbol, "HMAX");
    assert.equal(rows[3]!.lookup, null);
  });

  it("passes country through to fund-lookup rows", () => {
    const rows = shapeHoldings(HMAX, () => false);
    const ry = rows.find((r) => r.symbol === "RY.TO");
    assert.equal(ry?.sector, "Financials");
    assert.equal(ry?.country, "Canada");
    const other = rows.find((r) => r.symbol === "OTHER");
    assert.equal(other?.country, undefined);
  });

  it("returns the fund's holdings, as-of, source and coverage from the file", async () => {
    const r = await lookupFund("hdiv", deps());
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.equal(r.symbol, "HDIV.TO");
    assert.equal(r.asOf, "2026-10-30");
    assert.equal(r.source, "Holdings file (Hamilton ETFs)");
    assert.ok(Math.abs(r.coverage - 0.411) < 1e-9);
    assert.equal(r.holdings[0]!.symbol, "HFIN.TO");
  });

  it("prefers the file, then the catalog, then live issuer pages (partial catalog asks the issuer first)", async () => {
    const calls: string[] = [];
    const d = deps({
      fromCatalog: (s) => (s === "BMAX.TO" ? { symbol: s, holdings: HMAX, source: "Bundled catalog snapshot", name: "Brompton BMAX" } : null),
      fromIssuer: async (s) => {
        calls.push(s);
        return s === "HYLD.TO" ? { symbol: s, holdings: HMAX, source: "Hamilton ETFs (live)" } : null;
      },
    });
    const b = await lookupFund("BMAX", d);
    assert.equal(b.status === "ok" && b.source, "Bundled catalog snapshot");
    assert.equal(b.status === "ok" && b.name, "Brompton BMAX");
    const h = await lookupFund("hyld", d);
    assert.equal(h.status === "ok" && h.source, "Hamilton ETFs (live)");
    // HMAX's snapshot is mostly OTHER, so BMAX asks the issuer first and falls back to the catalog.
    assert.deepEqual(calls, ["BMAX.TO", "HYLD.TO"]);
  });

  it("separates a known fund with no holdings from an unknown ticker", async () => {
    const known = await lookupFund("PHW", deps());
    assert.equal(known.status, "no_holdings");
    assert.match((known as { message: string }).message, /no holdings/);
    const unknown = await lookupFund("NOPE", deps());
    assert.equal(unknown.status, "not_found");
    const empty = await lookupFund("   ", deps());
    assert.equal(empty.status, "not_found");
  });

  it("reads optional fund metadata and holding names from the holdings file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lt-lookup-"));
    const file = path.join(dir, "holdings.json");
    writeFileSync(
      file,
      JSON.stringify({
        funds: {
          "HDIV.TO": { asOf: "2026-10-30", issuer: "Hamilton ETFs", source: "https://hamiltonetfs.com/etf/hdiv/", scope: "full", holdings: HDIV },
        },
      }),
    );
    const f = fileHoldings("HDIV", file);
    assert.equal(f?.issuer, "Hamilton ETFs");
    assert.equal(f?.scope, "full");
    assert.equal(fileHoldingName("HMAX", file), "Hamilton Canadian Financials YIELD MAXIMIZER ETF");
    assert.equal(fileHoldingName("ZZZZ", file), undefined);
  });
});
