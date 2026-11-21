import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appConfig } from "./app-config.ts";
import {
  AskInputSchema,
  askOllama,
  buildAskMessages,
  buildSystemPrompt,
  contextFromLookthrough,
  NOT_CONFIGURED,
  ollamaConfig,
  stripThink,
  ThinkStripper,
  type EtfContext,
} from "./ask.ts";
import { composeEtfCad } from "./compose-safe.ts";
import type { Instrument } from "./types.ts";

const ctx: EtfContext = {
  ticker: "BMAX.TO",
  name: "Brompton Enhanced Multi-Asset Income ETF",
  provider: "Brompton",
  source: "issuer",
  asOf: "2026-09-30",
  coverage: 0.148,
  equityExposure: 1.12,
  cashWeight: -0.2,
  priceCad: 11.25,
  holdings: [
    { symbol: "MSFT", name: "Microsoft", weight: 0.032, sector: "Information Technology" },
    { symbol: "RY", name: "Royal Bank of Canada", weight: 0.021, sector: "Financials" },
  ],
  sectors: [{ name: "Financials", weight: 0.3 }],
  childFunds: [{ symbol: "BFIN", name: "Brompton North American Financials", weight: 0.15 }],
  warnings: ["BMAX: the issuer names 14.8% of holdings; the other 85.2% shows as OTHER (partial coverage)."],
  totalHoldings: 120,
};

describe("buildSystemPrompt", () => {
  const p = buildSystemPrompt(ctx);
  it("grounds the model in the ETF data", () => {
    for (const s of [
      "Ticker: BMAX.TO",
      "Name: Brompton Enhanced Multi-Asset Income ETF",
      "Provider: Brompton",
      "Holdings as of: 2026-09-30",
      "MSFT Microsoft: 3.20% [Information Technology]",
      "Financials: 30.0%",
      "BFIN Brompton North American Financials: 15.0%",
      "Price: C$11.25",
      "leverage of about 20.0% of NAV",
      "partial coverage",
      "(2 of 120",
    ]) {
      assert.ok(p.includes(s), `prompt should include ${s}`);
    }
  });
  it("tells the model to admit when it doesn't know", () => {
    assert.match(p, /don't know/);
    assert.match(p, /Never invent/);
  });
  it("says when there are no child funds", () => {
    assert.match(buildSystemPrompt({ ...ctx, childFunds: [] }), /none detected/);
  });
  it("orders messages system → history → question", () => {
    const m = buildAskMessages({ question: "what does BMAX do?", context: ctx, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
    assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "user"]);
    assert.equal(m.at(-1)!.content, "what does BMAX do?");
  });
  it("validates input size", () => {
    assert.equal(AskInputSchema.safeParse({ question: "", context: ctx }).success, false);
    assert.equal(AskInputSchema.safeParse({ question: "x", context: ctx }).success, true);
  });
});

describe("contextFromLookthrough", () => {
  it("captures holdings, leverage and child funds from the engine output", () => {
    const mk = (symbol: string, kind: Instrument["kind"], holdings: Instrument["holdings"] = null, price: number | null = 10): Instrument => ({
      symbol, displaySymbol: symbol, name: symbol, kind, currency: "CAD", price, changePct: null, holdings, sectors: [], source: "catalog", coverage: 1,
    });
    const instruments: Record<string, Instrument> = {
      "TOP.TO": mk("TOP.TO", "etf", [
        { symbol: "KID.TO", name: "Kid fund", weight: 0.6 },
        { symbol: "RY.TO", name: "RBC", weight: 0.6, sector: "Financials" },
        { symbol: "CASH", name: "Leverage", weight: -0.2 },
      ]),
      "KID.TO": mk("KID.TO", "etf", [{ symbol: "TD.TO", name: "TD", weight: 1, sector: "Financials" }]),
      "RY.TO": mk("RY.TO", "equity"),
      "TD.TO": mk("TD.TO", "equity"),
    };
    const r = composeEtfCad("TOP.TO", 1000, { instruments, aliases: {}, fxUsdCad: null, warnings: [] });
    assert.ok(r.result);
    const c = contextFromLookthrough(r.result, { ticker: "TOP.TO", provider: "Test" });
    assert.equal(c.childFunds[0]?.symbol, "KID.TO");
    assert.ok(c.holdings.some((h) => h.symbol.startsWith("RY")));
    assert.ok((c.cashWeight ?? 0) < 0);
    assert.equal(c.provider, "Test");
    assert.ok(EtfContextOk(c));
  });
});

function EtfContextOk(c: EtfContext) {
  return AskInputSchema.safeParse({ question: "q", context: c }).success;
}

describe("ThinkStripper", () => {
  it("removes think blocks, even split across chunks", () => {
    const s = new ThinkStripper();
    const out = ["<thi", "nk>reasoning ", "here</th", "ink>BMAX holds", " other <b>funds</b>."].map((c) => s.push(c)).join("") + s.flush();
    assert.equal(out, "BMAX holds other <b>funds</b>.");
  });
  it("drops an unterminated think block and keeps plain text", () => {
    assert.equal(stripThink("<think>never closed"), "");
    assert.equal(stripThink("plain answer"), "plain answer");
    assert.equal(stripThink("<think>a</think>\n\nAnswer"), "Answer");
  });
});

describe("askOllama error paths", () => {
  const input = { question: "what does BMAX do?", context: ctx };
  it("reports not configured when OLLAMA_URL is unset", async () => {
    const cfg = ollamaConfig({});
    assert.equal(cfg.url, null);
    const r = await askOllama(input, cfg, async () => {
      throw new Error("should not be called");
    });
    assert.deepEqual(r, NOT_CONFIGURED);
  });
  it("reports unreachable hosts without throwing", async () => {
    const cfg = ollamaConfig({ OLLAMA_URL: "http://ollama.invalid:11434/" });
    assert.equal(cfg.url, "http://ollama.invalid:11434");
    const r = await askOllama(input, cfg, async () => {
      throw new TypeError("fetch failed");
    });
    assert.ok("error" in r);
    assert.equal(r.status, 502);
    assert.match(r.error, /Could not reach Ollama at http:\/\/ollama.invalid:11434/);
  });
  it("explains a missing model", async () => {
    const cfg = ollamaConfig({ OLLAMA_URL: "http://x:1", OLLAMA_MODEL: "qwen3.5:9b" });
    const r = await askOllama(input, cfg, async () => new Response(JSON.stringify({ error: "model 'qwen3.5:9b' not found" }), { status: 404 }));
    assert.ok("error" in r);
    assert.match(r.error, /ollama pull qwen3.5:9b/);
  });
  it("reports timeouts", async () => {
    const cfg = ollamaConfig({ OLLAMA_URL: "http://x:1", OLLAMA_TIMEOUT_MS: "5000" });
    const r = await askOllama(input, cfg, async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    assert.ok("error" in r);
    assert.equal(r.status, 504);
  });
  it("streams answer text with think blocks stripped and sends the grounded prompt", async () => {
    let sent: { model: string; stream: boolean; messages: { role: string; content: string }[] } | null = null;
    const ndjson = [
      { message: { content: "<think>hmm" } },
      { message: { content: "</think>BMAX is a " } },
      { message: { content: "fund of Brompton funds." } },
      { done: true },
    ].map((o) => JSON.stringify(o)).join("\n");
    const cfg = ollamaConfig({ OLLAMA_URL: "http://x:1" });
    const r = await askOllama(input, cfg, async (_url, init) => {
      sent = JSON.parse(String(init.body));
      return new Response(ndjson, { status: 200 });
    });
    assert.ok("stream" in r);
    const text = await new Response(r.stream).text();
    assert.equal(text, "BMAX is a fund of Brompton funds.");
    assert.equal(sent!.model, "qwen3.5:9b");
    assert.equal(sent!.stream, true);
    assert.match(sent!.messages[0]!.content, /Ticker: BMAX.TO/);
  });
});

describe("appConfig", () => {
  it("reads REBALANCE_THRESHOLD_PCT", () => {
    assert.equal(appConfig({ REBALANCE_THRESHOLD_PCT: "15" }).rebalanceThreshold, 0.15);
    assert.equal(appConfig({}).rebalanceThreshold, 0.1);
    assert.equal(appConfig({ REBALANCE_THRESHOLD_PCT: "x" }).rebalanceThreshold, 0.1);
  });
});
