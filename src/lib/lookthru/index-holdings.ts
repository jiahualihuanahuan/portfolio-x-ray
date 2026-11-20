/**
 * Public full-holdings files for index proxies (VFV → S&P 500, ZNQ → Nasdaq-100,
 * XIU → TSX 60). Cached under /data, never committed. Yahoo's top-10 is only
 * used when none of the public CSVs can be fetched, and is flagged `partial`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HoldingLine } from "./types.ts";
import { sectorOf } from "./catalog.ts";
import { applyAlias, normalizeTicker } from "./tickers.ts";

export const INDEX_HOLDINGS_DIR = "/data/lookthru/index-holdings";
export const INDEX_TTL_MS = 12 * 60 * 60 * 1000;

export type IndexSourceId =
  | "ivv-ishares"
  | "qqq-invesco"
  | "qqq-invesco-dng"
  | "xqq-ishares"
  | "xqqu-ishares"
  | "xiu-ishares"
  | "nasdaq100-cap-weighted"
  | "yahoo-top10";

export type IndexHoldings = {
  holdings: HoldingLine[];
  asOf?: string;
  source: IndexSourceId;
  sourceUrl: string;
  proxyFor: string;
  partial: boolean;
  coverage: number;
};

type IndexSpec = {
  keys: string[];
  proxyFor: string;
  sources: { id: Exclude<IndexSourceId, "yahoo-top10">; url: string }[];
};

export const INDEX_SPECS: IndexSpec[] = [
  {
    keys: ["VFV.TO", "VFV", "VOO", "IVV", "SPY", "SPX"],
    proxyFor: "S&P 500",
    sources: [
      {
        id: "ivv-ishares",
        url: "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv",
      },
      {
        id: "ivv-ishares",
        url: "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/latest-holdings.csv",
      },
    ],
  },
  {
    keys: ["ZNQ.TO", "ZNQ", "QQQ", "QQQM", "XQQ.TO", "XQQ", "XQQU.TO", "XQQU"],
    proxyFor: "Nasdaq-100",
    sources: [
      {
        id: "xqqu-ishares",
        url: "https://www.blackrock.com/ca/investors/en/products/332751/fund/1464253357814.ajax?fileType=csv&fileName=XQQU_holdings&dataType=fund",
      },
      {
        id: "xqq-ishares",
        url: "https://www.blackrock.com/ca/investors/en/products/239698/ishares-nasdaq-100-index-etf-cadhedged-fund/1464253357814.ajax?fileType=csv&fileName=XQQ_holdings&dataType=fund",
      },
      {
        id: "qqq-invesco-dng",
        url: "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/QQQ/holdings/fund?idType=ticker&interval=daily&productType=ETF",
      },
      {
        id: "nasdaq100-cap-weighted",
        url: "https://api.nasdaq.com/api/quote/list-type/nasdaq100",
      },
    ],
  },
  {
    keys: ["XIU.TO", "XIU"],
    proxyFor: "S&P/TSX 60",
    sources: [
      {
        id: "xiu-ishares",
        url: "https://www.blackrock.com/ca/investors/en/products/239832/ishares-sptsx-60-index-etf/1464253357814.ajax?fileType=csv&fileName=XIU_holdings&dataType=fund",
      },
    ],
  },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function indexSpecFor(symbol: string): IndexSpec | null {
  const key = normalizeTicker(symbol);
  const bare = key.replace(/\.(TO|NE|V)$/i, "");
  return INDEX_SPECS.find((s) => s.keys.includes(key) || s.keys.includes(bare)) ?? null;
}

export function parseIndexHoldingsCsv(text: string, canadianListings = false): { holdings: HoldingLine[]; asOf?: string } | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let headerIdx = -1;
  let asOf: string | undefined;
  const asOfMatch = text.match(/as of[,\s"]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i);
  if (asOfMatch) asOf = normalizeAsOf(asOfMatch[1]!);
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const cols = splitCsvLine(lines[i]!);
    const lower = cols.map((c) => c.trim().toLowerCase());
    if (lower.some((c) => c === "ticker" || c === "symbol" || c === "holdings ticker") && lower.some((c) => c.includes("weight") || c === "name" || c.includes("%"))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return null;
  const header = splitCsvLine(lines[headerIdx]!).map((c) => c.trim().toLowerCase());
  const tickerCol = findCol(header, ["ticker", "holdings ticker", "symbol", "isin ticker"]);
  const nameCol = findCol(header, ["name", "holding", "security name", "issuer"]);
  const weightCol = findCol(header, ["weight (%)", "weight(%)", "weight", "market weight", "% of net assets", "net assets %", "market value weight"]);
  const sectorCol = findCol(header, ["sector", "asset class", "industry"]);
  const assetCol = findCol(header, ["asset class", "assetclass", "type"]);
  if (tickerCol == null || weightCol == null) return null;
  const holdings: HoldingLine[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    const rawTicker = (cols[tickerCol] ?? "").trim();
    if (!rawTicker || /^(pending|cash|usd|cad|-|isin|futures)/i.test(rawTicker)) continue;
    const asset = assetCol != null ? (cols[assetCol] ?? "") : "";
    if (asset && /bond|deriv|future|option|cash|money market|right|warrant/i.test(asset) && !/equity|stock|common/i.test(asset)) {
      continue;
    }
    const weight = parseWeight(cols[weightCol] ?? "");
    if (weight == null || weight === 0) continue;
    let symbol = normalizeTicker(rawTicker.replace(/\s+/g, ""));
    if (canadianListings && !/\.(TO|NE|V)$/i.test(symbol) && /^[A-Z0-9][A-Z0-9.\-]{0,6}$/.test(symbol)) {
      symbol = `${symbol}.TO`;
    }
    const name = ((nameCol != null ? cols[nameCol] : "") || symbol).trim();
    const sectorRaw = (sectorCol != null ? cols[sectorCol] : "") || "";
    holdings.push({
      symbol: applyAlias(symbol),
      name,
      weight,
      sector: cleanSector(sectorRaw) || sectorOf(symbol),
    });
  }
  const rawSum = holdings.reduce((s, h) => s + Math.abs(h.weight), 0);
  const headerLooksPercent = header[weightCol]?.includes("%") ?? false;
  if (headerLooksPercent || rawSum > 1.5) {
    for (const h of holdings) h.weight = h.weight / 100;
  }
  if (!holdings.length) return null;
  return { holdings, asOf };
}

function cleanSector(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const map: Record<string, string> = {
    "information technology": "Information Technology",
    technology: "Information Technology",
    "communication services": "Communication Services",
    communications: "Communication Services",
    "consumer discretionary": "Consumer Discretionary",
    "consumer cyclicals": "Consumer Discretionary",
    "consumer staples": "Consumer Staples",
    "health care": "Health Care",
    healthcare: "Health Care",
    financials: "Financials",
    financial: "Financials",
    energy: "Energy",
    industrials: "Industrials",
    industrial: "Industrials",
    materials: "Materials",
    "real estate": "Real Estate",
    utilities: "Utilities",
  };
  return map[s.toLowerCase()] ?? s;
}

function parseWeight(raw: string): number | null {
  const s = raw.replace(/,/g, "").replace(/%/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

function findCol(header: string[], names: string[]): number | null {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeAsOf(raw: string): string {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;
  const mdy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (mdy) {
    const y = mdy[3]!.length === 2 ? `20${mdy[3]}` : mdy[3]!;
    return `${y}-${mdy[1]!.padStart(2, "0")}-${mdy[2]!.padStart(2, "0")}`;
  }
  const named = raw.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})$/i);
  if (named) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const mm = months[named[1]!.slice(0, 3).toLowerCase()] ?? "01";
    return `${named[3]}-${mm}-${named[2]!.padStart(2, "0")}`;
  }
  return raw;
}

function cachePath(spec: IndexSpec, dir: string): string {
  const slug = spec.proxyFor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return join(dir, `${slug}.json`);
}

function readCache(file: string, ttl = INDEX_TTL_MS): IndexHoldings | null {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as IndexHoldings & { cachedAt?: number };
    if (parsed.cachedAt && Date.now() - parsed.cachedAt > ttl) return null;
    if (!parsed.holdings?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(file: string, value: IndexHoldings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...value, cachedAt: Date.now() }, null, 0));
}

export type IndexFetchDeps = {
  fetch?: typeof fetch;
  dir?: string;
  ttl?: number;
  yahooHoldings?: (symbol: string) => Promise<HoldingLine[] | null>;
};

async function download(url: string, deps: IndexFetchDeps): Promise<string | null> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const productPage = url.split("/").slice(0, 8).join("/");
    const res = await doFetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/csv,application/json,text/plain,*/*",
        Referer: productPage,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length < 200) return null;
    if (/<html/i.test(text.slice(0, 200)) && !/ticker/i.test(text.slice(0, 2000))) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Fetch a full public holdings file for an index proxy. Returns a partial
 * Yahoo top-10 book only when every CSV source fails.
 */

async function defaultYahooHoldings(symbol: string): Promise<HoldingLine[] | null> {
  try {
    const { fetchYahooHoldings } = await import("./yahoo.server.ts");
    return await fetchYahooHoldings(symbol);
  } catch {
    return null;
  }
}


export function parseInvescoDngJson(text: string): { holdings: HoldingLine[]; asOf?: string } | null {
  try {
    const json = JSON.parse(text) as {
      effectiveDate?: string;
      holdings?: Array<{
        ticker?: string;
        issuerName?: string;
        percentageOfTotalNetAssets?: number;
        securityTypeName?: string;
        securityTypeCode?: string;
      }>;
    };
    if (!Array.isArray(json.holdings) || !json.holdings.length) return null;
    const holdings: HoldingLine[] = [];
    for (const row of json.holdings) {
      const ticker = (row.ticker ?? "").trim();
      const typ = `${row.securityTypeName ?? ""} ${row.securityTypeCode ?? ""}`;
      if (!ticker || /cash|currency|collateral|future|option|bond/i.test(typ)) continue;
      if (row.securityTypeName && !/stock|equity|depositary|common|share/i.test(row.securityTypeName)) continue;
      const pct = row.percentageOfTotalNetAssets;
      if (pct == null || !Number.isFinite(pct) || pct === 0) continue;
      const symbol = applyAlias(normalizeTicker(ticker.replace(/\s+/g, "")));
      holdings.push({
        symbol,
        name: row.issuerName || symbol,
        weight: pct / 100,
        sector: sectorOf(symbol),
      });
    }
    if (holdings.length < 20) return null;
    return { holdings, asOf: json.effectiveDate };
  } catch {
    return null;
  }
}

export function parseNasdaqListJson(text: string): { holdings: HoldingLine[]; asOf?: string } | null {
  try {
    const json = JSON.parse(text) as {
      data?: { date?: string; data?: { rows?: Array<{ symbol?: string; companyName?: string; marketCap?: string; sector?: string }> } };
    };
    const rows = json.data?.data?.rows ?? [];
    const parsed: { symbol: string; name: string; sector: string; cap: number }[] = [];
    for (const row of rows) {
      const ticker = (row.symbol ?? "").trim();
      if (!ticker) continue;
      const cap = Number(String(row.marketCap ?? "").replace(/[$,]/g, ""));
      if (!Number.isFinite(cap) || cap <= 0) continue;
      const symbol = applyAlias(normalizeTicker(ticker));
      parsed.push({ symbol, name: row.companyName || symbol, sector: row.sector || sectorOf(symbol), cap });
    }
    const total = parsed.reduce((s, r) => s + r.cap, 0);
    if (parsed.length < 80 || total <= 0) return null;
    return {
      holdings: parsed.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        weight: r.cap / total,
        sector: r.sector,
      })),
      asOf: json.data?.date ? normalizeAsOfNasdaq(json.data.date) : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeAsOfNasdaq(raw: string): string | undefined {
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}

export async function fetchIndexHoldings(symbol: string, deps: IndexFetchDeps = {}): Promise<IndexHoldings | null> {
  const spec = indexSpecFor(symbol);
  if (!spec) return null;
  const dir = deps.dir ?? process.env["INDEX_HOLDINGS_DIR"] ?? INDEX_HOLDINGS_DIR;
  const file = cachePath(spec, dir);
  const cached = readCache(file, deps.ttl ?? INDEX_TTL_MS);
  if (cached) return cached;
  const canadian = spec.proxyFor.includes("TSX");
  for (const src of spec.sources) {
    const text = await download(src.url, deps);
    if (!text) continue;
    const trimmed = text.trim();
    const parsed =
      trimmed.startsWith("{") || trimmed.startsWith("[")
        ? parseInvescoDngJson(text) ?? parseNasdaqListJson(text)
        : parseIndexHoldingsCsv(text, canadian);
    if (!parsed || parsed.holdings.length < 10) continue;
    const coverage = parsed.holdings.reduce((s, h) => s + Math.max(h.weight, 0), 0);
    const result: IndexHoldings = {
      holdings: parsed.holdings,
      asOf: parsed.asOf,
      source: src.id,
      sourceUrl: src.url,
      proxyFor: spec.proxyFor,
      partial: parsed.holdings.length < 30,
      coverage,
    };
    writeCache(file, result);
    return result;
  }
  const fallback = deps.yahooHoldings ?? defaultYahooHoldings;
  let yahoo: HoldingLine[] | null = null;
  for (const cand of [symbol, ...spec.keys]) {
    yahoo = await fallback(cand);
    if (yahoo && yahoo.length) break;
  }
  if (yahoo && yahoo.length) {
    const coverage = yahoo.reduce((s, h) => s + Math.max(h.weight, 0), 0);
    return {
      holdings: yahoo,
      source: "yahoo-top10",
      sourceUrl: `yahoo:quoteSummary:${symbol}`,
      proxyFor: spec.proxyFor,
      partial: true,
      coverage,
    };
  }
  return null;
}

export function isIndexProxyTicker(symbol: string): boolean {
  return indexSpecFor(symbol) != null;
}
