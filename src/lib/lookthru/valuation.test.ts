import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NM,
  aggregateForwardPe,
  arithmeticAveragePe,
  formatPe,
  hasUsableEstimate,
  isEquityForPe,
  monthsLeftInFiscalYear,
  ntmEps,
  percentileRank,
  sectorForwardPes,
  type ValuationHolding,
} from "./valuation.ts";

describe("NTM EPS blend", () => {
  it("weights FY1 by months left in the fiscal year and FY2 by the rest", () => {
    // 3 months left → 3/12 FY1 + 9/12 FY2
    assert.equal(ntmEps(10, 14, 3), 10 * 0.25 + 14 * 0.75);
    assert.equal(ntmEps(10, 14, 3), 13);
    // At fiscal year end, NTM is all FY2.
    assert.equal(ntmEps(10, 14, 0), 14);
    // Just after a fiscal year starts, NTM is all FY1.
    assert.equal(ntmEps(10, 14, 12), 10);
  });

  it("computes months left from the next fiscal year end", () => {
    const asOf = new Date("2026-10-31T00:00:00Z");
    const last = new Date("2026-01-31T00:00:00Z");
    const next = new Date("2027-01-31T00:00:00Z");
    const months = monthsLeftInFiscalYear(asOf, next, last);
    // 31 Oct → 31 Jan is ~3/12 of a 365-day fiscal year.
    assert.ok(Math.abs(months - 3) < 0.15, `months=${months}`);
    const eps = ntmEps(4, 8, months);
    assert.ok(eps > 4 && eps < 8);
  });
});

describe("aggregate forward P/E is a harmonic mean", () => {
  it("matches a hand-checked two-stock example and is not the arithmetic average", () => {
    // Equal weights, same price $100.
    // A: NTM EPS $10 → P/E 10, earnings yield 0.10
    // B: NTM EPS $5  → P/E 20, earnings yield 0.05
    // Arithmetic average of P/Es = (10 + 20) / 2 = 15
    // Aggregate (harmonic) P/E = 1 / (0.5×0.10 + 0.5×0.05) = 1 / 0.075 = 13.333…
    const holdings: ValuationHolding[] = [
      { symbol: "A", weight: 0.5, ntmEps: 10, price: 100, sector: "Information Technology", analystCount: 20 },
      { symbol: "B", weight: 0.5, ntmEps: 5, price: 100, sector: "Financials", analystCount: 10 },
    ];
    const agg = aggregateForwardPe(holdings);
    assert.equal(typeof agg.pe, "number");
    assert.ok(Math.abs((agg.pe as number) - 13.3333333333) < 1e-9);
    assert.ok(Math.abs(agg.impliedEarningsPerDollar - 0.075) < 1e-12);
    assert.equal(arithmeticAveragePe(holdings), 15);
    assert.notEqual(agg.pe, arithmeticAveragePe(holdings));
    assert.equal(agg.coverage, 1);
    assert.equal(agg.namesCovered, 2);
    assert.equal(agg.medianAnalystCount, 15);
    assert.equal(formatPe(agg.pe), "13.3x");
  });

  it("keeps loss-makers (negative earnings reduce the denominator)", () => {
    const holdings: ValuationHolding[] = [
      { symbol: "PROFIT", weight: 0.8, ntmEps: 10, price: 100, sector: "Financials" },
      { symbol: "LOSS", weight: 0.2, ntmEps: -5, price: 100, sector: "Information Technology" },
    ];
    const agg = aggregateForwardPe(holdings);
    // Σ w E/P = 0.8×0.10 + 0.2×(-0.05) = 0.08 - 0.01 = 0.07; P/E = 1/0.07 ≈ 14.286
    assert.equal(agg.namesCovered, 2);
    assert.ok(Math.abs((agg.pe as number) - 1 / 0.07) < 1e-9);
  });

  it("returns n/m when aggregate earnings are zero or negative", () => {
    const allLoss: ValuationHolding[] = [
      { symbol: "LOSS", weight: 1, ntmEps: -2, price: 40, sector: "Health Care" },
    ];
    assert.equal(aggregateForwardPe(allLoss).pe, NM);
    assert.equal(formatPe(NM), "n/m");
  });

  it("excludes cash, bonds, options and unresolved funds, and ignores negative cash on leveraged books", () => {
    const holdings: ValuationHolding[] = [
      { symbol: "RY.TO", weight: 1.25, ntmEps: 10, price: 100, sector: "Financials", kind: "equity" },
      { symbol: "CASH", weight: -0.25, ntmEps: 0, price: 1, sector: "Cash", kind: "cash" },
      { symbol: "TLT", weight: 0.1, ntmEps: 0, price: 90, sector: "Fixed Income", kind: "bond" },
      { symbol: "OPTIONS", weight: -0.02, sector: "Other", kind: "options" },
      { symbol: "ZEB.TO", weight: 0.05, sector: "Fund", kind: "etf", unresolved: true },
    ];
    const agg = aggregateForwardPe(holdings);
    assert.ok(!isEquityForPe(holdings[1]!));
    assert.equal(agg.equityWeight, 1.25);
    assert.equal(agg.namesCovered, 1);
    assert.equal(agg.pe, 10);
    assert.equal(agg.coverage, 1);
  });

  it("drops names without estimates from coverage but keeps them in the equity denominator", () => {
    const holdings: ValuationHolding[] = [
      { symbol: "A", weight: 0.6, ntmEps: 2, price: 20, sector: "Energy" },
      { symbol: "B", weight: 0.4, sector: "Energy" },
    ];
    const agg = aggregateForwardPe(holdings);
    assert.equal(agg.namesCovered, 1);
    assert.equal(agg.namesEligible, 2);
    assert.ok(Math.abs(agg.coverage - 0.6) < 1e-12);
    assert.equal(agg.pe, 10);
    assert.equal(hasUsableEstimate(holdings[1]!), false);
  });
});

describe("sector P/E", () => {
  it("aggregates with the same harmonic mean inside each cleaned sector", () => {
    const holdings: ValuationHolding[] = [
      { symbol: "A", weight: 0.4, ntmEps: 10, price: 100, sector: "Information Technology" },
      { symbol: "B", weight: 0.1, ntmEps: 5, price: 100, sector: "Information Technology" },
      { symbol: "C", weight: 0.5, ntmEps: 8, price: 80, sector: "Financials" },
    ];
    const rows = sectorForwardPes(holdings);
    assert.deepEqual(
      rows.map((r) => r.sector),
      ["Financials", "Information Technology"],
    );
    const fin = rows[0]!;
    assert.equal(fin.pe, 10); // 80/8
    const tech = rows[1]!;
    // weights 0.4 and 0.1; yields 0.10 and 0.05; PE = 0.5 / (0.04+0.005) = 0.5/0.045 ≈ 11.111
    assert.ok(Math.abs((tech.pe as number) - 0.5 / 0.045) < 1e-9);
  });
});

describe("percentile rank", () => {
  it("returns the share of a name's own history at or below today's value", () => {
    const history = [10, 12, 14, 16, 18];
    assert.equal(percentileRank(14, history), 60);
    assert.equal(percentileRank(18, history), 100);
    assert.equal(percentileRank(9, history), 0);
    assert.equal(percentileRank(14, [14]), null);
    assert.equal(percentileRank(14, []), null);
  });
});
