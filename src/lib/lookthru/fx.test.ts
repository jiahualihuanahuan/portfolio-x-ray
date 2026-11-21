import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeCad, composeEtfCad } from "./compose-safe.ts";
import { convert, formatMoney } from "./format.ts";
import { FX_UNAVAILABLE, FxUnavailableError, needsFx, normalizeUsdCad, parseCachedFx, parseOverride, resolveFx, toCad } from "./fx.ts";
import type { Instrument } from "./types.ts";

describe("toCad / convert", () => {
  it("passes CAD through and converts USD with the given rate", () => {
    assert.equal(toCad(100, "CAD", null), 100);
    assert.equal(toCad(100, "USD", 1.4), 140);
    assert.equal(toCad(100, "usd", 1.4), 140);
    assert.equal(convert(140, "CAD", "USD", 1.4), 100);
    assert.equal(convert(100, "USD", "CAD", 1.4), 140);
  });
  it("throws instead of assuming 1:1 or a constant when the rate is missing", () => {
    assert.throws(() => toCad(100, "USD", null), FxUnavailableError);
    assert.throws(() => toCad(100, "USD", 0), FxUnavailableError);
    assert.throws(() => toCad(100, "USD", Number.NaN), FxUnavailableError);
    assert.throws(() => convert(100, "USD", "CAD", null), FxUnavailableError);
  });
  it("inverts a CAD=X style quote below 1", () => {
    assert.equal(normalizeUsdCad(0.5), 2);
    assert.equal(normalizeUsdCad(1.37), 1.37);
    assert.equal(normalizeUsdCad(-1), null);
  });
  it("needsFx only when something is not CAD", () => {
    assert.equal(needsFx(["CAD", "cad"]), false);
    assert.equal(needsFx(["CAD", "USD"]), true);
  });
});

describe("resolveFx", () => {
  const now = new Date("2026-11-21T14:00:00Z");
  const cached = parseCachedFx(JSON.stringify({ rate: 1.36, asOf: "2026-11-20T21:00:00Z", pair: "USDCAD=X" }));
  it("prefers the live quote", () => {
    const r = resolveFx({ rate: 1.38, pair: "USDCAD=X" }, cached, now);
    assert.equal(r.fx?.rate, 1.38);
    assert.equal(r.fx?.source, "live");
    assert.equal(r.fx?.asOf, now.toISOString());
  });
  it("falls back to the cached copy with its original timestamp", () => {
    const r = resolveFx(null, cached, now);
    assert.equal(r.fx?.rate, 1.36);
    assert.equal(r.fx?.source, "cache");
    assert.equal(r.fx?.asOf, "2026-11-20T21:00:00Z");
  });
  it("returns an explicit error with no live rate and no cache", () => {
    const r = resolveFx({ rate: null, pair: "USDCAD=X" }, null, now);
    assert.equal(r.fx, null);
    assert.equal(r.error, FX_UNAVAILABLE);
  });
  it("manual override wins and is labelled manual", () => {
    const r = resolveFx({ rate: 1.38, pair: "USDCAD=X" }, cached, now, parseOverride("1.3"));
    assert.equal(r.fx?.rate, 1.3);
    assert.equal(r.fx?.source, "manual");
  });
  it("ignores blank or invalid overrides and bad cache files", () => {
    assert.equal(parseOverride(""), null);
    assert.equal(parseOverride("abc"), null);
    assert.equal(parseOverride("0"), null);
    assert.equal(parseCachedFx("not json"), null);
    assert.equal(parseCachedFx(JSON.stringify({ rate: 1.3 })), null);
  });
});

describe("formatMoney", () => {
  it("shows CAD as C$", () => {
    assert.equal(formatMoney(1234.4, "CAD"), "C$1,234");
    assert.equal(formatMoney(12.5, "CAD"), "C$12.50");
    assert.equal(formatMoney(-2500, "CAD"), "−C$2,500");
    assert.equal(formatMoney(12.5, "USD"), "US$12.50");
  });
});

function inst(symbol: string, currency: string, price: number, holdings: Instrument["holdings"] = null): Instrument {
  return {
    symbol,
    displaySymbol: symbol,
    name: symbol,
    kind: holdings ? "etf" : "equity",
    currency,
    price,
    changePct: null,
    holdings,
    sectors: [],
    source: "catalog",
    coverage: 1,
  };
}

describe("composeCad", () => {
  const instruments = {
    AAPL: inst("AAPL", "USD", 100),
    "RY.TO": inst("RY.TO", "CAD", 50),
  };
  it("values USD holdings in CAD at the live rate", () => {
    const r = composeCad(
      [
        { id: "1", ticker: "AAPL", shares: 10 },
        { id: "2", ticker: "RY.TO", shares: 10 },
      ],
      { instruments, aliases: {}, fxUsdCad: 1.4, warnings: [] },
    );
    assert.ok(r.result);
    assert.equal(r.result.currency, "CAD");
    assert.equal(Math.round(r.result.nav), 1400 + 500);
  });
  it("errors (no guessed rate) when a USD holding exists and FX is missing", () => {
    const r = composeCad([{ id: "1", ticker: "AAPL", shares: 10 }], { instruments, aliases: {}, fxUsdCad: null, warnings: [] });
    assert.equal(r.result, null);
    assert.match(r.error ?? "", /USD→CAD rate unavailable/);
  });
  it("CAD-only books work without any FX rate", () => {
    const r = composeCad([{ id: "2", ticker: "RY.TO", shares: 10 }], { instruments, aliases: {}, fxUsdCad: null, warnings: [] });
    assert.equal(r.result?.nav, 500);
  });
  it("composeEtfCad scales a single fund to the requested CAD amount", () => {
    const etf = inst("XUS", "USD", 20, [
      { symbol: "AAPL", name: "Apple", weight: 0.6 },
      { symbol: "RY.TO", name: "RBC", weight: 0.4 },
    ]);
    const r = composeEtfCad("XUS", 10_000, { instruments: { ...instruments, XUS: etf }, aliases: {}, fxUsdCad: 1.4, warnings: [] });
    assert.ok(r.result);
    assert.equal(Math.round(r.result.nav), 10_000);
    assert.equal(Math.round(r.result.leaves.find((l) => l.symbol.includes("AAPL"))!.value), 6_000);
  });
});
