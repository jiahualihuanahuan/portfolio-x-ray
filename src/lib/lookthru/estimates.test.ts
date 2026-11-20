import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyFxQuote,
  convertEps,
  forwardRealizedEps,
  fxPairSymbol,
  isoFromYahooDate,
  parseFundamentalsTimeseries,
  parseQuoteSummaryEstimates,
  trailingEpsAt,
} from "./estimates.ts";
import { ntmEps } from "./valuation.ts";

const SAMPLE = {
  quoteSummary: {
    result: [
      {
        earningsTrend: {
          trend: [
            { period: "0q", earningsEstimate: { avg: { raw: 1 }, numberOfAnalysts: { raw: 20 } } },
            { period: "0y", earningsEstimate: { avg: { raw: 4 }, numberOfAnalysts: { raw: 28 } } },
            { period: "+1y", earningsEstimate: { avg: { raw: 8 }, numberOfAnalysts: { raw: 24 } } },
          ],
        },
        defaultKeyStatistics: {
          forwardEps: { raw: 5.5 },
          sharesOutstanding: { raw: 1_000_000 },
          lastFiscalYearEnd: { raw: Date.parse("2026-01-31T00:00:00Z") / 1000 },
          nextFiscalYearEnd: { raw: Date.parse("2027-01-31T00:00:00Z") / 1000 },
        },
        financialData: { financialCurrency: "USD" },
        price: { currency: "CAD", regularMarketPrice: { raw: 140 }, marketCap: { raw: 2e11 } },
        summaryDetail: { currency: "CAD" },
      },
    ],
  },
};

describe("parseQuoteSummaryEstimates", () => {
  it("reads FY0/FY1 averages, currencies and a blended NTM EPS", () => {
    const row = parseQuoteSummaryEstimates(SAMPLE, "SHOP.TO", "2026-10-31");
    assert.ok(row);
    assert.equal(row!.fy0Eps, 4);
    assert.equal(row!.fy1Eps, 8);
    assert.equal(row!.forwardEps, 5.5);
    assert.equal(row!.analystCount, 28);
    assert.equal(row!.currency, "CAD");
    assert.equal(row!.financialCurrency, "USD");
    assert.equal(row!.lastFyEnd, "2026-01-31");
    assert.equal(row!.nextFyEnd, "2027-01-31");
    assert.equal(row!.price, 140);
    // ~3 months left in a Jan fiscal year on 31 Oct → NTM ≈ 4×0.25 + 8×0.75 = 7
    assert.ok(row!.ntmEps != null);
    assert.ok(Math.abs(row!.ntmEps! - ntmEps(4, 8, 3)) < 0.2);
  });

  it("parses Yahoo epoch seconds into ISO dates", () => {
    assert.equal(isoFromYahooDate({ raw: Date.parse("2025-12-31T00:00:00Z") / 1000 }), "2025-12-31");
  });
});

describe("FX conversion", () => {
  it("converts a USD EPS into CAD with USDCAD=X and not the inverse pair", () => {
    assert.equal(convertEps(2, "USD", "CAD", 1.4), 2.8);
    assert.equal(convertEps(2, "USD", "USD", 1.4), 2);
    const pairs = fxPairSymbol("USD", "CAD");
    assert.ok(pairs.some((p) => p.pair === "USDCAD=X" && !p.invert));
    assert.equal(applyFxQuote(1.4, false), 1.4);
    assert.ok(Math.abs((applyFxQuote(1.4, true) ?? 0) - 1 / 1.4) < 1e-12);
  });
});

describe("realized EPS windows", () => {
  const rows = [
    { ticker: "AAPL", periodEnd: "2022-09-30", periodType: "annual" as const, eps: 6.11 },
    { ticker: "AAPL", periodEnd: "2023-09-30", periodType: "annual" as const, eps: 6.13 },
    { ticker: "AAPL", periodEnd: "2023-12-31", periodType: "quarterly" as const, eps: 2.18 },
    { ticker: "AAPL", periodEnd: "2024-03-31", periodType: "quarterly" as const, eps: 1.53 },
    { ticker: "AAPL", periodEnd: "2024-06-30", periodType: "quarterly" as const, eps: 1.4 },
    { ticker: "AAPL", periodEnd: "2024-09-30", periodType: "quarterly" as const, eps: 1.64 },
  ];

  it("sums the next four quarters when they exist, otherwise uses trailing annual", () => {
    const next = forwardRealizedEps(rows, "2023-10-01");
    assert.equal(next?.basis, "next-12m");
    assert.ok(Math.abs((next?.eps ?? 0) - (2.18 + 1.53 + 1.4 + 1.64)) < 1e-12);
    const trailing = forwardRealizedEps(rows, "2024-12-01");
    assert.equal(trailing?.basis, "trailing");
    assert.ok(Math.abs((trailing?.eps ?? 0) - (2.18 + 1.53 + 1.4 + 1.64)) < 1e-12);
    assert.equal(trailingEpsAt(rows, "2023-06-01"), 6.11);
  });

  it("parses a fundamentals-timeseries payload", () => {
    const parsed = parseFundamentalsTimeseries(
      {
        timeseries: {
          result: [
            {
              meta: { type: ["annualDilutedEPS"] },
              annualDilutedEPS: [{ asOfDate: "2023-09-30", reportedValue: { raw: 6.13 } }],
            },
            {
              quarterlyDilutedEPS: [{ asOfDate: "2024-03-31", reportedValue: { raw: 1.53 } }],
            },
          ],
        },
      },
      "AAPL",
    );
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.periodType, "annual");
    assert.equal(parsed[1]?.eps, 1.53);
  });
});
