import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeLookthrough } from "./lookthrough.ts";
import { lookupFund, shapeHoldings, type FundLookupDeps } from "./fund-lookup.ts";
import { equityKey } from "./tickers.ts";
import type { HoldingLine, Instrument, Position } from "./types.ts";

/** Nested Hamilton all-in-one plus one child; child is levered. */
const NESTED: Record<string, HoldingLine[]> = {
  "HDIV.TO": [
    { symbol: "HMAX.TO", name: "Hamilton Canadian Financials YIELD MAXIMIZER ETF", weight: 0.2, sector: "Fund" },
    { symbol: "QMAX.TO", name: "Hamilton Technology YIELD MAXIMIZER ETF", weight: 0.2, sector: "Fund" },
    { symbol: "CASH", name: "Cash", weight: -0.05, sector: "Cash" },
  ],
  "HMAX.TO": [
    { symbol: "RY.TO", name: "Royal Bank of Canada", weight: 0.5, sector: "Financials", country: "Canada" },
    { symbol: "TD.TO", name: "Toronto-Dominion Bank", weight: 0.5, sector: "Financials", country: "Canada" },
  ],
  "QMAX.TO": [
    { symbol: "NVDA", name: "NVIDIA Corp", weight: 1.25, sector: "Information Technology", country: "United States" },
    { symbol: "CASH", name: "Cash", weight: -0.25, sector: "Cash" },
  ],
};

/** Same tree already flattened (parent_weight × child_weight, duplicates merged). */
const FLAT: Record<string, HoldingLine[]> = {
  "HDIV.TO": [
    { symbol: "RY.TO", name: "Royal Bank of Canada", weight: 0.2 * 0.5, sector: "Financials", country: "Canada" },
    { symbol: "TD.TO", name: "Toronto-Dominion Bank", weight: 0.2 * 0.5, sector: "Financials", country: "Canada" },
    { symbol: "NVDA", name: "NVIDIA Corp", weight: 0.2 * 1.25, sector: "Information Technology", country: "United States" },
    { symbol: "CASH", name: "Cash", weight: -0.05 + 0.2 * -0.25, sector: "Cash" },
  ],
};

const AYLD_LEAVES: HoldingLine[] = [
  { symbol: "AAPL", name: "Apple Inc", weight: 0.08, sector: "Information Technology", country: "United States" },
  { symbol: "RY.TO", name: "Royal Bank of Canada", weight: 0.06, sector: "Financials", country: "Canada" },
  { symbol: "CASH", name: "Cash", weight: 0.02, sector: "Cash" },
];

const BMAX_LEAVES: HoldingLine[] = [
  { symbol: "JNJ", name: "Johnson & Johnson", weight: 0.05, sector: "Health Care", country: "United States" },
  { symbol: "ENB.TO", name: "Enbridge Inc", weight: 0.04, sector: "Energy", country: "Canada" },
  { symbol: "OTHER", name: "Other / undisclosed", weight: 0.01, sector: "Other" },
];

function instrument(symbol: string, holdings: HoldingLine[]): Instrument {
  return {
    symbol,
    displaySymbol: symbol.replace(/\.(TO|NE|V)$/i, ""),
    name: symbol,
    kind: "etf",
    currency: "CAD",
    price: 10,
    changePct: null,
    holdings,
    sectors: [],
    source: "issuer",
    coverage: holdings.reduce((s, h) => s + Math.abs(h.weight), 0),
  };
}

function bagFrom(funds: Record<string, HoldingLine[]>): Record<string, Instrument> {
  const bag: Record<string, Instrument> = {};
  for (const [sym, holdings] of Object.entries(funds)) {
    bag[sym] = instrument(sym, holdings);
  }
  return bag;
}

function lookthrough(ticker: string, funds: Record<string, HoldingLine[]>) {
  const positions: Position[] = [{ id: "1", ticker, shares: 100 }];
  const instruments = bagFrom(funds);
  return composeLookthrough(positions, instruments, { [ticker]: ticker }, 1.37, "CAD");
}

function leafWeights(result: ReturnType<typeof composeLookthrough>): Map<string, number> {
  const m = new Map<string, number>();
  for (const leaf of result.leaves) {
    const key = equityKey(leaf.symbol);
    m.set(key, (m.get(key) ?? 0) + leaf.weight);
  }
  return m;
}

describe("fund-of-funds look-through agreement", () => {
  it("runtime recursion on a nested FoF matches pre-flattened leaf weights (no double-count)", () => {
    const nested = lookthrough("HDIV.TO", NESTED);
    const flat = lookthrough("HDIV.TO", FLAT);

    const nw = leafWeights(nested);
    const fw = leafWeights(flat);
    assert.deepEqual([...nw.keys()].sort(), [...fw.keys()].sort());
    for (const [sym, w] of fw) {
      assert.ok(Math.abs((nw.get(sym) ?? 0) - w) < 1e-12, `${sym}: nested ${nw.get(sym)} vs flat ${w}`);
    }

    // Leverage: 20% × 125% NVDA, cash is parent -5% plus 20% × -25%.
    const nav = 100 * 10;
    const nvda = nested.leaves.find((l) => equityKey(l.symbol) === "NVDA");
    const cash = nested.leaves.find((l) => equityKey(l.symbol) === "CASH");
    const ry = nested.leaves.find((l) => equityKey(l.symbol) === "RY");
    assert.ok(nvda && cash && ry);
    assert.ok(Math.abs(nvda.weight - 0.25) < 1e-12);
    assert.ok(Math.abs(cash.weight - -0.1) < 1e-12);
    assert.ok(Math.abs(ry.weight - 0.1) < 1e-12);
    assert.equal(ry.sector, "Financials");
    assert.equal(ry.country, "Canada");
    assert.equal(nvda.sector, "Information Technology");
    assert.equal(nvda.country, "United States");
    // Values also agree (same NAV, no double-count of the 20% child).
    assert.ok(Math.abs(nvda.value - nav * 0.25) < 1e-9);
    assert.equal(nested.leaves.length, flat.leaves.length);
  });

  it("does not double-count when the bag also contains child funds next to a pre-flattened parent", () => {
    // Flattened parent + child instruments must not unroll again.
    const mixed = { ...NESTED, "HDIV.TO": FLAT["HDIV.TO"]! };
    const result = lookthrough("HDIV.TO", mixed);
    const nvda = result.leaves.find((l) => equityKey(l.symbol) === "NVDA");
    assert.ok(nvda);
    assert.ok(Math.abs(nvda.weight - 0.25) < 1e-12);
    assert.equal(result.leaves.filter((l) => equityKey(l.symbol) === "NVDA").length, 1);
  });
});

describe("fund lookup on AYLD and BMAX leaves", () => {
  function deps(): FundLookupDeps {
    const file: Record<string, HoldingLine[]> = {
      "AYLD.TO": AYLD_LEAVES,
      "BMAX.TO": BMAX_LEAVES,
    };
    return {
      fromFile: (s) =>
        file[s]
          ? { symbol: s, holdings: file[s]!, asOf: "2026-11-19", source: "Holdings file fixture" }
          : null,
      fromCatalog: () => null,
      isFund: (s) => s in file,
      knownName: (s) =>
        s === "AYLD.TO"
          ? "Global X All-in-One Income ETF"
          : s === "BMAX.TO"
            ? "Brompton Enhanced Multi-Asset Income ETF"
            : undefined,
    };
  }

  it("shows AYLD leaves with sector and country", async () => {
    const r = await lookupFund("AYLD", deps());
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.equal(r.symbol, "AYLD.TO");
    const aapl = r.holdings.find((h) => h.symbol === "AAPL");
    const ry = r.holdings.find((h) => h.symbol === "RY.TO");
    assert.equal(aapl?.sector, "Information Technology");
    assert.equal(aapl?.country, "United States");
    assert.equal(ry?.sector, "Financials");
    assert.equal(ry?.country, "Canada");
    const cash = r.holdings.find((h) => h.symbol === "CASH");
    assert.equal(cash?.sector, "Cash");
    // Cash has no country in the fixture / is excluded from country mix at the table level.
    assert.equal(cash?.country, undefined);
  });

  it("shows BMAX leaves with sector and country", async () => {
    const r = await lookupFund("BMAX", deps());
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.equal(r.symbol, "BMAX.TO");
    const jnj = r.holdings.find((h) => h.symbol === "JNJ");
    const enb = r.holdings.find((h) => h.symbol === "ENB.TO");
    assert.equal(jnj?.sector, "Health Care");
    assert.equal(jnj?.country, "United States");
    assert.equal(enb?.sector, "Energy");
    assert.equal(enb?.country, "Canada");
    const rows = shapeHoldings(BMAX_LEAVES, () => false);
    assert.equal(rows.find((row) => row.symbol === "JNJ")?.country, "United States");
    assert.equal(rows.find((row) => row.symbol === "ENB.TO")?.sector, "Energy");
  });
});
