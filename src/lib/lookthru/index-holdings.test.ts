import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexSpecFor, parseIndexHoldingsCsv, parseNasdaqListJson } from "./index-holdings.ts";

const IVV = `iShares Core S&P 500 ETF
Fund Holdings as of 11/18/2026

Ticker,Name,Sector,Asset Class,Market Value,Weight (%)
AAPL,Apple Inc,Information Technology,Equity,"1,000",7.12
MSFT,Microsoft Corp,Information Technology,Equity,"900",6.40
NVDA,NVIDIA Corp,Information Technology,Equity,"800",6.10
AMZN,Amazon.com Inc,Consumer Discretionary,Equity,"500",3.80
META,Meta Platforms,Communication Services,Equity,"400",2.90
GOOGL,Alphabet Inc Class A,Communication Services,Equity,"350",2.40
BRK.B,Berkshire Hathaway,Financials,Equity,"300",2.10
JPM,JPMorgan Chase,Financials,Equity,"250",1.80
LLY,Eli Lilly,Health Care,Equity,"200",1.50
XOM,Exxon Mobil,Energy,Equity,"180",1.20
CASH,USD CASH,-,Cash Collateral,50,0.40
`;

describe("index holdings CSV", () => {
  it("parses an iShares-style IVV file into decimal weights and skips cash", () => {
    const parsed = parseIndexHoldingsCsv(IVV);
    assert.ok(parsed);
    assert.equal(parsed!.asOf, "2026-11-18");
    assert.equal(parsed!.holdings.length, 10);
    const aapl = parsed!.holdings.find((h) => h.symbol === "AAPL");
    assert.ok(Math.abs((aapl?.weight ?? 0) - 0.0712) < 1e-12);
    assert.equal(aapl?.sector, "Information Technology");
    assert.ok(!parsed!.holdings.some((h) => h.symbol === "CASH"));
  });

  it("maps VFV, ZNQ and XIU to the S&P 500, Nasdaq-100 and TSX 60 proxies", () => {
    assert.equal(indexSpecFor("VFV.TO")?.proxyFor, "S&P 500");
    assert.equal(indexSpecFor("ZNQ")?.proxyFor, "Nasdaq-100");
    assert.equal(indexSpecFor("XIU.TO")?.proxyFor, "S&P/TSX 60");
    assert.equal(indexSpecFor("HHIS.TO"), null);
  });
});

const IVV_MARKET_WEIGHT = `iShares Core S&P 500 ETF
Fund Holdings as of,"Nov 19, 2026"

Ticker,Name,Type,Sector,Asset Class,Market Value,Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date,Market Weight,Notional Weight
"AAPL","APPLE","EQUITY","Information Technology","Equity","1,000","1,000","1","1","United States","NASDAQ","USD","1.00","USD","-","7.12","7.12"
"MSFT","MICROSOFT","EQUITY","Information Technology","Equity","900","900","1","1","United States","NASDAQ","USD","1.00","USD","-","6.40","6.40"
`;

describe("index holdings extra formats", () => {
  it("reads the current iShares latest-holdings Market Weight column", () => {
    const parsed = parseIndexHoldingsCsv(IVV_MARKET_WEIGHT);
    assert.ok(parsed);
    assert.equal(parsed!.asOf, "2026-11-19");
    const aapl = parsed!.holdings.find((h) => h.symbol === "AAPL");
    assert.ok(Math.abs((aapl?.weight ?? 0) - 0.0712) < 1e-12);
  });

  it("builds cap-weighted Nasdaq-100 weights from the public list API", () => {
    const rows = [
      { symbol: "AAPL", companyName: "Apple", marketCap: "200", sector: "Information Technology" },
      { symbol: "MSFT", companyName: "Microsoft", marketCap: "100", sector: "Information Technology" },
    ];
    for (let i = 0; i < 80; i++) {
      rows.push({ symbol: `T${i}`, companyName: `Name ${i}`, marketCap: "1", sector: "Information Technology" });
    }
    const parsed = parseNasdaqListJson(JSON.stringify({ data: { date: "Nov 20, 2026", data: { rows } } }));
    assert.ok(parsed);
    const aapl = parsed!.holdings.find((h) => h.symbol === "AAPL");
    const total = 200 + 100 + 80;
    assert.ok(Math.abs((aapl?.weight ?? 0) - 200 / total) < 1e-12);
  });
});
