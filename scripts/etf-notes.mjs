#!/usr/bin/env node
/**
 * Draft one-paragraph ETF notes from local holdings + the SQLite price cache,
 * optional SearXNG snippets, and a local Ollama model. Nothing is posted.
 *
 *   npm run etf-notes -- [--force] [--limit N] [--only TICKER] [--provider NAME]
 */
import {
  HELP,
  buildFundPack,
  callOllama,
  collectSearch,
  envConfig,
  fetchProviderPage,
  listFunds,
  loadHoldingsJson,
  loadNotesJson,
  loadPromptTemplate,
  loadTickersJson,
  openPricesDb,
  parseArgs,
  preflightSearch,
  renderPrompts,
  upsertNote,
  writeNotes,
} from "./etf-notes-lib.mjs";

function nowIso() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[etf-notes] ${msg}`);
}

export async function runEtfNotes(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return { ok: true, help: true };
  }
  const cfg = opts.cfg || envConfig(opts.env || process.env);
  const fetcher = opts.fetch || undefined;
  const sleep = opts.sleep;

  if (!cfg.holdingsFile) throw new Error("LOOKTHRU_HOLDINGS_FILE is not set");
  const funds = loadHoldingsJson(cfg.holdingsFile);
  const tickers = loadTickersJson(cfg.tickersFile);
  const db = openPricesDb(cfg.pricesDb);
  if (!db) log(`No prices database at ${cfg.pricesDb}; notes will omit performance.`);

  const templates = {
    system: loadPromptTemplate("etf-note.system.md", opts.promptsDir),
    user: loadPromptTemplate("etf-note.user.md", opts.promptsDir),
  };

  const selected = listFunds(funds, tickers, args);
  if (!selected.length) {
    log("No funds matched the given filters.");
    return { ok: true, skipped: 0, written: 0, funds: 0 };
  }

  if (args.printPrompt) {
    const fund = selected.find((f) => f.symbol === args.printPrompt.toUpperCase())
      || selected.find((f) => f.symbol.replace(/\.TO$/i, "") === args.printPrompt.toUpperCase().replace(/\.TO$/i, ""));
    if (!fund) {
      log(`--print-prompt: ${args.printPrompt} is not in the selected set.`);
      return { ok: false, written: 0, skipped: 0 };
    }
    const pack = buildFundPack(fund, funds, tickers, db);
    pack.sources = opts.mockSources ?? [];
    pack.providerPage = opts.mockProviderPage ?? "Not fetched.";
    const rendered = renderPrompts(pack, templates);
    console.log("===== SYSTEM =====");
    console.log(rendered.system);
    console.log("===== USER =====");
    console.log(rendered.user);
    return { ok: true, printed: true, pack, rendered };
  }

  log(`Search: ${cfg.searchUrl} (engine=${cfg.searchEngine})`);
  const preflight = await preflightSearch(cfg, fetcher);
  if (!preflight.ok) log(`WARN ${preflight.message}`);
  else log(preflight.message);
  const searchEnabled = preflight.ok;

  let store = loadNotesJson(cfg.notesJson);
  const already = new Set(store.funds.map((f) => f.ticker));
  let written = 0;
  let skipped = 0;
  let failed = 0;
  const total = selected.length;
  let index = 0;

  for (const fund of selected) {
    index += 1;
    const tag = `${fund.symbol} (${index}/${total})`;
    if (!args.force && already.has(fund.symbol)) {
      log(`skip ${tag} — already in etf-notes.json (use --force to redo)`);
      skipped += 1;
      continue;
    }
    log(`draft ${tag}`);
    try {
      const pack = buildFundPack(fund, funds, tickers, db);
      if (searchEnabled) {
        const found = await collectSearch(cfg, pack.ticker, pack.name, pack.provider, fetcher, sleep);
        pack.sources = found.results;
        pack.queries = found.queries;
        if (cfg.fetchPages) {
          const pageUrl =
            pack.sourceUrl ||
            found.results.find((r) => /etf|fund|harvest|hamilton|global x|bmo|ishares|vanguard/i.test(`${r.domain} ${r.title}`))?.url ||
            found.results[0]?.url;
          pack.providerPage = (await fetchProviderPage(pageUrl, fetcher)) || "Not fetched.";
        } else {
          pack.providerPage = "Not fetched.";
        }
      } else {
        pack.sources = [];
        pack.providerPage = "Not fetched.";
      }
      const rendered = renderPrompts(pack, templates);
      const text = await callOllama(cfg, rendered.system, rendered.user, fetcher);
      if (!text) throw new Error("Ollama returned an empty note");
      const generated = nowIso();
      const note = {
        ticker: pack.ticker,
        displayTicker: pack.displayTicker,
        name: pack.name,
        provider: pack.provider,
        asOf: pack.asOf,
        generated,
        model: cfg.ollamaModel,
        text,
        sources: pack.sources || [],
        queries: pack.queries || [],
      };
      store = upsertNote(store, note);
      store.generated = generated;
      writeNotes(cfg, store);
      already.add(pack.ticker);
      written += 1;
      log(`wrote ${tag}`);
    } catch (err) {
      failed += 1;
      log(`FAIL ${tag}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (db) db.close();
  log(`done: wrote ${written}, skipped ${skipped}, failed ${failed}, of ${total} selected`);
  return { ok: failed === 0, written, skipped, failed, funds: total };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("etf-notes.mjs");
if (isMain && process.env.ETF_NOTES_NO_MAIN !== "1") {
  runEtfNotes().then((r) => {
    if (!r.ok) process.exitCode = 1;
  }, (err) => {
    console.error(`[etf-notes] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exitCode = 1;
  });
}
