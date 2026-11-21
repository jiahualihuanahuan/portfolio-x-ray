import assert from "node:assert/strict";
import { test } from "node:test";
import { cdrLookup, parseCdrMap } from "./cdr-map.ts";
import {
  decideCurrency,
  exchangeCurrency,
  fxOnOrBefore,
  prepareCad,
  resolveFxForDate,
  suffixCurrency,
  type ListingInfo,
} from "./currency.ts";
import { composeLookthrough } from "./lookthrough.ts";
import { applyAlias, normalizeTicker, parseBrokerCsv, parsePaste } from "./tickers.ts";
import type { Instrument, Position } from "./types.ts";

const keys = { listingKey: normalizeTicker, aliasKey: applyAlias };
const fx = (rate: number, date: string, exact = true) => ({ rate, date, source: "prices-db" as const, exact });

function inst(symbol: string, price: number, currency: string, extra: Partial<Instrument> = {}): Instrument {
  return {
    symbol,
    displaySymbol: symbol,
    name: symbol,
    kind: "equity",
    currency,
    price,
    changePct: null,
    holdings: null,
    sectors: [{ name: "Tech", weight: 1 }],
    source: "yahoo",
    coverage: 1,
    ...extra,
  };
}

function listing(p: Partial<ListingInfo>): ListingInfo {
  return { symbol: null, quoteCurrency: null, priceDate: "2026-11-20", name: null, cadListing: null, cdrUnderlying: null, fx: null, ...p };
}

const total = (positions: Position[], a: Parameters<typeof prepareCad>[1]) => {
  const p = prepareCad(positions, a, keys);
  return { prep: p, res: composeLookthrough(p.positions, p.instruments, p.aliases, null, "CAD", []) };
};

// ── Detection ──────────────────────────────────────────────────────────────
test("suffix detection: .U / -U.TO are USD, .TO is CAD, bare is unknown", () => {
  assert.equal(suffixCurrency("HYLD.U"), "USD");
  assert.equal(suffixCurrency("HYLD-U.TO"), "USD");
  assert.equal(suffixCurrency("BTC-USD"), "USD");
  assert.equal(suffixCurrency("HYLD.TO"), "CAD");
  assert.equal(suffixCurrency("AAPL"), null);
});

test("CDR / trust-unit patterns are CAD: KO.UN, REI.UN, AAPL.NE", () => {
  for (const t of ["KO.UN", "REI.UN", "REI-UN.TO", "AAPL.NE"]) assert.equal(suffixCurrency(t), "CAD", t);
});

test("US exchange / MIC detection", () => {
  assert.equal(exchangeCurrency("NASDAQ"), "USD");
  assert.equal(exchangeCurrency("", "XNYS"), "USD");
  assert.equal(exchangeCurrency("TSX"), "CAD");
});

test("broker CSV currency column and trailing USD in a paste", () => {
  const rows = parseBrokerCsv("Symbol,Quantity,Currency\nAAPL,10,USD\nXIU,5,CAD\n");
  assert.deepEqual(rows.map((r) => [r.ticker, r.currency]), [["AAPL", "USD"], ["XIU", "CAD"]]);
  const pasted = parsePaste("AAPL 10 USD\nHYLD.TO 7070");
  assert.equal(pasted[0]!.currency, "USD");
  assert.equal(pasted[1]!.currency, undefined);
});

test("bare ticker with only a USD listing is USD", () => {
  const d = decideCurrency("IBIT", undefined, listing({ symbol: "IBIT", quoteCurrency: "USD", fx: fx(1.4, "2026-11-20") }));
  assert.equal(d.currency, "USD");
  assert.equal(d.flag, null);
});

// ── Conversion by date ─────────────────────────────────────────────────────
const dbRows = [
  { date: "2026-11-18", close: 1.39 },
  { date: "2026-11-20", close: 1.41 },
];

test("rate for the price date: exact match", () => {
  assert.deepEqual(fxOnOrBefore(dbRows, "2026-11-20"), { rate: 1.41, date: "2026-11-20", exact: true });
});

test("rate for the price date: most recent on or before (weekend), flagged not exact", () => {
  assert.deepEqual(fxOnOrBefore(dbRows, "2026-11-19"), { rate: 1.39, date: "2026-11-18", exact: false });
  assert.equal(fxOnOrBefore(dbRows, "2026-11-01"), null);
});

test("priority: manual override → prices.sqlite → json cache", () => {
  const cached = { rate: 1.3, date: "2026-11-10" };
  assert.equal(resolveFxForDate("2026-11-20", { override: 1.5, dbRows, cached })!.source, "manual");
  assert.equal(resolveFxForDate("2026-11-20", { override: null, dbRows, cached })!.rate, 1.41);
  assert.equal(resolveFxForDate("2026-11-15", { override: null, dbRows, cached })!.source, "cache");
  assert.equal(resolveFxForDate("2026-11-05", { override: null, dbRows, cached }), null);
});

test("USD holding converts at its price-date rate", () => {
  const a = {
    instruments: { IBIT: inst("IBIT", 50, "USD") },
    aliases: { IBIT: "IBIT" },
    listings: { IBIT: listing({ symbol: "IBIT", quoteCurrency: "USD", price: 50, fx: fx(1.4, "2026-11-20") }) },
  };
  const { prep, res } = total([{ id: "1", ticker: "IBIT", shares: 10 }], a);
  assert.equal(res.nav, 700);
  assert.equal(prep.byPosition["1"]!.currency, "USD");
  assert.equal(prep.byPosition["1"]!.nativePrice, 50);
});

test("USD units (HYLD.U) price from the USD listing, not the CAD fund", () => {
  const a = {
    instruments: { "HYLD.TO": inst("HYLD.TO", 12, "CAD", { kind: "etf" }) },
    aliases: { "HYLD.TO": "HYLD.TO" },
    listings: { "HYLD.U": listing({ symbol: "HYLD-U.TO", quoteCurrency: "USD", price: 9, fx: fx(1.4, "2026-11-20") }) },
  };
  const { res } = total([{ id: "u", ticker: "HYLD.U", shares: 100 }, { id: "c", ticker: "HYLD.TO", shares: 100 }], a);
  assert.ok(Math.abs(res.positions.find((p) => p.id === "u")!.value - 1260) < 1e-9);
  assert.equal(res.positions.find((p) => p.id === "c")!.value, 1200);
});

// ── Flags ──────────────────────────────────────────────────────────────────
test("missing rate → needs confirmation, excluded from totals", () => {
  const a = {
    instruments: { IBIT: inst("IBIT", 50, "USD"), "XIU.TO": inst("XIU.TO", 40, "CAD") },
    aliases: { IBIT: "IBIT", "XIU.TO": "XIU.TO" },
    listings: {
      IBIT: listing({ symbol: "IBIT", quoteCurrency: "USD", price: 50, fx: null }),
      "XIU.TO": listing({ symbol: "XIU.TO", quoteCurrency: "CAD", price: 40 }),
    },
  };
  const { prep, res } = total([{ id: "1", ticker: "IBIT", shares: 10 }, { id: "2", ticker: "XIU.TO", shares: 10 }], a);
  assert.equal(prep.excluded.length, 1);
  assert.equal(prep.excluded[0]!.flag.kind, "no-rate");
  assert.equal(res.nav, 400);
});

test("ambiguous (USD and CAD listings, no suffix or currency) → flagged; confirming resolves it", () => {
  const info = listing({ symbol: "AAPL", quoteCurrency: "USD", price: 200, cadListing: "AAPL.NE", fx: fx(1.4, "2026-11-20") });
  const a = {
    instruments: { AAPL: inst("AAPL", 200, "USD"), "AAPL.NE": inst("AAPL.NE", 30, "CAD") },
    aliases: { AAPL: "AAPL", "AAPL.NE": "AAPL.NE" },
    listings: { AAPL: info },
  };
  assert.equal(decideCurrency("AAPL", undefined, info).flag?.kind, "ambiguous");
  assert.equal(total([{ id: "1", ticker: "AAPL", shares: 1 }], a).prep.excluded.length, 1);
  assert.equal(total([{ id: "1", ticker: "AAPL", shares: 1, currency: "USD" }], a).res.nav, 280);
  assert.equal(total([{ id: "1", ticker: "AAPL", shares: 1, currency: "CAD" }], a).res.nav, 30);
});

test("USD-looking ticker with no match → flagged unknown-usd", () => {
  const d = decideCurrency("ZZZQ.U", undefined, listing({}));
  assert.equal(d.flag?.kind, "unknown-usd");
});

// ── CAD and CDRs ───────────────────────────────────────────────────────────
test("CAD rows are unchanged", () => {
  const a = {
    instruments: { "XIU.TO": inst("XIU.TO", 40, "CAD") },
    aliases: { "XIU.TO": "XIU.TO" },
    listings: { "XIU.TO": listing({ symbol: "XIU.TO", quoteCurrency: "CAD", price: 40 }) },
  };
  const positions = [{ id: "1", ticker: "XIU.TO", shares: 10 }];
  const before = composeLookthrough(positions, a.instruments, a.aliases, 1.4, "CAD", []);
  const { prep, res } = total(positions, a);
  assert.equal(res.nav, before.nav);
  assert.deepEqual(prep.instruments, a.instruments);
  assert.equal(prep.excluded.length, 0);
});

test("KO.UN is a CAD CDR: no conversion, never flagged, underlying KO", () => {
  const map = parseCdrMap({ _comment: "x", "KO.UN": { listing: "KO.NE", underlying: "KO" } });
  assert.deepEqual(cdrLookup(map, "KO-UN.TO"), { listing: "KO.NE", underlying: "KO" });
  // Even if the quote reports USD, a CDR stays CAD at its listed value.
  const info = listing({ symbol: "KO.NE", quoteCurrency: "USD", price: 25, cdrUnderlying: "KO", fx: null });
  const d = decideCurrency("KO.UN", undefined, info);
  assert.deepEqual([d.currency, d.flag, d.cdrUnderlying], ["CAD", null, "KO"]);
  const a = { instruments: { "KO.NE": inst("KO.NE", 25, "USD") }, aliases: { "KO.UN": "KO.NE" }, listings: { "KO.UN": info } };
  const { prep, res } = total([{ id: "1", ticker: "KO.UN", shares: 4 }], a);
  assert.equal(res.nav, 100);
  assert.equal(prep.excluded.length, 0);
});

test("REI.UN is CAD (trust unit) with no underlying mapping", () => {
  const map = parseCdrMap({ "KO.UN": { listing: "KO.NE", underlying: "KO" } });
  assert.equal(cdrLookup(map, "REI.UN"), null);
  const d = decideCurrency("REI.UN", undefined, listing({ symbol: "REI-UN.TO", quoteCurrency: "CAD", name: "RioCan Real Estate Investment Trust" }));
  assert.deepEqual([d.currency, d.flag, d.cdrUnderlying], ["CAD", null, null]);
});

test("AAPL.NE is CAD, never converted", () => {
  const info = listing({ symbol: "AAPL.NE", quoteCurrency: "CAD", price: 30, name: "Apple Inc. CDR (CAD Hedged)", cdrUnderlying: "AAPL" });
  const d = decideCurrency("AAPL.NE", undefined, info);
  assert.deepEqual([d.currency, d.flag], ["CAD", null]);
  const a = { instruments: { "AAPL.NE": inst("AAPL.NE", 30, "CAD") }, aliases: { "AAPL.NE": "AAPL.NE" }, listings: { "AAPL.NE": info } };
  assert.equal(total([{ id: "1", ticker: "AAPL.NE", shares: 2 }], a).res.nav, 60);
});

test("BIP-U (alias of BIP.UN.TO trust units) stays CAD", () => {
  const d = decideCurrency("BIP-U", undefined, listing({ symbol: "BIP-UN.TO", quoteCurrency: "CAD" }), applyAlias("BIP-U"));
  assert.equal(d.currency, "CAD");
});
