import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignSeries,
  alignedReturn,
  flattenHoldings,
  matchBenchmark,
  measureExposure,
  nasdaqConstituents,
  PREFETCH_BENCHMARK_TICKERS,
  type HoldingLike,
} from "./benchmarks.ts";
import type { HistoryPoint } from "./fund-history.ts";

function h(symbol: string, weight: number, extra: Partial<HoldingLike> = {}): HoldingLike {
  return { symbol, weight, name: extra.name, sector: extra.sector, country: extra.country };
}

function pts(dates: string[], values: number[]): HistoryPoint[] {
  return dates.map((date, i) => ({
    date,
    t: Date.parse(`${date}T00:00:00Z`) / 1000,
    close: values[i]!,
    priceIndex: values[i]!,
    totalIndex: values[i]!,
  }));
}

describe("benchmark matching", () => {
  it("maps known funds from the manual override table", () => {
    assert.equal(matchBenchmark("HMAX.TO", []).id, "canada-banks");
    assert.equal(matchBenchmark("hmax", []).basis, "manual");
    assert.equal(matchBenchmark("ZWB.TO", []).id, "canada-banks");
    assert.equal(matchBenchmark("BANK", []).id, "canada-banks");
    assert.equal(matchBenchmark("QMAX.TO", []).id, "nasdaq100");
    assert.equal(matchBenchmark("ZWQ.TO", []).id, "nasdaq100");
    assert.equal(matchBenchmark("USCL.TO", []).id, "sp500");
    assert.equal(matchBenchmark("HYLD.TO", []).id, "sp500");
    assert.equal(matchBenchmark("UTES.TO", []).id, "canada-utilities");
    assert.equal(matchBenchmark("HUTL.TO", []).id, "canada-utilities");
    assert.equal(matchBenchmark("HMAX.TO", []).reason, "manual mapping");
  });

  it("maps a Canadian fund with a 60%+ sector to that sector's index", () => {
    const holdings = [
      h("RY.TO", 0.25, { country: "Canada", sector: "Financials" }),
      h("TD.TO", 0.25, { country: "Canada", sector: "Financials" }),
      h("BNS.TO", 0.2, { country: "Canada", sector: "Financials" }),
      h("CNQ.TO", 0.15, { country: "Canada", sector: "Energy" }),
      h("CASH", 0.05, { sector: "Cash" }),
    ];
    const m = matchBenchmark("X.TO", holdings);
    assert.equal(m.id, "canada-banks");
    assert.equal(m.basis, "canada-sector");
    assert.match(m.reason, /Financials/i);
    assert.ok(m.canadaWeight >= 0.6);
    assert.ok(m.topSector && m.topSector.weight >= 0.6);
  });

  it("maps diversified Canada (>= 60%) to XIU", () => {
    const holdings = [
      h("RY.TO", 0.25, { country: "Canada", sector: "Financials" }),
      h("CNQ.TO", 0.25, { country: "Canada", sector: "Energy" }),
      h("SHOP.TO", 0.25, { country: "Canada", sector: "Technology" }),
      h("FTS.TO", 0.2, { country: "Canada", sector: "Utilities" }),
    ];
    const m = matchBenchmark("X.TO", holdings);
    assert.equal(m.id, "canada");
    assert.equal(m.basis, "canada-broad");
    assert.equal(m.def.legs[0]?.ticker, "XIU.TO");
  });

  it("maps mostly-US funds with 50%+ Nasdaq-100 overlap to the Nasdaq pair", () => {
    const holdings = [
      h("AAPL", 0.2, { country: "United States", sector: "Technology" }),
      h("MSFT", 0.2, { country: "United States", sector: "Technology" }),
      h("NVDA", 0.2, { country: "United States", sector: "Technology" }),
      h("AMZN", 0.15, { country: "United States", sector: "Consumer Discretionary" }),
      h("JNJ", 0.15, { country: "United States", sector: "Health Care" }),
    ];
    const m = matchBenchmark("Q.TO", holdings);
    assert.equal(m.id, "nasdaq100");
    assert.equal(m.basis, "us-nasdaq");
    assert.ok(m.nasdaqOverlap >= 0.5);
    assert.deepEqual(m.def.legs.map((l) => l.ticker), ["ZNQ.TO", "XQQ.TO"]);
  });

  it("maps mostly-US funds without Nasdaq overlap to the S&P 500 pair", () => {
    const holdings = [
      h("JPM", 0.25, { country: "United States", sector: "Financials" }),
      h("XOM", 0.25, { country: "United States", sector: "Energy" }),
      h("JNJ", 0.2, { country: "United States", sector: "Health Care" }),
      h("PG", 0.2, { country: "United States", sector: "Consumer Staples" }),
    ];
    const m = matchBenchmark("U.TO", holdings);
    assert.equal(m.id, "sp500");
    assert.equal(m.basis, "us-sp");
    assert.match(m.reason, /US large-cap exposure/);
    assert.deepEqual(m.def.legs.map((l) => l.ticker), ["VFV.TO", "VSP.TO"]);
  });

  it("maps mixed exposure to the S&P pair as the closest broad benchmark", () => {
    const holdings = [
      h("RY.TO", 0.3, { country: "Canada", sector: "Financials" }),
      h("AAPL", 0.3, { country: "United States", sector: "Technology" }),
      h("NESN.SW", 0.3, { country: "Switzerland", sector: "Consumer Staples" }),
    ];
    const m = matchBenchmark("M.TO", holdings);
    assert.equal(m.id, "sp500");
    assert.equal(m.basis, "mixed");
    assert.equal(m.reason, "closest broad benchmark");
  });

  it("maps single-stock covered-call funds: US tech to Nasdaq, otherwise S&P", () => {
    const ynvd = [h("NVDA", 1.2, { country: "United States", sector: "Information Technology" }), h("CASH", -0.2, { sector: "Cash" })];
    const tech = matchBenchmark("YNVD.TO", ynvd, { name: "NVIDIA High Income Shares ETF" });
    assert.equal(tech.id, "nasdaq100");
    assert.equal(tech.basis, "single-stock");

    const bank = [h("JPM", 1.1, { country: "United States", sector: "Financials" })];
    const sp = matchBenchmark("XJPM.TO", bank, { name: "JPMorgan High Income Shares ETF" });
    assert.equal(sp.id, "sp500");
    assert.equal(sp.basis, "single-stock");
  });

  it("flattens HHIS-style wrappers and maps the package to Nasdaq-100", () => {
    const file: Record<string, HoldingLike[]> = {
      "NVHE.TO": [h("NVDA", 1.2, { country: "United States", sector: "Information Technology" }), h("CASH", -0.2, { sector: "Cash" })],
      "MSHE.TO": [h("MSFT", 1.2, { country: "United States", sector: "Information Technology" }), h("CASH", -0.2, { sector: "Cash" })],
      "APLE.TO": [h("AAPL", 1.2, { country: "United States", sector: "Information Technology" }), h("CASH", -0.2, { sector: "Cash" })],
    };
    const hhis = [
      h("NVHE.TO", 0.35, { name: "Harvest NVIDIA Enhanced High Income Shares ETF", sector: "Fund" }),
      h("MSHE.TO", 0.35, { name: "Harvest Microsoft Enhanced High Income Shares ETF", sector: "Fund" }),
      h("APLE.TO", 0.3, { name: "Harvest Apple Enhanced High Income Shares ETF", sector: "Fund" }),
    ];
    const flat = flattenHoldings(hhis, (s) => file[s] ?? null);
    assert.ok(flat.some((x) => x.symbol === "NVDA"));
    const m = matchBenchmark("HHIS.TO", hhis, { lookup: (s) => file[s] ?? null });
    assert.equal(m.id, "nasdaq100");
    assert.equal(m.basis, "single-stock");
    assert.ok(m.nasdaqOverlap >= 0.5);
  });

  it("uses XQQ/ZNQ holdings for Nasdaq constituents when present", () => {
    const lookup = (s: string) =>
      s === "XQQ.TO" ? [h("AAPL", 0.1), h("MSFT", 0.1), h("ZZZZ", 0.05), h("CASH", 0.01, { sector: "Cash" })] : null;
    const set = nasdaqConstituents(lookup);
    assert.ok(set.has("AAPL") && set.has("MSFT") && set.has("ZZZZ"));
    assert.equal(set.has("CASH"), false);
    const exp = measureExposure([h("AAPL", 0.6, { country: "United States" }), h("JPM", 0.4, { country: "United States" })], set);
    assert.ok(Math.abs(exp.nasdaq - 0.6) < 1e-9);
  });
});

describe("series alignment", () => {
  it("starts at the later first date, keeps common dates, and rebases to 0%", () => {
    const fund = pts(["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"], [1, 1.1, 1.2, 1.3]);
    const bench = pts(["2023-12-29", "2024-01-02", "2024-01-03", "2024-01-05", "2024-01-08"], [2, 2, 2.2, 2.4, 2.5]);
    const aligned = alignSeries({ fund, bench });
    assert.deepEqual(aligned.map((p) => p.date), ["2024-01-02", "2024-01-03", "2024-01-05"]);
    assert.equal(aligned[0]!.values.fund, 1);
    assert.equal(aligned[0]!.values.bench, 1);
    assert.ok(Math.abs(aligned[2]!.values.fund - 1.3) < 1e-9);
    assert.ok(Math.abs(aligned[2]!.values.bench - 1.2) < 1e-9);
    const ret = alignedReturn(aligned, "fund")!;
    assert.ok(Math.abs(ret.total - 0.3) < 1e-9);
  });

  it("always prefetches the Canadian-listed benchmark tickers", () => {
    for (const t of ["VFV.TO", "VSP.TO", "ZNQ.TO", "XQQ.TO", "XIU.TO", "ZEB.TO", "ZUT.TO", "XEG.TO", "XIT.TO"]) {
      assert.ok(PREFETCH_BENCHMARK_TICKERS.includes(t), t);
    }
    assert.equal(PREFETCH_BENCHMARK_TICKERS.includes("XQQU.TO"), false);
  });
});
