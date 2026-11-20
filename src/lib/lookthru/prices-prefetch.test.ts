import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closePricesDb, getPrices, getTickerMeta, hasCachedPrices, isTickerStale, upsertTickerMeta } from "./prices-db.ts";
import {
  ensureTickerHistory,
  fetchAndStoreTicker,
  incrementalPeriod,
  msUntilNextTorontoHour,
  planPrefetch,
  runPrefetch,
} from "./prices-prefetch.ts";
import { parseYahooChart, yahooChartUrl } from "./fund-history.ts";

const DAY = 86_400;
const t0 = Date.parse("2024-01-02T00:00:00Z") / 1000;

function yahooBody(symbol: string, closes: number[], adj?: number[], divs?: Array<{ i: number; amount: number }>) {
  const timestamps = closes.map((_, i) => t0 + i * DAY);
  const dividends: Record<string, { amount: number; date: number }> = {};
  for (const d of divs ?? []) {
    const ts = timestamps[d.i]!;
    dividends[String(ts)] = { amount: d.amount, date: ts };
  }
  return {
    chart: {
      result: [
        {
          meta: { currency: "CAD", symbol },
          timestamp: timestamps,
          events: { dividends },
          indicators: {
            quote: [{ close: closes }],
            adjclose: adj ? [{ adjclose: adj }] : undefined,
          },
        },
      ],
      error: null,
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("prices db and prefetch", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lt-prices-"));
  const dbPath = path.join(dir, "prices.sqlite");
  const holdings = path.join(dir, "holdings.json");

  before(() => {
    writeFileSync(
      holdings,
      JSON.stringify({
        format: "market-desk-lookthru/v1",
        funds: {
          "HHIS.TO": {
            name: "Harvest High Income Shares ETF",
            issuer: "Harvest",
            holdings: [
              { symbol: "AMZN", name: "Amazon", weight: 0.2 },
              { symbol: "CASH", name: "Cash", weight: 0.01, sector: "Cash" },
            ],
          },
          "HMAX.TO": {
            name: "Hamilton Canadian Financials YIELD MAXIMIZER ETF",
            issuer: "Hamilton",
            holdings: [{ symbol: "RY.TO", name: "Royal Bank", weight: 0.12 }],
          },
        },
      }),
    );
  });

  after(() => closePricesDb());

  it("treats a missing or 21-hour-old row as stale, and a 19-hour-old row as fresh", () => {
    const now = Date.parse("2026-11-20T12:00:00-05:00");
    assert.equal(isTickerStale(null, now), true);
    assert.equal(
      isTickerStale({ ticker: "X", lastFetched: now - 21 * 3600_000, firstDate: "a", lastDate: "b", status: "ok", error: null }, now),
      true,
    );
    assert.equal(
      isTickerStale({ ticker: "X", lastFetched: now - 19 * 3600_000, firstDate: "a", lastDate: "b", status: "ok", error: null }, now),
      false,
    );
  });

  it("stores a mocked Yahoo payload and reads history only from SQLite", async () => {
    const body = yahooBody("HMAX.TO", [10, 11, 12], [9, 10.5, 12]);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(body);
    };
    const meta = await fetchAndStoreTicker("HMAX.TO", { fetch: fetchImpl, now: 1_000, dbPath, delayMs: 0 });
    assert.equal(meta.status, "ok");
    assert.equal(getPrices("HMAX.TO", dbPath).length, 3);
    assert.match(calls[0]!, /range=max/);

    const hist = await ensureTickerHistory("hmax", { fetch: fetchImpl, dbPath });
    assert.equal(hist.status, "ok");
    if (hist.status !== "ok") return;
    assert.equal(hist.totalReturnSource, "adjclose");
    assert.equal(hist.dividendsIncluded, true);
    assert.equal(calls.length, 1); // second read is cache-only
  });

  it("uses an incremental Yahoo range after the first full fetch", async () => {
    const existing = getTickerMeta("HMAX.TO", dbPath);
    assert.ok(existing?.lastDate);
    const { period1, period2 } = incrementalPeriod(existing!.lastDate!, 2_000_000_000_000);
    assert.ok(period2 > period1);
    const calls: string[] = [];
    await fetchAndStoreTicker("HMAX.TO", {
      dbPath,
      now: 2_000_000_000_000,
      fetch: async (url) => {
        calls.push(String(url));
        return jsonResponse(yahooBody("HMAX.TO", [12, 13], [12, 13]));
      },
    });
    assert.match(calls[0]!, /period1=/);
    assert.doesNotMatch(calls[0]!, /range=max/);
    assert.ok(getPrices("HMAX.TO", dbPath).length >= 3);
  });

  it("plans funds before holding tickers and skips fresh rows", () => {
    const planDb = path.join(dir, "plan.sqlite");
    const now = Date.now();
    upsertTickerMeta(
      { ticker: "HHIS.TO", lastFetched: now, firstDate: "2024-01-02", lastDate: "2024-01-04", status: "ok", error: null },
      planDb,
    );
    const plan = planPrefetch({
      dbPath: planDb,
      holdingsPath: holdings,
      tickersPath: path.join(dir, "no-tickers.json"),
      now,
    });
    assert.ok(plan.skip.includes("HHIS.TO"));
    assert.ok(plan.refresh.includes("HMAX.TO"));
    assert.ok(plan.refresh.includes("AMZN") || plan.refresh.includes("RY.TO"));
    const fundIdx = plan.refresh.indexOf("HMAX.TO");
    const amzn = plan.refresh.indexOf("AMZN");
    const ry = plan.refresh.indexOf("RY.TO");
    const holdingIdx = amzn === -1 ? ry : amzn;
    assert.ok(fundIdx >= 0 && holdingIdx >= 0 && fundIdx < holdingIdx);
  });

  it("runs a serial prefetch with mocked fetches and counts ok vs failed", async () => {
    const otherDb = path.join(dir, "prefetch.sqlite");
    const calls: string[] = [];
    const order: string[] = [];
    const result = await runPrefetch({
      dbPath: otherDb,
      holdingsPath: holdings,
      tickersPath: path.join(dir, "no-tickers.json"),
      delayMs: 0,
      now: Date.now(),
      fetch: async (url) => {
        calls.push(String(url));
        const u = new URL(String(url));
        const symbol = decodeURIComponent(u.pathname.split("/").pop() ?? "");
        order.push(symbol);
        if (symbol === "NOPE.TO") return jsonResponse({ chart: { result: [], error: { description: "Not found" } } }, 404);
        if (symbol === "AMZN") return new Response("nope", { status: 404 });
        return jsonResponse(yahooBody(symbol, [10, 11], [10, 11]));
      },
      onTicker: () => {},
    });
    assert.ok(result.ok >= 2);
    assert.ok(result.failed >= 1);
    assert.ok(result.elapsedMs >= 0);
    const firstFunds = order.slice(0, 2);
    assert.ok(firstFunds.includes("HHIS.TO") && firstFunds.includes("HMAX.TO"));
  });

  it("retries after a 429 and then succeeds", async () => {
    let n = 0;
    const meta = await fetchAndStoreTicker("RY.TO", {
      dbPath,
      delayMs: 0,
      sleep: async () => {},
      now: Date.now(),
      fetch: async () => {
        n += 1;
        if (n === 1) return new Response("slow down", { status: 429 });
        return jsonResponse(yahooBody("RY.TO", [100, 101], [100, 101]));
      },
    });
    assert.equal(meta.status, "ok");
    assert.equal(n, 2);
    assert.equal(hasCachedPrices("RY.TO", dbPath), true);
  });

  it("fetches once on demand when the history cache is empty", async () => {
    const fresh = path.join(dir, "ondemand.sqlite");
    let n = 0;
    const hist = await ensureTickerHistory("HHIS.TO", {
      dbPath: fresh,
      fetch: async () => {
        n += 1;
        return jsonResponse(yahooBody("HHIS.TO", [20, 21, 22], [18, 20, 22], [{ i: 1, amount: 0.2 }]));
      },
    });
    assert.equal(hist.status, "ok");
    if (hist.status !== "ok") return;
    assert.equal(n, 1);
    assert.equal(hist.symbol, "HHIS.TO");
    const again = await ensureTickerHistory("hhis", {
      dbPath: fresh,
      fetch: async () => {
        n += 1;
        throw new Error("should not fetch again");
      },
    });
    assert.equal(again.status, "ok");
    assert.equal(n, 1);
  });

  it("computes a positive wait until the next 6 PM America/Toronto", () => {
    const wait = msUntilNextTorontoHour(18, new Date("2026-11-20T08:00:00-05:00"));
    assert.ok(wait > 0 && wait <= 24 * 3600_000);
    const parsed = parseYahooChart(yahooBody("X.TO", [1, 2]), "X.TO");
    assert.ok(parsed);
    assert.match(yahooChartUrl("X.TO"), /X\.TO/);
  });
});
