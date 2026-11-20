import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHistoryFromRows,
  historySummary,
  parseYahooChart,
  sliceHistory,
  yahooChartUrl,
} from "./fund-history.ts";

function chart(opts: {
  symbol?: string;
  timestamps: number[];
  close: Array<number | null>;
  adjclose?: Array<number | null>;
  dividends?: Record<string, { amount: number; date: number }>;
  splits?: Record<string, { date: number; numerator: number; denominator: number }>;
}) {
  return {
    chart: {
      result: [
        {
          meta: { currency: "CAD", symbol: opts.symbol ?? "HMAX.TO" },
          timestamp: opts.timestamps,
          events: { dividends: opts.dividends, splits: opts.splits },
          indicators: {
            quote: [{ close: opts.close }],
            adjclose: opts.adjclose ? [{ adjclose: opts.adjclose }] : undefined,
          },
        },
      ],
      error: null,
    },
  };
}

const DAY = 86_400;
const t0 = Date.parse("2023-01-03T00:00:00Z") / 1000;
const days = (n: number) => Array.from({ length: n }, (_, i) => t0 + i * DAY);

describe("fund history", () => {
  it("builds a max-range Yahoo URL and an incremental period URL", () => {
    assert.equal(
      yahooChartUrl("HMAX.TO"),
      "https://query1.finance.yahoo.com/v8/finance/chart/HMAX.TO?interval=1d&events=div%2Csplit&range=max",
    );
    const url = yahooChartUrl("HMAX.TO", { period1: 1_700_000_000, period2: 1_700_086_400 });
    assert.match(url, /period1=1700000000/);
    assert.match(url, /period2=1700086400/);
    assert.doesNotMatch(url, /range=max/);
  });

  it("uses adjclose for total return when present, with a split-adjusted price line", () => {
    const parsed = parseYahooChart(
      chart({
        timestamps: days(3),
        close: [10, 10, 11],
        adjclose: [8, 9, 11],
      }),
      "HMAX.TO",
    );
    assert.ok(parsed);
    const hist = buildHistoryFromRows("HMAX", "HMAX.TO", parsed!);
    assert.equal(hist.status, "ok");
    if (hist.status !== "ok") return;
    assert.equal(hist.totalReturnSource, "adjclose");
    assert.equal(hist.dividendsIncluded, true);
    assert.equal(hist.points[0]!.totalIndex, 1);
    assert.ok(Math.abs(hist.points[2]!.totalIndex - 11 / 8) < 1e-9);
    assert.ok(Math.abs(hist.points[2]!.priceIndex - 1.1) < 1e-9);
  });

  it("reinvests dividends at the close when adjclose is missing", () => {
    // Day 0: 100, day 1: 100 + $5 div reinvested at close, day 2: 110
    const ts = days(3);
    const parsed = parseYahooChart(
      chart({
        timestamps: ts,
        close: [100, 100, 110],
        dividends: { [String(ts[1])]: { amount: 5, date: ts[1]! } },
      }),
      "HMAX.TO",
    );
    const hist = buildHistoryFromRows("HMAX", "HMAX.TO", parsed!);
    assert.equal(hist.status, "ok");
    if (hist.status !== "ok") return;
    assert.equal(hist.totalReturnSource, "dividends");
    assert.equal(hist.dividendCount, 1);
    // After $5 reinvested at 100, shares = 1.05; day 2 value = 1.05 * 110 = 115.5 → 15.5%
    assert.ok(Math.abs(hist.points[2]!.totalIndex - 1.155) < 1e-9);
    assert.ok(Math.abs(hist.points[2]!.priceIndex - 1.1) < 1e-9);
    const sum = historySummary(hist.points)!;
    assert.ok(Math.abs(sum.totalReturn - 0.155) < 1e-9);
    assert.ok(Math.abs(sum.priceReturn - 0.1) < 1e-9);
  });

  it("labels the series as price-only when dividends and adjclose are missing", () => {
    const hist = buildHistoryFromRows("X", "X.TO", {
      prices: [
        { date: "2024-01-02", close: 10, adjclose: null },
        { date: "2024-01-03", close: 12, adjclose: null },
      ],
      dividends: [],
      splits: [],
    });
    assert.equal(hist.status, "ok");
    if (hist.status !== "ok") return;
    assert.equal(hist.totalReturnSource, "price_only");
    assert.equal(hist.dividendsIncluded, false);
    assert.equal(hist.points[1]!.totalIndex, hist.points[1]!.priceIndex);
  });

  it("applies a split so the price-only line stays continuous", () => {
    const hist = buildHistoryFromRows("X", "X.TO", {
      prices: [
        { date: "2024-01-02", close: 100, adjclose: null },
        { date: "2024-01-03", close: 50, adjclose: null },
      ],
      dividends: [],
      splits: [{ date: "2024-01-03", numerator: 2, denominator: 1 }],
    });
    assert.equal(hist.status, "ok");
    if (hist.status !== "ok") return;
    assert.ok(Math.abs(hist.points[1]!.priceIndex - 1) < 1e-9);
  });

  it("slices a range and rebases both lines, and annualizes the window", () => {
    const prices = Array.from({ length: 800 }, (_, i) => {
      const d = new Date(Date.UTC(2023, 0, 3) + i * 86_400_000);
      const date = d.toISOString().slice(0, 10);
      return { date, close: 100 + i * 0.1, adjclose: 80 + i * 0.15 };
    });
    const hist = buildHistoryFromRows("HMAX", "HMAX.TO", { prices, dividends: [], splits: [] });
    assert.equal(hist.status, "ok");
    if (hist.status !== "ok") return;
    const oneY = sliceHistory(hist.points, "1Y");
    assert.ok(oneY.length > 300 && oneY.length < 400);
    assert.equal(oneY[0]!.totalIndex, 1);
    const sum = historySummary(oneY)!;
    assert.ok(sum.years > 0.9 && sum.years < 1.1);
    assert.ok(sum.annualized != null);
    assert.equal(sliceHistory(hist.points, "MAX").length, hist.points.length);
  });

  it("returns empty when there is not enough price data", () => {
    const empty = parseYahooChart({ chart: { result: [{ timestamp: [], indicators: { quote: [{ close: [] }] } }] } }, "Z.TO");
    assert.equal(empty, null);
    const hist = buildHistoryFromRows("Z", "Z.TO", { prices: [{ date: "2024-01-02", close: 1, adjclose: 1 }], dividends: [], splits: [] });
    assert.equal(hist.status, "empty");
  });
});
