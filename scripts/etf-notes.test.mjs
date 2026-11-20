import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { runEtfNotes } from "./etf-notes.mjs";
import {
  BENCHMARKS,
  DEFAULTS,
  alignedReturn,
  alignRange,
  buildFundPack,
  buildTotalReturnPoints,
  callOllama,
  collectSearch,
  envConfig,
  formatNotesMarkdown,
  interpretPreflight,
  listFunds,
  loadHoldingsJson,
  loadNotesJson,
  loadPromptTemplate,
  maxDrawdown,
  mergeSearchResults,
  parseArgs,
  parseSearchResults,
  performanceFromCache,
  preflightSearch,
  promptVarsFromPack,
  renderPrompts,
  renderTemplate,
  searchQueries,
  stripHtml,
  stripThink,
  trailingYield,
  matchBenchmark,
  flattenHoldings,
} from "./etf-notes-lib.mjs";

const temps = [];
function tmp(prefix = "etf-notes-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))) });
    });
  });
}

function addDays(iso, n) {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function seedPrices(path, series) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_meta (
      ticker TEXT PRIMARY KEY,
      last_date TEXT,
      first_date TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS prices (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL,
      adjclose REAL,
      volume INTEGER,
      PRIMARY KEY (ticker, date)
    );
    CREATE TABLE IF NOT EXISTS dividends (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE TABLE IF NOT EXISTS splits (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      numerator REAL NOT NULL,
      denominator REAL NOT NULL,
      PRIMARY KEY (ticker, date)
    );
  `);
  const insP = db.prepare("INSERT INTO prices (ticker, date, close, adjclose) VALUES (?, ?, ?, ?)");
  const insD = db.prepare("INSERT INTO dividends (ticker, date, amount) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (const [ticker, rows] of Object.entries(series)) {
    for (const r of rows.prices || []) insP.run(ticker, r.date, r.close, r.adjclose ?? r.close);
    for (const r of rows.dividends || []) insD.run(ticker, r.date, r.amount);
  }
  db.exec("COMMIT");
  db.close();
}

function risingSeries(ticker, start, days, startPx, daily, divEvery = 0, divAmt = 0) {
  const prices = [];
  const dividends = [];
  let px = startPx;
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    px = startPx * (1 + daily) ** i;
    prices.push({ date, close: px, adjclose: px });
    if (divEvery && i > 0 && i % divEvery === 0) dividends.push({ date, amount: divAmt });
  }
  return { [ticker]: { prices, dividends } };
}

function fixtureHoldings(dir) {
  const path = join(dir, "holdings.json");
  const json = {
    format: "market-desk-lookthru/v1",
    funds: {
      "HHIS.TO": {
        name: "Harvest High Income Shares ETF",
        issuer: "Harvest",
        asOf: "2026-11-19",
        source: "https://harvestportfolios.com/etf/hhis/",
        holdings: [
          { symbol: "NVDA", name: "NVIDIA Corp", weight: 0.25, sector: "Technology", country: "United States" },
          { symbol: "AAPL", name: "Apple Inc", weight: 0.2, sector: "Technology", country: "United States" },
          { symbol: "MSFT", name: "Microsoft", weight: 0.15, sector: "Technology", country: "United States" },
          { symbol: "AMZN", name: "Amazon", weight: 0.1, sector: "Consumer Discretionary", country: "United States" },
          { symbol: "META", name: "Meta", weight: 0.08, sector: "Communication Services", country: "United States" },
          { symbol: "GOOGL", name: "Alphabet", weight: 0.07, sector: "Communication Services", country: "United States" },
          { symbol: "TSLA", name: "Tesla", weight: 0.05, sector: "Consumer Discretionary", country: "United States" },
          { symbol: "AVGO", name: "Broadcom", weight: 0.04, sector: "Technology", country: "United States" },
          { symbol: "CASH", name: "Cash", weight: 0.04, sector: "Cash" },
          { symbol: "OPTIONS", name: "Options", weight: 0.02, sector: "Options" },
        ],
      },
      "HMAX.TO": {
        name: "Hamilton Canadian Bank Mean Reversion Index ETF",
        issuer: "Hamilton",
        asOf: "2026-11-19",
        source: "https://hamiltonetfs.com/etf/hmax/",
        holdings: [
          { symbol: "RY.TO", name: "Royal Bank", weight: 0.24, sector: "Financials", country: "Canada" },
          { symbol: "TD.TO", name: "TD", weight: 0.2, sector: "Financials", country: "Canada" },
          { symbol: "BNS.TO", name: "Scotiabank", weight: 0.18, sector: "Financials", country: "Canada" },
          { symbol: "BMO.TO", name: "BMO", weight: 0.16, sector: "Financials", country: "Canada" },
          { symbol: "CM.TO", name: "CIBC", weight: 0.14, sector: "Financials", country: "Canada" },
          { symbol: "NA.TO", name: "National Bank", weight: 0.08, sector: "Financials", country: "Canada" },
        ],
      },
    },
  };
  writeFileSync(path, JSON.stringify(json));
  return path;
}

function fixtureCfg(dir, extra = {}) {
  const holdingsFile = fixtureHoldings(dir);
  const pricesDb = join(dir, "prices.sqlite");
  const start = "2023-01-01";
  seedPrices(pricesDb, {
    ...risingSeries("HHIS.TO", start, 800, 10, 0.0003, 30, 0.05)["HHIS.TO"] && {
      "HHIS.TO": risingSeries("HHIS.TO", start, 800, 10, 0.0003, 30, 0.05)["HHIS.TO"],
    },
    ...risingSeries("HMAX.TO", start, 800, 15, 0.0004, 30, 0.04),
    ...risingSeries("ZNQ.TO", start, 800, 40, 0.0005),
    ...risingSeries("XQQ.TO", start, 800, 35, 0.00045),
    ...risingSeries("ZEB.TO", start, 800, 25, 0.00055),
  });
  return {
    holdingsFile,
    tickersFile: join(dir, "tickers.json"),
    pricesDb,
    notesDir: dir,
    notesMd: join(dir, "etf-notes.md"),
    notesJson: join(dir, "etf-notes.json"),
    ollamaUrl: extra.ollamaUrl || "http://127.0.0.1:9",
    ollamaModel: "qwen3.5:9b",
    searchUrl: extra.searchUrl || "http://127.0.0.1:9",
    searchEngine: "searxng",
    fetchPages: Boolean(extra.fetchPages),
    searchDelayMs: 0,
  };
}

test("parseArgs accepts force, limit, only, provider, and print-prompt", () => {
  assert.deepEqual(parseArgs(["--force", "--limit", "3", "--only", "HHIS.TO", "--provider", "Harvest"]), {
    force: true,
    limit: 3,
    only: ["HHIS.TO"],
    provider: "Harvest",
    printPrompt: null,
    help: false,
  });
  const multi = parseArgs(["--only", "HHIS", "--only", "HMAX.TO"]);
  assert.deepEqual(multi.only, ["HHIS", "HMAX.TO"]);
  assert.throws(() => parseArgs(["--surprise"]), /Unexpected argument/);
});

test("envConfig uses the homelab LAN defaults", () => {
  const cfg = envConfig({});
  assert.equal(cfg.ollamaUrl, "http://192.168.86.35:11434");
  assert.equal(cfg.ollamaModel, "qwen3.5:9b");
  assert.equal(cfg.searchUrl, "http://192.168.86.35:8099");
  assert.equal(cfg.searchEngine, "searxng");
  assert.equal(cfg.holdingsFile, "/data/lookthru/holdings.json");
  assert.equal(cfg.pricesDb, "/data/lookthru/prices.sqlite");
  assert.equal(cfg.notesMd, "/data/lookthru/etf-notes.md");
  assert.equal(DEFAULTS.searchEngine, "searxng");
});

test("searchQueries are the three documented patterns", () => {
  assert.deepEqual(searchQueries("HHIS.TO", "Harvest High Income Shares ETF", "Harvest"), [
    "HHIS.TO Harvest High Income Shares ETF Harvest",
    "HHIS ETF news",
    "HHIS ETF reddit OR review OR forum",
  ]);
});

test("flattenHoldings multiplies nested weights and matchBenchmark follows the TS rules", () => {
  const funds = new Map([
    [
      "WRAP.TO",
      {
        holdings: [
          { symbol: "INNER.TO", name: "Inner", weight: 0.5, sector: "Fund" },
          { symbol: "RY.TO", name: "Royal Bank", weight: 0.5, sector: "Financials", country: "Canada" },
        ],
      },
    ],
    [
      "INNER.TO",
      {
        holdings: [{ symbol: "TD.TO", name: "TD", weight: 1, sector: "Financials", country: "Canada" }],
      },
    ],
  ]);
  const lookup = (s) => funds.get(s)?.holdings ?? (s === "INNER.TO" ? funds.get("INNER.TO").holdings : null);
  const leaves = flattenHoldings(funds.get("WRAP.TO").holdings, lookup);
  const td = leaves.find((h) => h.symbol === "TD.TO");
  assert.equal(td.weight, 0.5);

  const hhis = matchBenchmark("HHIS.TO", [
    { symbol: "NVDA", weight: 0.8, sector: "Technology", country: "United States" },
    { symbol: "CASH", weight: 0.2, sector: "Cash" },
  ], { name: "Harvest High Income Shares ETF", lookup: () => null });
  assert.equal(hhis.id, "nasdaq100");
  assert.equal(hhis.basis, "single-stock");
  assert.equal(hhis.def.legs[0].ticker, "ZNQ.TO");
  assert.equal(hhis.def.legs[1].ticker, "XQQ.TO");

  const hmax = matchBenchmark("HMAX.TO", [
    { symbol: "RY.TO", weight: 1, sector: "Financials", country: "Canada" },
  ], { lookup: () => null });
  assert.equal(hmax.id, "canada-banks");
  assert.equal(hmax.basis, "manual");
  assert.equal(hmax.def.legs[0].ticker, "ZEB.TO");
});

test("total return, max drawdown and trailing yield come from the cache", () => {
  const dir = tmp();
  const dbPath = join(dir, "p.sqlite");
  // 10 -> 12 over 365 days, plus a dip to 8, and $1.20 of dividends in the last year on last close 12 => 10% yield.
  const prices = [];
  for (let i = 0; i <= 400; i++) {
    const date = addDays("2025-01-01", i);
    let close = 10 + (i / 400) * 2;
    if (i === 200) close = 8;
    prices.push({ date, close, adjclose: close });
  }
  seedPrices(dbPath, {
    "DEMO.TO": {
      prices,
      dividends: [
        { date: "2025-06-01", amount: 0.6 },
        { date: "2025-12-01", amount: 0.6 },
      ],
    },
  });
  const db = new DatabaseSync(dbPath);
  const perf = performanceFromCache(db, "DEMO.TO");
  assert.ok(perf.ranges.MAX);
  assert.ok(perf.ranges["1Y"]);
  const pts = buildTotalReturnPoints(prices, [
    { date: "2025-06-01", amount: 0.6 },
    { date: "2025-12-01", amount: 0.6 },
  ]).points;
  const dd = maxDrawdown(pts);
  assert.ok(dd < -0.1, `expected a meaningful drawdown, got ${dd}`);
  const yld = trailingYield(prices, [
    { date: "2025-06-01", amount: 0.6 },
    { date: "2025-12-01", amount: 0.6 },
  ], prices.at(-1).date);
  assert.ok(Math.abs(yld - 1.2 / prices.at(-1).close) < 1e-9);
  db.close();
});

test("alignRange rebases the fund and benchmark on common dates", () => {
  const fund = [
    { date: "2025-01-01", t: 1, close: 1, priceIndex: 1, totalIndex: 1 },
    { date: "2025-06-01", t: 2, close: 1, priceIndex: 1.1, totalIndex: 1.1 },
    { date: "2026-01-01", t: 3, close: 1, priceIndex: 1.2, totalIndex: 1.2 },
  ];
  const bench = [
    { date: "2025-06-01", t: 2, close: 1, priceIndex: 1, totalIndex: 1 },
    { date: "2026-01-01", t: 3, close: 1, priceIndex: 1.5, totalIndex: 1.5 },
  ];
  const aligned = alignRange({ fund, "ZNQ.TO": bench }, "MAX");
  assert.equal(aligned[0].values.fund, 1);
  assert.equal(aligned[0].values["ZNQ.TO"], 1);
  const fundRet = alignedReturn(aligned, "fund");
  const benchRet = alignedReturn(aligned, "ZNQ.TO");
  assert.ok(Math.abs(fundRet.total - (1.2 / 1.1 - 1)) < 1e-9);
  assert.ok(Math.abs(benchRet.total - 0.5) < 1e-9);
});

test("interpretPreflight distinguishes JSON-disabled, the wrong app, and success", () => {
  const forbidden = interpretPreflight(403, "text/html", "<html>Forbidden</html>");
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.reason, "json-disabled");
  assert.match(forbidden.message, /settings\.yml/);
  assert.match(forbidden.message, /formats/);

  const html = interpretPreflight(200, "text/html", "<!doctype html><html><head><title>SearXNG</title></head></html>");
  assert.equal(html.reason, "json-disabled");
  assert.match(html.message, /settings\.yml/);

  const wrong = interpretPreflight(200, "text/html", "<!doctype html><html><title>Market Desk</title></html>");
  assert.equal(wrong.reason, "wrong-app");
  assert.match(wrong.message, /8099/);

  const ok = interpretPreflight(200, "application/json", JSON.stringify({ query: "test", results: [] }));
  assert.equal(ok.ok, true);
});

test("preflightSearch warns and continues when the port is another app", async () => {
  const svc = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><head><title>Market Desk</title></head><body>Lookthru</body></html>");
  });
  try {
    const result = await preflightSearch({ searchUrl: svc.url });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "wrong-app");
  } finally {
    await svc.close();
  }
});

test("parseSearchResults and mergeSearchResults keep title, url, domain, snippet and dedupe", () => {
  const a = parseSearchResults({
    results: [
      { title: "One", url: "https://www.example.com/a", content: "alpha" },
      { title: "Two", url: "https://news.example.com/b", content: "beta" },
    ],
  });
  assert.equal(a[0].domain, "example.com");
  assert.equal(a[0].snippet, "alpha");
  const merged = mergeSearchResults([
    a,
    parseSearchResults({ results: [{ title: "Dup", url: "https://example.com/a", content: "again" }, { title: "Three", url: "https://reddit.com/r/etfs", content: "opinion" }] }),
  ], 5);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((r) => r.url), [
    "https://www.example.com/a",
    "https://news.example.com/b",
    "https://reddit.com/r/etfs",
  ]);
});

test("stripThink removes think blocks and stripHtml caps length", () => {
  assert.equal(stripThink("<think>secret chain</think>\nHello there."), "Hello there.");
  const long = stripHtml(`<html><script>x</script><p>${"word ".repeat(800)}</p></html>`, 100);
  assert.ok(long.length <= 101);
  assert.ok(!long.includes("<"));
});

test("prompt templates keep placeholders and render from a fund pack", () => {
  const system = loadPromptTemplate("etf-note.system.md");
  const user = loadPromptTemplate("etf-note.user.md");
  assert.match(system, /Recommendation: Recommend\|Neutral\|Avoid/);
  assert.match(system, /4 to 6 sentences/);
  for (const key of [
    "ticker", "name", "provider", "asOf", "holdings", "sectors", "countries",
    "returns", "benchmark", "benchmarkGap", "sources", "providerPage",
  ]) {
    assert.match(user, new RegExp(`\\{\\{${key}\\}\\}`));
  }
  const rendered = renderTemplate(user, {
    ticker: "HHIS.TO",
    displayTicker: "HHIS",
    name: "Harvest High Income Shares ETF",
    provider: "Harvest",
    asOf: "2026-11-19",
    holdings: "NVDA 25.0%",
    sectors: "Information Technology 70.0%",
    countries: "United States 100.0%",
    returns: "1Y: +2.9%",
    benchmark: "Nasdaq-100 — ZNQ.TO",
    benchmarkGap: "1Y: fund +2.9% vs ZNQ.TO +10.0% (gap -7.1 pts)",
    sources: "- Example (example.com)",
    providerPage: "Not fetched.",
  });
  assert.match(rendered, /Fund: HHIS\.TO/);
  assert.doesNotMatch(rendered, /\{\{/);
});

test("formatNotesMarkdown groups by provider and lists source URLs", () => {
  const md = formatNotesMarkdown(
    [
      {
        ticker: "HHIS.TO",
        displayTicker: "HHIS",
        name: "Harvest High Income Shares ETF",
        provider: "Harvest",
        text: "A short note.\n\nRecommendation: Neutral — limited history.",
        sources: [{ url: "https://harvestportfolios.com/etf/hhis/" }],
      },
      {
        ticker: "HMAX.TO",
        displayTicker: "HMAX",
        name: "Hamilton banks ETF",
        provider: "Hamilton",
        text: "Another note.\n\nRecommendation: Avoid — lagging banks.",
        sources: [{ url: "https://hamiltonetfs.com/etf/hmax/" }],
      },
    ],
    "2026-11-20T13:00:00.000Z",
  );
  const harvestAt = md.indexOf("## Harvest");
  const hamiltonAt = md.indexOf("## Hamilton");
  assert.ok(hamiltonAt >= 0 && harvestAt > hamiltonAt, "providers should be alphabetical");
  assert.match(md, /https:\/\/harvestportfolios.com\/etf\/hhis\//);
  assert.match(md, /Recommendation: Neutral/);
});

function mockPair(opts = {}) {
  const queries = [];
  const chats = [];
  const mockNote =
    opts.note ||
    "Harvest High Income Shares ETF is a Harvest covered-call fund focused on US large-cap tech names such as NVIDIA, Apple and Microsoft. " +
    "Look-through holdings are almost entirely United States information technology. " +
    "Over the past year the fund lagged its Nasdaq-100 benchmark (ZNQ.TO). " +
    "Provider materials describe an options-overlay income strategy, while some forum comments (opinion) question the distribution sustainability.\n" +
    "Recommendation: Neutral — useful income exposure but the one-year gap versus ZNQ.TO is a reason to stay selective.";

  async function start() {
    const search = await listen((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/search") {
        res.writeHead(404);
        res.end("no");
        return;
      }
      const q = url.searchParams.get("q") || "";
      queries.push({ q, format: url.searchParams.get("format") });
      if (opts.searchMode === "forbidden") {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end("<html>Forbidden</html>");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      const results =
        q === "test"
          ? []
          : [
              { title: `${q} official`, url: "https://harvestportfolios.com/etf/hhis/", content: "Provider page for the fund." },
              { title: `${q} news`, url: `https://news.example.com/${encodeURIComponent(q)}`, content: "A news blurb." },
              { title: `${q} reddit`, url: `https://www.reddit.com/r/ETFs/${encodeURIComponent(q)}`, content: "A forum opinion." },
              { title: `${q} dup`, url: "https://harvestportfolios.com/etf/hhis/", content: "duplicate" },
            ];
      // Unique-ish third/fourth URLs per query so dedupe still leaves 3–5 overall
      res.end(JSON.stringify({ query: q, results }));
    });
    const ollama = await listen((req, res) => {
      if (req.method !== "POST" || req.url !== "/api/chat") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        chats.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: { role: "assistant", content: `<think>scratch</think>\n${mockNote}` } }));
      });
    });
    return {
      search,
      ollama,
      queries,
      chats,
      mockNote,
      async close() {
        await search.close();
        await ollama.close();
      },
    };
  }
  return { start };
}

test("collectSearch runs three serial SearXNG queries and keeps 3–5 deduped results", async () => {
  const pair = mockPair();
  const mocks = await pair.start();
  try {
    const cfg = { searchUrl: mocks.search.url, searchEngine: "searxng", searchDelayMs: 0 };
    const found = await collectSearch(cfg, "HHIS.TO", "Harvest High Income Shares ETF", "Harvest");
    assert.equal(found.queries.length, 3);
    assert.equal(mocks.queries.length, 3);
    assert.equal(mocks.queries[0].format, "json");
    assert.ok(found.results.length >= 3 && found.results.length <= 15);
    const urls = found.results.map((r) => r.url);
    assert.equal(new Set(urls).size, urls.length);
    for (const r of found.results) {
      assert.ok(r.title && r.url && r.domain);
      assert.equal(Object.keys(r).sort().join(","), "domain,snippet,title,url");
    }
  } finally {
    await mocks.close();
  }
});

test("callOllama posts stream:false think:false and strips think blocks", async () => {
  const pair = mockPair();
  const mocks = await pair.start();
  try {
    const text = await callOllama({ ollamaUrl: mocks.ollama.url, ollamaModel: "qwen3.5:9b" }, "sys", "user");
    assert.equal(mocks.chats.length, 1);
    assert.equal(mocks.chats[0].stream, false);
    assert.equal(mocks.chats[0].think, false);
    assert.equal(mocks.chats[0].model, "qwen3.5:9b");
    assert.ok(!text.includes("<think>"));
    assert.match(text, /Recommendation: Neutral/);
  } finally {
    await mocks.close();
  }
});

test("end-to-end: mock Ollama and SearXNG write markdown and json, then resume", async () => {
  const dir = tmp();
  const pair = mockPair();
  const mocks = await pair.start();
  const cfg = fixtureCfg(dir, { ollamaUrl: mocks.ollama.url, searchUrl: mocks.search.url });
  try {
    const first = await runEtfNotes(["--only", "HHIS.TO"], { cfg, sleep: async () => {} });
    assert.equal(first.ok, true);
    assert.equal(first.written, 1);
    const md = readFileSync(cfg.notesMd, "utf8");
    const json = JSON.parse(readFileSync(cfg.notesJson, "utf8"));
    assert.match(md, /## Harvest/);
    assert.match(md, /### HHIS — Harvest High Income Shares ETF/);
    assert.match(md, /Recommendation: Neutral/);
    assert.ok(!md.includes("<think>"));
    assert.match(md, /https:\/\/harvestportfolios.com\/etf\/hhis\//);
    assert.equal(json.funds.length, 1);
    assert.equal(json.funds[0].ticker, "HHIS.TO");
    assert.ok(json.funds[0].sources.length >= 1);
    assert.equal(mocks.chats[0].stream, false);
    assert.equal(mocks.chats[0].think, false);
    const user = mocks.chats[0].messages.find((m) => m.role === "user").content;
    assert.match(user, /Fund: HHIS\.TO/);
    assert.match(user, /Online sources:/);
    assert.doesNotMatch(user, /\{\{/);

    const second = await runEtfNotes(["--only", "HHIS.TO"], { cfg, sleep: async () => {} });
    assert.equal(second.written, 0);
    assert.equal(second.skipped, 1);
    const chatsAfterSkip = mocks.chats.length;

    const forced = await runEtfNotes(["--only", "HHIS.TO", "--force"], { cfg, sleep: async () => {} });
    assert.equal(forced.written, 1);
    assert.ok(mocks.chats.length > chatsAfterSkip);

    const limited = await runEtfNotes(["--limit", "1", "--force"], { cfg, sleep: async () => {} });
    assert.equal(limited.funds, 1);
    assert.equal(limited.written, 1);

    const byProvider = await runEtfNotes(["--provider", "Hamilton"], { cfg, sleep: async () => {} });
    assert.equal(byProvider.written, 1);
    const after = JSON.parse(readFileSync(cfg.notesJson, "utf8"));
    assert.ok(after.funds.some((f) => f.ticker === "HMAX.TO"));
    const md2 = readFileSync(cfg.notesMd, "utf8");
    assert.match(md2, /## Hamilton/);
  } finally {
    await mocks.close();
  }
});

test("end-to-end continues without search when preflight is 403", async () => {
  const dir = tmp();
  const pair = mockPair({ searchMode: "forbidden" });
  const mocks = await pair.start();
  const cfg = fixtureCfg(dir, { ollamaUrl: mocks.ollama.url, searchUrl: mocks.search.url });
  try {
    const result = await runEtfNotes(["--only", "HHIS.TO"], { cfg, sleep: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.written, 1);
    const user = mocks.chats[0].messages.find((m) => m.role === "user").content;
    assert.match(user, /No online sources were retrieved/);
  } finally {
    await mocks.close();
  }
});

test("listFunds honours --only, --provider and --limit", () => {
  const dir = tmp();
  const holdingsFile = fixtureHoldings(dir);
  const funds = loadHoldingsJson(holdingsFile);
  const tickers = new Map();
  assert.equal(listFunds(funds, tickers, { only: ["HHIS"] }).map((f) => f.symbol).join(), "HHIS.TO");
  assert.equal(listFunds(funds, tickers, { provider: "Hamilton" }).map((f) => f.symbol).join(), "HMAX.TO");
  assert.equal(listFunds(funds, tickers, { limit: 1 }).length, 1);
});

test("BENCHMARKS still use the documented Canadian-listed tickers", () => {
  assert.deepEqual(BENCHMARKS.sp500.legs.map((l) => l.ticker), ["VFV.TO", "VSP.TO"]);
  assert.deepEqual(BENCHMARKS.nasdaq100.legs.map((l) => l.ticker), ["ZNQ.TO", "XQQ.TO"]);
  assert.equal(BENCHMARKS.canada.legs[0].ticker, "XIU.TO");
  assert.equal(BENCHMARKS["canada-banks"].legs[0].ticker, "ZEB.TO");
  assert.equal(BENCHMARKS["canada-utilities"].legs[0].ticker, "ZUT.TO");
  assert.equal(BENCHMARKS["canada-energy"].legs[0].ticker, "XEG.TO");
  assert.equal(BENCHMARKS["canada-tech"].legs[0].ticker, "XIT.TO");
});
