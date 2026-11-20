import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { closePricesDb, upsertEstimates, upsertPeSeries, upsertPrices, upsertRealizedEps } from "./prices-db.ts";
import {
  REAL_SERIES_MIN_DAYS,
  aggregateSeriesOnDates,
  buildProxyPeSeries,
  choosePeHistory,
  percentileAgainstOwnHistory,
  rebuildPeSeries,
} from "./pe-history.ts";

function dbFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "pe-hist-")), "prices.sqlite");
}

describe("proxy P/E history", () => {
  it("divides each day's price by the next-twelve-months realized EPS", () => {
    const rows = buildProxyPeSeries(
      "AAPL",
      [
        { ticker: "AAPL", date: "2023-10-02", close: 170, adjclose: 170 },
        { ticker: "AAPL", date: "2023-10-03", close: 175, adjclose: 175 },
      ],
      [
        { ticker: "AAPL", periodEnd: "2023-12-31", periodType: "quarterly", eps: 2 },
        { ticker: "AAPL", periodEnd: "2024-03-31", periodType: "quarterly", eps: 2 },
        { ticker: "AAPL", periodEnd: "2024-06-30", periodType: "quarterly", eps: 3 },
        { ticker: "AAPL", periodEnd: "2024-09-30", periodType: "quarterly", eps: 3 },
      ],
    );
    // Next 12m EPS = 10; 170/10 = 17, 175/10 = 17.5
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.pe, 17);
    assert.equal(rows[1]?.pe, 17.5);
    assert.equal(rows[0]?.kind, "proxy");
  });

  it("uses the proxy series until 250 nightly forward snapshots exist, then the real series", () => {
    const file = dbFile();
    try {
      upsertPeSeries(
        [
          { ticker: "AAPL", date: "2020-01-02", pe: 20, kind: "proxy" },
          { ticker: "AAPL", date: "2020-01-03", pe: 22, kind: "proxy" },
          { ticker: "AAPL", date: "2026-11-19", pe: 18, kind: "forward" },
        ],
        file,
      );
      const early = choosePeHistory("AAPL", file);
      assert.equal(early.kind, "proxy");
      assert.equal(early.label, "proxy, based on reported EPS");
      assert.equal(early.forwardDays, 1);
      // unique dates required — use a proper day sequence
      const start = Date.parse("2024-01-01T00:00:00Z");
      const unique = Array.from({ length: REAL_SERIES_MIN_DAYS }, (_, i) => {
        const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
        return { ticker: "AAPL", date: d, pe: 15, kind: "forward" as const };
      });
      upsertPeSeries(unique, file);
      const late = choosePeHistory("AAPL", file);
      assert.equal(late.kind, "forward");
      assert.equal(late.label, "nightly consensus snapshots");
      assert.ok(late.forwardDays >= REAL_SERIES_MIN_DAYS);
    } finally {
      closePricesDb();
    }
  });

  it("rebuilds both series from estimates and realized EPS, and ranks a name against its own history", () => {
    const file = dbFile();
    try {
      upsertPrices(
        [
          { ticker: "X", date: "2023-01-03", close: 50, adjclose: 50 },
          { ticker: "X", date: "2023-01-04", close: 60, adjclose: 60 },
        ],
        file,
      );
      upsertRealizedEps([{ ticker: "X", periodEnd: "2023-12-31", periodType: "annual", eps: 5 }], file);
      upsertEstimates(
        [
          {
            ticker: "X",
            asof: "2026-11-20",
            fy0Eps: 5,
            fy1Eps: 5,
            ntmEps: 5,
            forwardEps: 5,
            analystCount: 12,
            sharesOutstanding: null,
            marketCap: null,
            currency: "USD",
            financialCurrency: "USD",
            lastFyEnd: "2025-12-31",
            nextFyEnd: "2026-12-31",
            price: 80,
          },
        ],
        file,
      );
      const counts = rebuildPeSeries("X", file);
      assert.equal(counts.proxy, 2); // 50/5=10, 60/5=12
      assert.equal(counts.forward, 1); // 80/5=16
      const rank = percentileAgainstOwnHistory(12, "X", file);
      assert.equal(rank.kind, "proxy");
      assert.equal(rank.percentile, 100); // 10 and 12, 12 is at the top
    } finally {
      closePricesDb();
    }
  });

  it("builds a sector series from per-stock series with current weights (no cross-sector compare)", () => {
    const dates = ["2020-01-02", "2020-01-03"];
    const series = aggregateSeriesOnDates(
      [
        { ticker: "A", weight: 0.5 },
        { ticker: "B", weight: 0.5 },
      ],
      {
        A: dates.map((d) => ({ ticker: "A", date: d, pe: 10, kind: "proxy" as const })),
        B: dates.map((d) => ({ ticker: "B", date: d, pe: 20, kind: "proxy" as const })),
      },
      dates,
      "proxy",
      "sector:Financials",
    );
    // harmonic 13.333… on both dates
    assert.equal(series.length, 2);
    assert.ok(Math.abs(series[0]!.pe - 13.3333333333) < 1e-9);
    assert.equal(series[0]!.ticker, "sector:Financials");
  });
});
