/**
 * Live Brompton holdings with a disk cache under /data/lookthru/provider-holdings (never in git).
 *
 * Politeness: one fixed User-Agent, bromptongroup.com robots.txt Crawl-delay (10 s) between
 * requests, Yahoo name searches spaced 1.1 s apart, no retries against a Cloudflare block.
 * A full BMAX tree is about a dozen pages, so it runs in the background: the first look-through
 * falls back to the catalog, and the cache is used from then on (and warmed at server start).
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCompanyName, tickerFromCompanyName } from "./catalog.ts";
import { loadHoldingsFile } from "./holdings-file.ts";
import {
  BROMPTON_FUNDS,
  bromptonFund,
  bromptonFundByName,
  bromptonHoldings,
  bromptonUrl,
  classifyBromptonRow,
  isBlockedPage,
  parseBromptonHtml,
  parsePortfolioSummaryLeverage,
  type BromptonLeverage,
  type BromptonPage,
} from "./brompton.ts";
import { stripShareClass } from "./tickers.ts";
import type { HoldingLine } from "./types.ts";

function envNumber(key: string, fallback: number): number {
  const raw = (typeof process !== "undefined" ? process.env[key] : undefined)?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** How long a cached provider list stays fresh (PROVIDER_CACHE_TTL_HOURS, default 168 = 7 days). */
export const PROVIDER_TTL_MS = envNumber("PROVIDER_CACHE_TTL_HOURS", 168) * 60 * 60 * 1000;
/** Gap between requests to bromptongroup.com (PROVIDER_FETCH_DELAY_MS). Never below the site's 10 s crawl delay. */
export const BROMPTON_DELAY_MS = Math.max(10_000, envNumber("PROVIDER_FETCH_DELAY_MS", 10_000));
/** Background re-check interval (PROVIDER_REFRESH_HOURS, default 24). */
export const PROVIDER_REFRESH_MS = envNumber("PROVIDER_REFRESH_HOURS", 24) * 60 * 60 * 1000;
export const YAHOO_SEARCH_DELAY_MS = 1_100;
const FETCH_MS = 20_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function providerDir(): string {
  return process.env["LOOKTHRU_PROVIDER_DIR"] || "/data/lookthru/provider-holdings";
}

export type CachedFund = {
  ticker: string;
  name: string;
  fetchedAt: number;
  asOf?: string;
  source: string;
  basis: BromptonPage["basis"];
  leverage?: BromptonLeverage | null;
  holdings: HoldingLine[];
};

export type BromptonDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  dir?: string;
  /** PDF bytes → `pdftotext -layout` text; null when poppler is not installed. */
  pdfToText?: (pdf: Uint8Array) => Promise<string | null>;
  log?: (msg: string) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function cachePath(ticker: string, dir = providerDir()): string {
  return join(dir, `${stripShareClass(ticker)}.json`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}

export function readCachedFund(ticker: string, dir?: string): CachedFund | null {
  try {
    const json = JSON.parse(readFileSync(cachePath(ticker, dir), "utf8")) as CachedFund;
    return Array.isArray(json.holdings) && json.holdings.length ? json : null;
  } catch {
    return null;
  }
}

// ---- polite per-host gate ---------------------------------------------------------------
const lastHit = new Map<string, number>();
let chain: Promise<unknown> = Promise.resolve();

async function politeFetch(url: string, delayMs: number, deps: BromptonDeps, accept = "*/*"): Promise<Response | null> {
  const host = new URL(url).host;
  const run = async () => {
    const now = (deps.now ?? Date.now)();
    const wait = (lastHit.get(host) ?? 0) + delayMs - now;
    if (wait > 0) await (deps.sleep ?? defaultSleep)(wait);
    lastHit.set(host, (deps.now ?? Date.now)());
    try {
      return await (deps.fetch ?? fetch)(url, {
        headers: { "User-Agent": UA, Accept: accept },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_MS),
      });
    } catch {
      return null;
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

export function resetPoliteGate(): void {
  lastHit.clear();
  chain = Promise.resolve();
}

// ---- name → ticker ----------------------------------------------------------------------
type NameCache = Record<string, string>;

function nameCachePath(dir = providerDir()): string {
  return join(dir, "name-tickers.json");
}

function readNameCache(dir?: string): NameCache {
  try {
    return JSON.parse(readFileSync(nameCachePath(dir), "utf8")) as NameCache;
  } catch {
    return {};
  }
}

/** Company names already resolved by the pre-scraped holdings file (same issuer wording). */
function fileNameIndex(): Map<string, string> {
  const map = new Map<string, string>();
  for (const fund of new Set(loadHoldingsFile().values())) {
    for (const h of fund.holdings) {
      if (!h.symbol || !h.name || h.symbol === "CASH" || h.symbol === "OTHER" || h.symbol === "OPTIONS") continue;
      const key = normalizeCompanyName(h.name);
      if (key && !map.has(key)) map.set(key, h.symbol);
    }
  }
  return map;
}

/** Exchanges Yahoo returns for secondary German / OTC quotes we'd rather not pick. */
const SECONDARY = /\.(SG|MU|DU|BE|HM|HA|F|DE?X|VI|BA|MX|SN|SA)$/i;

function nameMatches(query: string, candidate: string): boolean {
  const q = normalizeCompanyName(query).split(" ").filter((w) => w.length >= 3 && !/^(adr|ads|spa|nv|se|ag)$/.test(w));
  const c = ` ${normalizeCompanyName(candidate)} `;
  if (!q.length) return false;
  // First distinctive word must match; when there are two, the second must too (e.g. "general electric").
  return q.slice(0, 2).every((w) => c.includes(` ${w}`));
}

async function yahooSearch(name: string, fund: boolean, deps: BromptonDeps): Promise<string | null> {
  const query = name.replace(/\bADRs?\b|\bADS\b/gi, "").replace(/\s+/g, " ").trim();
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
  const res = await politeFetch(url, YAHOO_SEARCH_DELAY_MS, deps, "application/json,*/*");
  if (!res || !res.ok) return null;
  try {
    const json = (await res.json()) as {
      quotes?: Array<{ symbol?: string; quoteType?: string; shortname?: string; longname?: string }>;
    };
    const want = fund ? "ETF" : "EQUITY";
    const matches = (json.quotes ?? []).filter(
      (q) =>
        q.symbol &&
        (q.quoteType ?? "").toUpperCase() === want &&
        !/^[A-Z]{2}[A-Z0-9]{9}\d/.test(q.symbol) &&
        nameMatches(query, `${q.longname ?? ""} ${q.shortname ?? ""}`),
    );
    const pick =
      matches.find((q) => !/\./.test(q.symbol!)) ??
      matches.find((q) => /\.(TO|NE|V)$/i.test(q.symbol!)) ??
      matches.find((q) => !SECONDARY.test(q.symbol!)) ??
      null;
    return pick?.symbol ?? null;
  } catch {
    return null;
  }
}

async function resolveNames(names: string[], deps: BromptonDeps): Promise<Map<string, string>> {
  const dir = deps.dir ?? providerDir();
  const cache = readNameCache(dir);
  const fromFile = fileNameIndex();
  const out = new Map<string, string>();
  let dirty = false;
  for (const name of names) {
    const key = normalizeCompanyName(name);
    const bare = name.replace(/\bADRs?\b/gi, "").trim();
    const hit =
      tickerFromCompanyName(name) ??
      tickerFromCompanyName(bare) ??
      fromFile.get(key) ??
      fromFile.get(normalizeCompanyName(bare)) ??
      (key in cache ? cache[key] : undefined);
    if (hit !== undefined) {
      if (hit) out.set(name, hit);
      continue;
    }
    const found = await yahooSearch(name, /\b(ETF|fund)\b/i.test(name), deps);
    cache[key] = found ?? "";
    dirty = true;
    if (found) out.set(name, found);
  }
  if (dirty) {
    try {
      writeJson(nameCachePath(dir), cache);
    } catch {
      /* read-only volume: keep in memory only */
    }
  }
  return out;
}

// ---- PDF leverage -----------------------------------------------------------------------
async function defaultPdfToText(pdf: Uint8Array): Promise<string | null> {
  const file = join(tmpdir(), `brompton-${process.pid}-${Date.now()}.pdf`);
  try {
    writeFileSync(file, pdf);
    return await new Promise<string | null>((resolve) => {
      execFile("pdftotext", ["-layout", file, "-"], { timeout: 20_000, maxBuffer: 8 << 20 }, (err, stdout) =>
        resolve(err ? null : String(stdout)),
      );
    });
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

// ---- one fund, then the tree ------------------------------------------------------------
export async function fetchBromptonFund(ticker: string, deps: BromptonDeps = {}): Promise<CachedFund | null> {
  const fund = bromptonFund(ticker);
  if (!fund) return null;
  const log = deps.log ?? (() => undefined);
  const url = bromptonUrl(fund);
  const res = await politeFetch(url, BROMPTON_DELAY_MS, deps, "text/html,*/*");
  if (!res || !res.ok) {
    log(`[brompton] ${fund.ticker}: HTTP ${res?.status ?? "error"}`);
    return null;
  }
  const html = await res.text();
  if (isBlockedPage(html)) {
    log(`[brompton] ${fund.ticker}: blocked by Cloudflare, keeping the previous cache`);
    return null;
  }
  const page = parseBromptonHtml(html);
  if (!page) {
    log(`[brompton] ${fund.ticker}: no holdings table`);
    return null;
  }
  let leverage: BromptonLeverage | null = null;
  if (page.basis === "portfolio" && page.summaryPdfUrl) {
    const pdfRes = await politeFetch(page.summaryPdfUrl, BROMPTON_DELAY_MS, deps, "application/pdf,*/*");
    if (pdfRes?.ok) {
      const bytes = new Uint8Array(await pdfRes.arrayBuffer());
      const text = await (deps.pdfToText ?? defaultPdfToText)(bytes);
      leverage = text ? parsePortfolioSummaryLeverage(text) : null;
    }
    if (!leverage) log(`[brompton] ${fund.ticker}: weights are % of portfolio; leverage not read (pdftotext missing or PDF changed)`);
  }
  const equityNames = page.rows.filter((r) => classifyBromptonRow(r.name) === "equity" || (classifyBromptonRow(r.name) === "fund" && !bromptonFundByName(r.name))).map((r) => r.name);
  const resolved = await resolveNames(equityNames, deps);
  const holdings = bromptonHoldings(page, (n) => resolved.get(n) ?? null, leverage);
  const value: CachedFund = {
    ticker: fund.ticker,
    name: fund.name,
    fetchedAt: (deps.now ?? Date.now)(),
    asOf: page.asOf,
    source: url,
    basis: page.basis,
    leverage,
    holdings,
  };
  try {
    writeJson(cachePath(fund.ticker, deps.dir), value);
  } catch (err) {
    log(`[brompton] could not write cache: ${(err as Error).message}`);
  }
  log(`[brompton] ${fund.ticker}: ${holdings.length} rows as of ${page.asOf ?? "?"} (${page.basis})`);
  return value;
}

function isFresh(c: CachedFund | null, deps: BromptonDeps): boolean {
  return Boolean(c && (deps.now ?? Date.now)() - c.fetchedAt < PROVIDER_TTL_MS);
}

/** Fetch a Brompton fund and every Brompton fund it holds (skipping fresh cache entries). */
export async function refreshBromptonTree(ticker: string, deps: BromptonDeps = {}): Promise<number> {
  const queue = [ticker];
  const seen = new Set<string>();
  let fetched = 0;
  while (queue.length) {
    const t = queue.shift()!;
    const key = stripShareClass(t);
    if (seen.has(key) || !bromptonFund(t)) continue;
    seen.add(key);
    let c = readCachedFund(t, deps.dir);
    if (!isFresh(c, deps)) {
      const got = await fetchBromptonFund(t, deps);
      if (got) {
        c = got;
        fetched++;
      }
    }
    for (const h of c?.holdings ?? []) if (bromptonFund(h.symbol)) queue.push(h.symbol);
  }
  return fetched;
}

const inflight = new Map<string, Promise<number>>();

export function refreshInBackground(ticker: string, deps: BromptonDeps = {}): Promise<number> {
  const key = stripShareClass(ticker);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = refreshBromptonTree(ticker, deps)
    .catch((err) => {
      (deps.log ?? console.error)(`[brompton] refresh ${ticker} failed: ${(err as Error).message}`);
      return 0;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Cached Brompton holdings for a look-through. Never blocks on the network: a missing or
 * stale entry starts a background refresh and returns whatever is cached (or null).
 */
export function bromptonHoldingsCached(ticker: string, deps: BromptonDeps = {}): CachedFund | null {
  if (!bromptonFund(ticker)) return null;
  const c = readCachedFund(ticker, deps.dir);
  if (!isFresh(c, deps)) void refreshInBackground(ticker, deps);
  return c;
}

function shouldAutostart(): boolean {
  if (typeof process.env["NODE_TEST_CONTEXT"] === "string") return false;
  const v = (process.env["PROVIDER_HOLDINGS_PREFETCH"] ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(v)) return false;
  const life = process.env["npm_lifecycle_event"] ?? "";
  if (["build", "build:dev", "typecheck", "lint", "test", "test:scripts"].includes(life)) return false;
  return !(/\bvite\b/.test(process.argv.join(" ")) && /\bbuild\b/.test(process.argv.join(" ")));
}

let warmTimer: ReturnType<typeof setTimeout> | null = null;

/** Server boot: warm every known Brompton fund (BMAX first), then re-check daily. */
export function startProviderHoldingsWarmup(): void {
  if (warmTimer || !shouldAutostart()) return;
  const run = async () => {
    for (const f of BROMPTON_FUNDS) await refreshInBackground(f.ticker, { log: (m) => console.log(m) });
  };
  const loop = () => {
    void run().finally(() => {
      warmTimer = setTimeout(loop, PROVIDER_REFRESH_MS);
      warmTimer.unref?.();
    });
  };
  warmTimer = setTimeout(loop, 5_000);
  warmTimer.unref?.();
}
