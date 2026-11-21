import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  actualBySector,
  actualByTicker,
  computeRebalance,
  evaluateRow,
  parseThresholdPct,
  relativeDeviation,
  summarize,
  type Target,
} from "./rebalance.ts";
import type { LookthroughResult } from "./types.ts";

const T = 0.1;

describe("relativeDeviation", () => {
  it("is |actual − target| / target", () => {
    assert.equal(relativeDeviation(11_000, 10_000), 0.1);
    assert.equal(relativeDeviation(8_000, 10_000), 0.2);
  });
  it("handles zero targets", () => {
    assert.equal(relativeDeviation(0, 0), 0);
    assert.equal(relativeDeviation(5, 0), Number.POSITIVE_INFINITY);
  });
});

describe("evaluateRow", () => {
  it("exactly 10% off is inside the band (strictly greater than triggers)", () => {
    const r = evaluateRow("a", "ticker", "X", 10_000, 11_000, T, "rebalance");
    assert.equal(r.breached, false);
    assert.equal(r.action, "hold");
    assert.equal(r.tradeAmount, 0);
  });
  it("sells the excess when overweight beyond the band", () => {
    const r = evaluateRow("a", "ticker", "X", 10_000, 12_500, T, "rebalance");
    assert.equal(r.breached, true);
    assert.equal(r.action, "sell");
    assert.equal(r.tradeAmount, 2_500);
  });
  it("buys the shortfall when underweight beyond the band", () => {
    const r = evaluateRow("a", "ticker", "X", 10_000, 7_000, T, "rebalance");
    assert.equal(r.action, "buy");
    assert.equal(r.tradeAmount, 3_000);
  });
  it("buy-only skips sells but still buys", () => {
    const over = evaluateRow("a", "ticker", "X", 10_000, 12_500, T, "buy-only");
    assert.equal(over.breached, true);
    assert.equal(over.action, "hold");
    assert.equal(over.tradeAmount, 0);
    assert.equal(over.sellSkipped, true);
    const under = evaluateRow("b", "ticker", "Y", 10_000, 7_000, T, "buy-only");
    assert.equal(under.action, "buy");
    assert.equal(under.tradeAmount, 3_000);
  });
  it("a target of 0 sells the whole position", () => {
    const r = evaluateRow("a", "ticker", "X", 0, 4_000, T, "rebalance");
    assert.equal(r.breached, true);
    assert.equal(r.action, "sell");
    assert.equal(r.tradeAmount, 4_000);
  });
  it("respects a custom threshold", () => {
    assert.equal(evaluateRow("a", "ticker", "X", 10_000, 10_600, 0.05, "rebalance").breached, true);
    assert.equal(evaluateRow("a", "ticker", "X", 10_000, 12_000, 0.25, "rebalance").breached, false);
  });
});

describe("summarize", () => {
  it("nets buys against sells", () => {
    const s = summarize([
      evaluateRow("a", "ticker", "A", 10_000, 13_000, T, "rebalance"),
      evaluateRow("b", "ticker", "B", 10_000, 6_000, T, "rebalance"),
      evaluateRow("c", "ticker", "C", 10_000, 10_500, T, "rebalance"),
    ]);
    assert.equal(s.breaches, 2);
    assert.equal(s.totalSell, 3_000);
    assert.equal(s.totalBuy, 4_000);
    assert.equal(s.netCash, 1_000);
  });
  it("buy-only cash needed equals the sum of shortfalls", () => {
    const s = summarize([
      evaluateRow("a", "ticker", "A", 10_000, 13_000, T, "buy-only"),
      evaluateRow("b", "ticker", "B", 10_000, 6_000, T, "buy-only"),
      evaluateRow("c", "ticker", "C", 5_000, 2_000, T, "buy-only"),
    ]);
    assert.equal(s.totalSell, 0);
    assert.equal(s.totalBuy, 7_000);
    assert.equal(s.netCash, 7_000);
  });
});

function fakeResult(): LookthroughResult {
  const pos = (ticker: string, value: number) => ({
    id: ticker,
    ticker,
    resolved: ticker,
    name: ticker,
    kind: "etf" as const,
    shares: 1,
    price: value,
    currency: "CAD",
    value,
    weight: 0,
    changePct: null,
    coverage: 1,
    source: "catalog" as const,
  });
  return {
    nav: 30_000,
    currency: "CAD",
    equityExposure: 1,
    positions: [pos("HYLD.TO", 20_000), pos("XEQT.TO", 10_000)],
    leaves: [],
    sectors: [
      { name: "Financials", value: 12_000, weight: 0.4 },
      { name: "Information Technology", value: 18_000, weight: 0.6 },
    ],
    countries: [],
    trees: [],
    unresolved: [],
    warnings: [],
    fxUsdCad: 1.4,
  };
}

describe("computeRebalance", () => {
  const targets: Target[] = [
    { id: "1", kind: "ticker", key: "hyld.to", amount: 15_000 },
    { id: "2", kind: "ticker", key: "XEQT.TO", amount: 10_000 },
    { id: "3", kind: "ticker", key: "VFV.TO", amount: 5_000 },
    { id: "4", kind: "sector", key: "financials", amount: 15_000 },
    { id: "5", kind: "sector", key: "Information Technology", amount: 14_000 },
  ];
  const result = fakeResult();
  const opts = { threshold: T, mode: "rebalance" as const };

  it("matches ticker targets to directly held positions (case-insensitive)", () => {
    const s = computeRebalance(targets, "ticker", actualByTicker(result), opts);
    const byKey = Object.fromEntries(s.rows.map((r) => [r.key.toUpperCase(), r]));
    assert.equal(byKey["HYLD.TO"]!.action, "sell");
    assert.equal(byKey["HYLD.TO"]!.tradeAmount, 5_000);
    assert.equal(byKey["XEQT.TO"]!.action, "hold");
    assert.equal(byKey["VFV.TO"]!.actual, 0);
    assert.equal(byKey["VFV.TO"]!.action, "buy");
    assert.equal(byKey["VFV.TO"]!.tradeAmount, 5_000);
    assert.equal(s.rows.length, 3, "sector targets are not mixed into the ticker view");
  });

  it("matches sector targets to look-through sectors (case-insensitive, CAD)", () => {
    const s = computeRebalance(targets, "sector", actualBySector(result), opts);
    const fin = s.rows.find((r) => r.id === "4")!;
    assert.equal(fin.action, "buy");
    assert.equal(fin.tradeAmount, 3_000);
    const tech = s.rows.find((r) => r.id === "5")!;
    assert.equal(tech.target, 14_000);
    assert.equal(tech.action, "sell");
    assert.equal(Math.round(tech.tradeAmount), 4_000);
  });

  it("works with no portfolio (everything is a buy)", () => {
    const s = computeRebalance(targets, "ticker", actualByTicker(null), opts);
    assert.ok(s.rows.every((r) => r.action === "buy"));
    assert.equal(s.netCash, 30_000);
  });
});

describe("parseThresholdPct", () => {
  it("reads percent text", () => {
    assert.equal(parseThresholdPct("10"), 0.1);
    assert.equal(parseThresholdPct("2.5"), 0.025);
    assert.equal(parseThresholdPct("abc"), 0.1);
    assert.equal(parseThresholdPct("-3"), 0.1);
  });
});
