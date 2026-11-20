import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  holdingsFallbackTickers,
  searchFundTickers,
  searchTickers,
  type TickerRecord,
} from "./ticker-search.ts";

const REC: TickerRecord[] = [
  { raw: ["HHIS", "HHIS.TO"], ticker: "HHIS.TO", name: "Harvest High Income Shares ETF", provider: "Harvest", exchange: "TSX", isFund: true, yahooVerified: true },
  { raw: ["HHIC"], ticker: "HHIC.TO", name: "Harvest Healthcare High Income Shares", provider: "Harvest", exchange: "TSX", isFund: true, yahooVerified: true },
  { raw: ["HMAX"], ticker: "HMAX.TO", name: "Hamilton Canadian Financials YIELD MAXIMIZER ETF", provider: "Hamilton", exchange: "TSX", isFund: true, yahooVerified: true },
  { raw: ["RY"], ticker: "RY.TO", name: "Royal Bank of Canada", provider: "", exchange: "TSX", isFund: false, yahooVerified: true },
  { raw: ["AMZN"], ticker: "AMZN", name: "Amazon.com Inc", provider: "", exchange: "NASDAQ", isFund: false, yahooVerified: true },
];

describe("ticker search", () => {
  it("prefix-matches the bare ticker, raw spellings and name words", () => {
    const hits = searchTickers("HHI", REC);
    assert.deepEqual(hits.map((h) => h.ticker), ["HHIC.TO", "HHIS.TO"]);
    const name = searchTickers("Royal", REC);
    assert.equal(name[0]?.ticker, "RY.TO");
    const raw = searchTickers("hmax", REC);
    assert.equal(raw[0]?.ticker, "HMAX.TO");
  });

  it("ranks exact matches first, then funds, then alphabetically, and caps at 10", () => {
    const many: TickerRecord[] = [
      { raw: [], ticker: "HHI.TO", name: "Exact fund", provider: "X", exchange: "TSX", isFund: true, yahooVerified: false },
      { raw: [], ticker: "HHI", name: "Exact stock", provider: "", exchange: "", isFund: false, yahooVerified: false },
      ...Array.from({ length: 15 }, (_, i) => ({
        raw: [],
        ticker: `HHI${String(i).padStart(2, "0")}.TO`,
        name: `Fund ${i}`,
        provider: "X",
        exchange: "TSX",
        isFund: true,
        yahooVerified: false,
      })),
    ];
    const hits = searchTickers("HHI", many);
    assert.equal(hits.length, 10);
    assert.equal(hits[0]?.ticker, "HHI.TO");
    assert.equal(hits[1]?.ticker, "HHI");
    assert.ok(hits.slice(2).every((h) => h.isFund));
  });

  it("falls back to holdings.json fund keys when tickers.json is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lt-tickers-"));
    const holdings = path.join(dir, "holdings.json");
    writeFileSync(
      holdings,
      JSON.stringify({
        format: "market-desk-lookthru/v1",
        funds: {
          "HHIS.TO": { name: "Harvest High Income Shares ETF", issuer: "Harvest", holdings: [{ symbol: "AMZN", name: "Amazon", weight: 0.1, sector: "Technology" }] },
          "HHIC.TO": { name: "Harvest Healthcare", issuer: "Harvest", holdings: [{ symbol: "JNJ", name: "J&J", weight: 0.1 }] },
        },
      }),
    );
    const records = holdingsFallbackTickers(holdings);
    assert.ok(records.some((r) => r.ticker === "HHIS.TO" && r.provider === "Harvest"));
    const hits = searchFundTickers("HHI", { tickersPath: path.join(dir, "missing-tickers.json"), holdingsPath: holdings });
    assert.deepEqual(hits.map((h) => h.ticker).sort(), ["HHIC.TO", "HHIS.TO"]);
    assert.equal(hits[0]?.provider, "Harvest");
  });
});
