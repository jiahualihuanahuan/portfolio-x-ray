import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bucketRange,
  greedyPair,
  parseTickerList,
  planBuckets,
  splitByHoldings,
  validateBuckets,
  type Bucket,
  type BucketPlan,
} from "./core-satellite.ts";

const G = 0.1;
const model: Bucket[] = [
  { id: "core", name: "Core", role: "core", tickers: ["HYOD.TO"], min: 0.54, max: 0.66 },
  { id: "tech", name: "Sector ETFs", role: "satellite", tickers: ["XLK", "XLF"], target: 0.1 },
  { id: "btc", name: "Bitcoin", role: "satellite", tickers: ["BTCC.TO"], target: 0.1 },
  { id: "gold", name: "Gold", role: "satellite", tickers: ["CGL.TO"], target: 0.1 },
  { id: "miners", name: "Miners", role: "satellite", tickers: ["XGD.TO"], target: 0.1, band: 0.2 },
];

function pos(values: Record<string, number>) {
  return Object.entries(values).map(([ticker, value]) => ({ ticker, value }));
}

function assertInBand(plan: BucketPlan) {
  for (const b of plan.buckets) {
    assert.ok(b.weightAfter >= b.range.lo - 1e-6 && b.weightAfter <= b.range.hi + 1e-6, `${b.name} ${b.weightAfter} not in ${b.range.lo}–${b.range.hi}`);
  }
}

describe("bucketRange", () => {
  it("core uses its min/max with the midpoint as target", () => {
    const r = bucketRange(model[0]!, G);
    assert.equal(r.lo, 0.54);
    assert.equal(r.hi, 0.66);
    assert.ok(Math.abs(r.target - 0.6) < 1e-12);
  });
  it("satellite without a band uses the global relative band", () => {
    const r = bucketRange(model[1]!, G);
    assert.ok(Math.abs(r.lo - 0.09) < 1e-12 && Math.abs(r.hi - 0.11) < 1e-12);
    assert.equal(r.usesGlobalBand, true);
    const m = bucketRange(model[4]!, G);
    assert.ok(Math.abs(m.lo - 0.08) < 1e-12 && Math.abs(m.hi - 0.12) < 1e-12);
    assert.equal(m.usesGlobalBand, false);
  });
});

describe("validateBuckets", () => {
  it("accepts the example model", () => {
    assert.deepEqual(validateBuckets(model, G), []);
  });
  it("rejects a ticker in both core and a satellite", () => {
    const bad = model.map((b) => (b.id === "gold" ? { ...b, tickers: ["CGL.TO", "hyod.to"] } : b));
    const issues = validateBuckets(bad, G);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /HYOD.TO is in both the core and a satellite/);
  });
  it("rejects core min + satellites over 100%", () => {
    const bad = model.map((b) => (b.id === "core" ? { ...b, min: 0.65, max: 0.7 } : b));
    assert.match(validateBuckets(bad, G)[0]!.message, /more than 100%/);
  });
  it("rejects core max + satellites under 100%", () => {
    const bad = model.map((b) => (b.id === "core" ? { ...b, min: 0.4, max: 0.5 } : b));
    assert.match(validateBuckets(bad, G)[0]!.message, /less than 100%/);
  });
  it("rejects two cores, inverted ranges and missing targets", () => {
    assert.ok(validateBuckets([...model, { id: "c2", name: "Core 2", role: "core", tickers: [], min: 0.1, max: 0.2 }], G).some((i) => /Only one core/.test(i.message)));
    assert.ok(validateBuckets([{ ...model[0]!, min: 0.7, max: 0.6 }], G).some((i) => /min ≤ max/.test(i.message)));
    assert.ok(validateBuckets([model[0]!, { ...model[1]!, target: undefined }], G).some((i) => /needs a target/.test(i.message)));
  });
  it("without a core, satellites must add to 100%", () => {
    assert.match(validateBuckets([model[1]!, model[2]!], G)[0]!.message, /add up to 100%/);
  });
});

describe("planBuckets — sell & buy (minimal moves to the nearest band edge)", () => {
  it("does nothing when everything is in band", () => {
    const p = planBuckets(model, pos({ "HYOD.TO": 60_000, XLK: 10_000, "BTCC.TO": 10_000, "CGL.TO": 10_000, "XGD.TO": 10_000 }), { globalBand: G, mode: "rebalance" });
    assert.equal(p.allInBand, true);
    assert.equal(p.transfers.length, 0);
  });
  it("one overweight + one underweight → a single transfer, only to the band edge", () => {
    // Bitcoin ran up to 14%, gold fell to 6%.
    const p = planBuckets(model, pos({ "HYOD.TO": 60_000, XLK: 10_000, "BTCC.TO": 14_000, "CGL.TO": 6_000, "XGD.TO": 10_000 }), { globalBand: G, mode: "rebalance" });
    assert.equal(p.transfers.length, 1);
    const t = p.transfers[0]!;
    assert.equal(t.from, "btc");
    assert.equal(t.to, "gold");
    assert.ok(Math.abs(t.amount - 3_000) < 1e-6, `moved ${t.amount}`); // btc 14k → 11k edge; gold 6k → 9k edge
    assertInBand(p);
    const btc = p.buckets.find((b) => b.id === "btc")!;
    assert.ok(Math.abs(btc.weightAfter - 0.11) < 1e-9, "stops at the upper edge, not the 10% target");
  });
  it("pairs largest with largest and keeps the trade count minimal", () => {
    // Core 70% (over by 4k), btc 13% (over 2k); gold 5% (under 4k), sector 8% (under 1k), miners 4% (under 4k)…
    const p = planBuckets(model, pos({ "HYOD.TO": 70_000, XLK: 8_000, "BTCC.TO": 13_000, "CGL.TO": 5_000, "XGD.TO": 4_000 }), { globalBand: G, mode: "rebalance" });
    assertInBand(p);
    // 2 sources (core, btc) and 3 sinks (gold, miners, sector): greedy needs at most 2 + 3 − 1 = 4 moves.
    assert.equal(p.transfers.length, 4, JSON.stringify(p.transfers));
    const moved = p.transfers.reduce((s, t) => s + t.amount, 0);
    assert.ok(Math.abs(moved - 9_000) < 1e-6, "moves exactly the 9k needed to reach the lower edges");
    assert.equal(p.transfers[0]!.from, "core", "largest excess moves first");
    const sells = p.buckets.filter((b) => b.trade < 0).map((b) => b.id).sort();
    assert.deepEqual(sells, ["btc", "core"], "only overweight buckets sell");
  });
  it("when underweights need more than overweights free, trims in-band buckets with the most slack", () => {
    const p = planBuckets(model, pos({ "HYOD.TO": 66_000, XLK: 11_000, "BTCC.TO": 11_000, "CGL.TO": 4_000, "XGD.TO": 8_000 }), { globalBand: G, mode: "rebalance" });
    assertInBand(p);
    assert.equal(p.transfers.length, 1, "one move from the biggest slack (core) to gold");
    assert.equal(p.transfers[0]!.from, "core");
    assert.ok(Math.abs(p.transfers[0]!.amount - 5_000) < 1e-6);
  });
  it("leaves holdings outside every bucket alone and reports them", () => {
    const p = planBuckets(model, pos({ "HYOD.TO": 60_000, XLK: 10_000, "BTCC.TO": 10_000, "CGL.TO": 10_000, "XGD.TO": 10_000, AAPL: 5_000 }), { globalBand: G, mode: "rebalance" });
    assert.deepEqual(p.unassigned, [{ ticker: "AAPL", value: 5_000 }]);
    assert.equal(p.total, 100_000);
  });
});

describe("planBuckets — buy-only (minimal new cash)", () => {
  it("buys only the shortfall to the lower edge", () => {
    // Gold at 7k of 97k ≈ 7.2%, below 9%. Minimal T' solves 0.09·T' − 7k = T' − 97k → T' = 98,901.1
    const p = planBuckets(model, pos({ "HYOD.TO": 60_000, XLK: 10_000, "BTCC.TO": 10_000, "CGL.TO": 7_000, "XGD.TO": 10_000 }), { globalBand: G, mode: "buy-only" });
    assert.equal(Object.keys(p.newCash).length, 1);
    assert.ok(Math.abs(p.newCash["gold"]! - (0.09 * p.totalAfter - 7_000)) < 1e-3);
    assert.ok(Math.abs(p.totalAfter - 90_000 / 0.91) < 0.01);
    assertInBand(p);
    assert.ok(p.buckets.every((b) => b.trade >= 0), "never sells");
  });
  it("an overweight bucket forces enough new cash to dilute it under its max", () => {
    // Bitcoin 15k of 100k; needs total ≥ 15k / 0.11 = 136,363.6
    const p = planBuckets(model, pos({ "HYOD.TO": 60_000, XLK: 10_000, "BTCC.TO": 15_000, "CGL.TO": 7_500, "XGD.TO": 7_500 }), { globalBand: G, mode: "buy-only" });
    assert.ok(Math.abs(p.totalAfter - 15_000 / 0.11) < 0.01);
    assert.ok(Math.abs(p.newCashTotal - (p.totalAfter - p.total)) < 1e-3);
    assert.equal(p.newCash["btc"], undefined);
    assertInBand(p);
  });
});

describe("greedyPair", () => {
  it("matches largest source with largest sink", () => {
    const t = greedyPair([{ id: "a", amount: 5 }, { id: "b", amount: 1 }], [{ id: "x", amount: 4 }, { id: "y", amount: 2 }]);
    assert.deepEqual(t, [
      { from: "a", to: "x", amount: 4 },
      { from: "a", to: "y", amount: 1 },
      { from: "b", to: "y", amount: 1 },
    ]);
  });
});

describe("splitByHoldings", () => {
  const held = new Map([["XLK", 6_000], ["XLF", 2_000]]);
  it("splits in proportion to current holdings", () => {
    const s = splitByHoldings(1_000, ["XLK", "XLF"], held);
    assert.equal(s.kind, "split");
    if (s.kind === "split") {
      assert.equal(s.basis, "proportional");
      assert.deepEqual(s.parts, [{ ticker: "XLK", amount: 750 }, { ticker: "XLF", amount: 250 }]);
    }
  });
  it("single-ticker buckets take the whole amount", () => {
    const s = splitByHoldings(500, ["cgl.to"], new Map());
    assert.deepEqual(s, { kind: "split", basis: "single", parts: [{ ticker: "CGL.TO", amount: 500 }] });
  });
  it("asks the user when nothing is held in a multi-ticker bucket or there are no tickers", () => {
    assert.equal(splitByHoldings(500, ["A", "B"], new Map()).kind, "choose");
    assert.equal(splitByHoldings(500, [], new Map()).kind, "choose");
  });
  it("parses ticker lists", () => {
    assert.deepEqual(parseTickerList("hyod.to, XEQT ;xeqt"), ["HYOD.TO", "XEQT"]);
  });
});
