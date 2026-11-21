/**
 * Shared logic for scripts/etf-notes.mjs. Pure enough to unit-test without Ollama.
 * A JS port of the Fund Lookup total-return and benchmark rules, plus search and prompts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const DEFAULTS = {
  holdingsFile: "/data/lookthru/holdings.json",
  tickersFile: "/data/lookthru/tickers.json",
  pricesDb: "/data/lookthru/prices.sqlite",
  notesDir: "/data/lookthru",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "qwen3.5:9b",
  searchUrl: "http://localhost:8099",
  searchEngine: "searxng",
  searchDelayMs: 400,
  searchTimeoutMs: 15_000,
  ollamaTimeoutMs: 180_000,
  providerPageChars: 2_000,
};

export const BENCHMARKS = {
  sp500: {
    id: "sp500",
    label: "S&P 500",
    legs: [
      { ticker: "VFV.TO", name: "S&P 500, unhedged", hedge: "unhedged" },
      { ticker: "VSP.TO", name: "S&P 500, hedged", hedge: "hedged" },
    ],
  },
  nasdaq100: {
    id: "nasdaq100",
    label: "Nasdaq-100",
    legs: [
      { ticker: "ZNQ.TO", name: "Nasdaq-100, unhedged", hedge: "unhedged" },
      { ticker: "XQQ.TO", name: "Nasdaq-100, hedged", hedge: "hedged" },
    ],
  },
  canada: {
    id: "canada",
    label: "S&P/TSX 60",
    legs: [{ ticker: "XIU.TO", name: "S&P/TSX 60", hedge: "none" }],
  },
  "canada-banks": {
    id: "canada-banks",
    label: "Canadian banks",
    legs: [{ ticker: "ZEB.TO", name: "Canadian banks", hedge: "none" }],
  },
  "canada-utilities": {
    id: "canada-utilities",
    label: "Canadian utilities",
    legs: [{ ticker: "ZUT.TO", name: "Canadian utilities", hedge: "none" }],
  },
  "canada-energy": {
    id: "canada-energy",
    label: "Canadian energy",
    legs: [{ ticker: "XEG.TO", name: "Canadian energy", hedge: "none" }],
  },
  "canada-tech": {
    id: "canada-tech",
    label: "Canadian tech",
    legs: [{ ticker: "XIT.TO", name: "Canadian tech", hedge: "none" }],
  },
};

export const MANUAL_BENCHMARKS = {
  HMAX: "canada-banks",
  ZWB: "canada-banks",
  BANK: "canada-banks",
  QMAX: "nasdaq100",
  ZWQ: "nasdaq100",
  USCL: "sp500",
  HYLD: "sp500",
  UTES: "canada-utilities",
  HUTL: "canada-utilities",
};

const SINGLE_STOCK_CC = new Set([
  "HHIS", "YNVD", "LLHE", "MSHE", "APLE", "NVHE", "PLTE", "AMHE", "CRWY", "TSLY",
  "GOGY", "COSY", "AVGY", "AMDY", "METE", "SPXE", "SOFY", "HODY", "MSTE", "CNYE",
  "CRCY", "RDDY",
]);

export const NASDAQ_100_FALLBACK = new Set([
  "AAPL", "ABNB", "ADBE", "ADI", "ADP", "ADSK", "AEP", "AMAT", "AMD", "AMGN",
  "AMZN", "APP", "ARM", "ASML", "AVGO", "AXON", "AZN", "BIIB", "BKNG", "BKR",
  "CCEP", "CDNS", "CEG", "CHTR", "CMCSA", "COST", "CPRT", "CRWD", "CSCO", "CSGP",
  "CSX", "CTAS", "CTSH", "DASH", "DDOG", "DLTR", "DXCM", "EA", "EXC", "FANG",
  "FAST", "FTNT", "GEHC", "GFS", "GILD", "GOOG", "GOOGL", "HON", "IDXX", "INTC",
  "INTU", "ISRG", "KDP", "KHC", "KLAC", "LIN", "LRCX", "LULU", "MAR", "MCHP",
  "MDB", "MDLZ", "MELI", "META", "MNST", "MRVL", "MSFT", "MSTR", "MU", "NFLX",
  "NVDA", "NXPI", "ODFL", "ON", "ORLY", "PANW", "PAYX", "PCAR", "PDD", "PEP",
  "PLTR", "PYPL", "QCOM", "REGN", "ROP", "ROST", "SBUX", "SNPS", "TEAM", "TMUS",
  "TSLA", "TTD", "TTWO", "TXN", "VRSK", "VRTX", "WBD", "WDAY", "XEL", "ZS",
]);

const SECTOR_BENCHMARK = {
  financials: "canada-banks",
  financial: "canada-banks",
  banks: "canada-banks",
  utilities: "canada-utilities",
  utility: "canada-utilities",
  energy: "canada-energy",
  technology: "canada-tech",
  "information technology": "canada-tech",
  "info tech": "canada-tech",
  "information-technology": "canada-tech",
};

const TECH_SECTORS = new Set(["technology", "information technology", "info tech", "information-technology"]);
const EXCHANGE_SUFFIX = /\.(TO|NE|V|CN|NEO)$/i;
const RANGE_DAYS = { "1Y": 365, "3Y": 365 * 3, "5Y": 365 * 5 };

export function issuerKey(symbol) {
  let s = String(symbol || "").trim().toUpperCase().replace(/\s+/g, "").replace(/\//g, ".");
  s = s.replace(/-([A-Z])$/u, ".$1");
  s = s.replace(EXCHANGE_SUFFIX, "");
  if (s.endsWith(".U") && s.length > 3) s = s.slice(0, -2);
  return s;
}

export function displaySymbol(symbol) {
  const n = String(symbol || "").trim().toUpperCase();
  if (n === "CASH") return "CASH";
  if (n === "OPTIONS") return "OPT";
  if (n === "OTHER") return "OTHER";
  return n.replace(EXCHANGE_SUFFIX, "").replace(/-([A-Z])$/u, ".$1");
}

export function normalizeCountry(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(canada|ca|can|cdn)$/.test(s) || s.startsWith("canada")) return "Canada";
  if (
    /^(united states|united states of america|usa|us|u\.s\.|u\.s\.a\.)$/.test(s) ||
    s.startsWith("united states")
  ) {
    return "United States";
  }
  return "Other";
}

export function inferCountry(h) {
  const tagged = normalizeCountry(h.country);
  if (tagged) return tagged;
  const sym = (h.symbol || "").toUpperCase();
  if (!sym || ["CASH", "OPTIONS", "OTHER"].includes(sym) || ["Cash", "Options"].includes(h.sector || "")) return null;
  if (EXCHANGE_SUFFIX.test(sym)) return "Canada";
  if (!sym.includes(".")) return "United States";
  return null;
}

export function normalizeSector(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/_/g, " ");
  if (!s || s === "cash" || s === "options" || s === "other" || s === "fund" || s === "equity") return null;
  if (s === "financial" || s === "financials" || s === "banks") return "Financials";
  if (s === "utilities" || s === "utility") return "Utilities";
  if (s === "energy") return "Energy";
  if (s === "information technology" || s === "technology" || s === "info tech" || s === "information-technology") {
    return "Information Technology";
  }
  if (s === "consumer, non-cyclical" || s === "consumer staples") return "Consumer Staples";
  if (s === "consumer, cyclical" || s === "consumer discretionary") return "Consumer Discretionary";
  if (s === "communications" || s === "communication services") return "Communication Services";
  if (s === "industrial" || s === "industrials") return "Industrials";
  if (s === "basic materials" || s === "materials") return "Materials";
  if (s === "health care" || s === "healthcare") return "Health Care";
  return raw.trim().replace(/\s+/g, " ");
}

function isPassThrough(h) {
  const key = issuerKey(h.symbol || "");
  return key === "CASH" || key === "OPTIONS" || key === "OTHER" || h.sector === "Cash" || h.sector === "Options";
}

export function flattenHoldings(holdings, lookup, depth = 0, trail = new Set()) {
  const out = [];
  for (const h of holdings || []) {
    if (!Number.isFinite(h.weight)) continue;
    const sym = (h.symbol || "").toUpperCase();
    if (!sym || isPassThrough(h) || depth >= 5 || trail.has(sym)) {
      out.push(h);
      continue;
    }
    const child = lookup(sym);
    if (!child || !child.length) {
      out.push(h);
      continue;
    }
    const next = new Set(trail);
    next.add(sym);
    out.push(...flattenHoldings(child, lookup, depth + 1, next).map((c) => ({ ...c, weight: c.weight * h.weight })));
  }
  return out;
}

export function nasdaqConstituents(lookup) {
  const set = new Set();
  for (const t of ["XQQ.TO", "ZNQ.TO"]) {
    const rows = lookup?.(t);
    if (!rows) continue;
    for (const h of rows) {
      if (isPassThrough(h) || !h.symbol) continue;
      set.add(issuerKey(h.symbol));
    }
  }
  if (!set.size) for (const s of NASDAQ_100_FALLBACK) set.add(s);
  return set;
}

function looksLikeSingleStockCC(ticker, name, holdings) {
  const key = issuerKey(ticker);
  if (SINGLE_STOCK_CC.has(key)) return true;
  if (name && /high income shares/i.test(name)) return true;
  if (!holdings?.length) return false;
  const meaningful = holdings.filter((h) => !isPassThrough(h) && Number.isFinite(h.weight));
  if (!meaningful.length) return false;
  const his = meaningful.filter((h) => SINGLE_STOCK_CC.has(issuerKey(h.symbol)) || /high income shares/i.test(h.name || ""));
  const hisWeight = his.reduce((s, h) => s + Math.max(h.weight, 0), 0);
  const total = meaningful.reduce((s, h) => s + Math.max(h.weight, 0), 0);
  return total > 0 && hisWeight / total >= 0.5;
}

function frac(part, whole) {
  return whole > 0 ? part / whole : 0;
}

export function measureExposure(leaves, constituents) {
  let equity = 0;
  let canada = 0;
  let us = 0;
  let nasdaq = 0;
  let tech = 0;
  const sectors = new Map();
  const countries = new Map();
  for (const h of leaves) {
    if (isPassThrough(h) || !Number.isFinite(h.weight) || h.weight <= 0) continue;
    const w = h.weight;
    equity += w;
    const country = inferCountry(h);
    if (country === "Canada") canada += w;
    else if (country === "United States") us += w;
    if (country) countries.set(country, (countries.get(country) ?? 0) + w);
    const key = issuerKey(h.symbol);
    if (constituents.has(key)) nasdaq += w;
    const sector = normalizeSector(h.sector);
    if (sector) {
      sectors.set(sector, (sectors.get(sector) ?? 0) + w);
      if (TECH_SECTORS.has(sector.toLowerCase())) tech += w;
    }
  }
  const mix = (map) =>
    [...map.entries()]
      .map(([name, weight]) => ({ name, weight: frac(weight, equity) }))
      .sort((a, b) => b.weight - a.weight);
  const sectorMix = mix(sectors);
  return {
    equity,
    canada: frac(canada, equity),
    us: frac(us, equity),
    nasdaq: frac(nasdaq, equity),
    tech: frac(tech, equity),
    sectors: sectorMix,
    countries: mix(countries),
    topSector: sectorMix[0] ?? null,
  };
}

export function matchBenchmark(ticker, holdings, opts = {}) {
  const key = issuerKey(ticker);
  const lookup = opts.lookup ?? (() => null);
  const leaves = flattenHoldings(holdings, lookup);
  const exp = measureExposure(leaves, nasdaqConstituents(lookup));
  const pack = (id, basis, reason) => ({
    id,
    def: BENCHMARKS[id],
    basis,
    reason,
    canadaWeight: exp.canada,
    usWeight: exp.us,
    nasdaqOverlap: exp.nasdaq,
    topSector: exp.topSector,
    sectors: exp.sectors,
    countries: exp.countries,
  });

  const manual = MANUAL_BENCHMARKS[key];
  if (manual) return pack(manual, "manual", "manual mapping");

  if (looksLikeSingleStockCC(ticker, opts.name, holdings)) {
    const usTech = exp.nasdaq >= 0.5 || exp.tech >= 0.5;
    const id = usTech ? "nasdaq100" : "sp500";
    const why = usTech
      ? `single-stock covered-call, US tech names${exp.nasdaq ? ` (Nasdaq-100 overlap ${(exp.nasdaq * 100).toFixed(0)}%)` : ""}`
      : "single-stock covered-call";
    return pack(id, "single-stock", why);
  }

  if (exp.canada >= 0.6) {
    if (exp.topSector && exp.topSector.weight >= 0.6) {
      const id = SECTOR_BENCHMARK[exp.topSector.name.toLowerCase()];
      if (id) {
        return pack(
          id,
          "canada-sector",
          `Canadian ${exp.topSector.name.toLowerCase()} exposure ${(exp.topSector.weight * 100).toFixed(0)}%`,
        );
      }
    }
    return pack("canada", "canada-broad", `Canadian exposure ${(exp.canada * 100).toFixed(0)}%`);
  }

  if (exp.us >= 0.5) {
    if (exp.nasdaq >= 0.5) {
      return pack(
        "nasdaq100",
        "us-nasdaq",
        `US large-cap exposure ${(exp.us * 100).toFixed(0)}%, Nasdaq-100 overlap ${(exp.nasdaq * 100).toFixed(0)}%`,
      );
    }
    return pack("sp500", "us-sp", `US large-cap exposure ${(exp.us * 100).toFixed(0)}%`);
  }

  return pack("sp500", "mixed", "closest broad benchmark");
}

export function dateFromUnix(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function unixFromDate(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

export function buildTotalReturnPoints(prices, dividends = [], splits = []) {
  const splitByDate = new Map();
  for (const s of splits) {
    if (s.denominator) splitByDate.set(s.date, s.numerator / s.denominator);
  }
  const divByDate = new Map();
  for (const d of dividends) divByDate.set(d.date, (divByDate.get(d.date) ?? 0) + d.amount);

  const days = prices.filter((p) => p.close != null && p.close > 0);
  if (days.length < 2) return { points: [], source: "none", dividendCount: dividends.length };
  const useAdj = days.some((p) => p.adjclose != null && p.close != null);
  let shares = 1;
  let reinvestShares = 1;
  const raw = [];
  for (const day of days) {
    const ratio = splitByDate.get(day.date);
    if (ratio && ratio > 0) {
      shares *= ratio;
      reinvestShares *= ratio;
    }
    const priceValue = shares * day.close;
    const totalValue = useAdj && day.adjclose != null && day.adjclose > 0 ? day.adjclose : reinvestShares * day.close;
    raw.push({ date: day.date, t: unixFromDate(day.date), close: day.close, priceValue, totalValue });
    const div = divByDate.get(day.date);
    if (!useAdj && div && day.close > 0) reinvestShares += (div * reinvestShares) / day.close;
  }
  const p0 = raw[0];
  if (!(p0?.priceValue > 0) || !(p0?.totalValue > 0)) return { points: [], source: "none", dividendCount: dividends.length };
  const points = raw.map((r) => ({
    date: r.date,
    t: r.t,
    close: r.close,
    priceIndex: r.priceValue / p0.priceValue,
    totalIndex: r.totalValue / p0.totalValue,
  }));
  const source = useAdj ? "adjclose" : dividends.length ? "dividends" : "price_only";
  return { points, source, dividendCount: dividends.length };
}

export function rebasePoints(points) {
  const first = points[0];
  if (!first || !(first.priceIndex > 0) || !(first.totalIndex > 0)) return points;
  return points.map((p) => ({
    ...p,
    priceIndex: p.priceIndex / first.priceIndex,
    totalIndex: p.totalIndex / first.totalIndex,
  }));
}

export function sliceHistory(points, range) {
  if (range === "MAX" || points.length < 2) return rebasePoints(points);
  const end = points[points.length - 1].t;
  const cutoff = end - RANGE_DAYS[range] * 86_400;
  let start = points.findIndex((p) => p.t >= cutoff);
  if (start < 0) return rebasePoints(points);
  if (start > 0 && points[start].t > cutoff) start -= 1;
  return rebasePoints(points.slice(start));
}

export function historySummary(points) {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first.totalIndex > 0) || !(first.priceIndex > 0)) return null;
  const years = (last.t - first.t) / (365.25 * 86_400);
  return {
    totalReturn: last.totalIndex / first.totalIndex - 1,
    priceReturn: last.priceIndex / first.priceIndex - 1,
    annualized: years >= 1 / 365 ? (last.totalIndex / first.totalIndex) ** (1 / years) - 1 : null,
    years,
    firstDate: first.date,
    lastDate: last.date,
  };
}

/** Peak-to-trough decline on the total-return index, as a negative fraction (e.g. -0.22). */
export function maxDrawdown(points) {
  let peak = -Infinity;
  let dd = 0;
  for (const p of points) {
    const v = p.totalIndex;
    if (!(v > 0)) continue;
    if (v > peak) peak = v;
    const drop = v / peak - 1;
    if (drop < dd) dd = drop;
  }
  return Number.isFinite(peak) ? dd : null;
}

/** Trailing 12-month dividend yield: sum of dividends in the last 365 days / last close. */
export function trailingYield(prices, dividends, asOf) {
  const last = [...prices].reverse().find((p) => p.close != null && p.close > 0);
  if (!last) return null;
  const end = asOf || last.date;
  const start = dateFromUnix(unixFromDate(end) - 365 * 86_400);
  const sum = dividends.filter((d) => d.date > start && d.date <= end).reduce((s, d) => s + d.amount, 0);
  return sum / last.close;
}

export function alignSeries(series) {
  const keys = Object.keys(series).filter((k) => (series[k]?.length ?? 0) >= 2);
  if (!keys.length) return [];
  const start = keys.map((k) => series[k][0].date).reduce((a, b) => (a > b ? a : b));
  const maps = new Map();
  const dateSets = [];
  for (const k of keys) {
    const m = new Map();
    for (const p of series[k]) if (p.date >= start) m.set(p.date, p);
    maps.set(k, m);
    dateSets.push([...m.keys()]);
  }
  const common = dateSets.reduce((acc, dates) => {
    const set = new Set(dates);
    return acc.filter((d) => set.has(d));
  });
  if (common.length < 2) return [];
  const rebased = {};
  for (const k of keys) {
    const pts = rebasePoints(common.map((d) => maps.get(k).get(d)));
    rebased[k] = new Map(pts.map((p) => [p.date, p.totalIndex]));
  }
  return common.map((date) => {
    const values = {};
    for (const k of keys) values[k] = rebased[k].get(date);
    return { date, t: maps.get(keys[0]).get(date).t, values };
  });
}

export function alignRange(series, range) {
  const sliced = {};
  for (const [k, pts] of Object.entries(series)) sliced[k] = sliceHistory(pts, range);
  return alignSeries(sliced);
}

export function alignedReturn(points, key) {
  const fake = points
    .filter((p) => p.values[key] != null)
    .map((p) => ({ date: p.date, t: p.t, close: 0, priceIndex: p.values[key], totalIndex: p.values[key] }));
  const s = historySummary(fake);
  return s ? { total: s.totalReturn, annualized: s.annualized, years: s.years } : null;
}

export function formatSignedPct(fraction, digits = 1) {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

export function parseArgs(argv) {
  const out = { force: false, limit: null, only: [], provider: null, printPrompt: null, help: false };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (a === "--force") out.force = true;
    else if (a === "--limit") out.limit = Number(args.shift());
    else if (a === "--only") out.only.push(String(args.shift() || "").trim());
    else if (a === "--provider") out.provider = String(args.shift() || "").trim();
    else if (a === "--print-prompt") out.printPrompt = String(args.shift() || "").trim();
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--") continue;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (out.limit != null && (!Number.isFinite(out.limit) || out.limit < 0)) {
    throw new Error("--limit must be a non-negative number");
  }
  return out;
}

export function envConfig(env = process.env) {
  const holdingsFile = env.LOOKTHRU_HOLDINGS_FILE || DEFAULTS.holdingsFile;
  const tickersFile =
    env.LOOKTHRU_TICKERS_FILE ||
    (holdingsFile.toLowerCase().endsWith("holdings.json")
      ? holdingsFile.slice(0, -"holdings.json".length) + "tickers.json"
      : join(dirname(holdingsFile), "tickers.json"));
  const notesDir = env.ETF_NOTES_DIR || env.LOOKTHRU_NOTES_DIR || DEFAULTS.notesDir;
  return {
    holdingsFile,
    tickersFile,
    pricesDb: env.PRICES_DB_FILE || DEFAULTS.pricesDb,
    notesDir,
    notesMd: env.ETF_NOTES_MD || join(notesDir, "etf-notes.md"),
    notesJson: env.ETF_NOTES_JSON || join(notesDir, "etf-notes.json"),
    ollamaUrl: (env.OLLAMA_URL || DEFAULTS.ollamaUrl).replace(/\/$/, ""),
    ollamaModel: env.OLLAMA_MODEL || DEFAULTS.ollamaModel,
    searchUrl: (env.SEARCH_URL || DEFAULTS.searchUrl).replace(/\/$/, ""),
    searchEngine: (env.SEARCH_ENGINE || DEFAULTS.searchEngine).toLowerCase(),
    fetchPages: env.FETCH_PAGES === "1" || env.FETCH_PAGES === "true",
    searchDelayMs: Number(env.SEARCH_DELAY_MS || DEFAULTS.searchDelayMs),
  };
}

export function loadHoldingsJson(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const funds = new Map();
  for (const [symbol, fund] of Object.entries(json.funds || {})) {
    if (!fund || !Array.isArray(fund.holdings)) continue;
    funds.set(symbol.toUpperCase(), {
      symbol: symbol.toUpperCase(),
      name: fund.name || "",
      issuer: fund.issuer || fund.provider || "",
      source: fund.source || "",
      asOf: fund.asOf || null,
      holdings: fund.holdings.map((h) => ({
        symbol: (h.symbol || "").toUpperCase(),
        name: h.name || "",
        weight: Number(h.weight),
        sector: h.sector,
        country: h.country,
      })),
    });
  }
  return funds;
}

export function loadTickersJson(path) {
  if (!path || !existsSync(path)) return new Map();
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    const map = new Map();
    for (const row of Array.isArray(json.tickers) ? json.tickers : []) {
      if (!row?.ticker) continue;
      map.set(String(row.ticker).toUpperCase(), row);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function openPricesDb(path) {
  if (!path || !existsSync(path)) return null;
  // Open read-write so a WAL sidecar (if the prefetch process is using the same file) is usable.
  return new DatabaseSync(path);
}

export function readPriceRows(db, ticker) {
  if (!db) return { prices: [], dividends: [], splits: [] };
  const prices = db
    .prepare("SELECT date, close, adjclose FROM prices WHERE ticker = ? ORDER BY date")
    .all(ticker)
    .map((r) => ({ date: r.date, close: r.close, adjclose: r.adjclose }));
  const dividends = db
    .prepare("SELECT date, amount FROM dividends WHERE ticker = ? ORDER BY date")
    .all(ticker)
    .map((r) => ({ date: r.date, amount: r.amount }));
  const splits = db
    .prepare("SELECT date, numerator, denominator FROM splits WHERE ticker = ? ORDER BY date")
    .all(ticker)
    .map((r) => ({ date: r.date, numerator: r.numerator, denominator: r.denominator }));
  return { prices, dividends, splits };
}

export function performanceFromCache(db, ticker) {
  const rows = readPriceRows(db, ticker);
  const built = buildTotalReturnPoints(rows.prices, rows.dividends, rows.splits);
  const ranges = {};
  for (const range of ["1Y", "3Y", "5Y", "MAX"]) {
    const sliced = sliceHistory(built.points, range);
    const summary = historySummary(sliced);
    ranges[range] = summary
      ? { ...summary, maxDrawdown: maxDrawdown(sliced), points: sliced.length }
      : null;
  }
  const last = built.points.at(-1);
  return {
    source: built.source,
    dividendCount: built.dividendCount,
    firstDate: built.points[0]?.date ?? null,
    lastDate: last?.date ?? null,
    ttmYield: trailingYield(rows.prices, rows.dividends, last?.date),
    ranges,
    points: built.points,
  };
}

export function topHoldings(holdings, n = 10) {
  return [...(holdings || [])]
    .filter((h) => Number.isFinite(h.weight))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((h) => ({
      symbol: h.symbol,
      displaySymbol: displaySymbol(h.symbol),
      name: h.name || displaySymbol(h.symbol),
      weight: h.weight,
    }));
}

export function resolveFundMeta(symbol, fund, tickers) {
  const t = tickers.get(symbol) || tickers.get(issuerKey(symbol));
  return {
    ticker: symbol,
    displayTicker: displaySymbol(symbol),
    name: fund.name || t?.name || displaySymbol(symbol),
    provider: fund.issuer || t?.provider || "Unknown",
    asOf: fund.asOf || "—",
    sourceUrl: fund.source && /^https?:\/\//i.test(fund.source) ? fund.source : null,
  };
}

export function formatPctList(rows, digits = 1) {
  if (!rows?.length) return "Not available.";
  return rows.map((r) => `${r.displaySymbol || r.symbol || r.name} ${formatSignedPct(r.weight, digits).replace("+", "")}`).join("; ");
}

// weights are already fractions; formatSignedPct would add + and treat as return. Use weight*100 without forcing +.
export function formatWeightList(rows, label = (r) => r.displaySymbol || r.symbol || r.name, digits = 1) {
  if (!rows?.length) return "Not available.";
  return rows.map((r) => `${label(r)} ${(r.weight * 100).toFixed(digits)}%`).join("; ");
}

export function formatReturnsBlock(perf) {
  if (!perf || !perf.points?.length) return "No price history in the local cache.";
  const lines = [];
  const labels = { "1Y": "1Y", "3Y": "3Y", "5Y": "5Y", MAX: `Since inception (${perf.firstDate})` };
  for (const key of ["1Y", "3Y", "5Y", "MAX"]) {
    const r = perf.ranges[key];
    if (!r) {
      lines.push(`${labels[key]}: not available`);
      continue;
    }
    const ann = r.annualized != null && r.years > 1 / 12 ? ` (ann. ${formatSignedPct(r.annualized)})` : "";
    const short = key !== "MAX" && r.years + 0.08 < RANGE_DAYS[key] / 365.25 ? ", shorter than the full window" : "";
    const dd = r.maxDrawdown != null ? `, max drawdown ${formatSignedPct(r.maxDrawdown)}` : "";
    lines.push(`${labels[key]}: ${formatSignedPct(r.totalReturn)}${ann}${dd}${short}`);
  }
  lines.push(`Trailing 12-month yield: ${perf.ttmYield == null ? "not available" : formatSignedPct(perf.ttmYield).replace("+", "")}`);
  if (perf.source === "price_only") lines.push("Dividend data was not in the cache; returns are price-only.");
  else if (perf.source === "adjclose" || perf.source === "dividends") {
    lines.push("Total return includes distributions reinvested when the cache has them.");
  }
  return lines.join("\n");
}

export function formatBenchmarkBlock(match) {
  if (!match) return "No benchmark matched.";
  const legs = match.def.legs.map((l) => `${l.ticker} (${l.name})`).join(" and ");
  return `${match.def.label} — ${legs}. Based on: ${match.reason}.`;
}

export function formatGapBlock(match, perf, benchPerfs) {
  if (!match || !perf?.points?.length) return "Not available.";
  const lines = [];
  const primary = match.def.legs.find((l) => l.hedge === "unhedged") || match.def.legs[0];
  const labels = { "1Y": "1Y", "3Y": "3Y", "5Y": "5Y", MAX: "Since inception" };
  for (const range of ["1Y", "3Y", "5Y", "MAX"]) {
    const series = { fund: perf.points };
    for (const leg of match.def.legs) {
      const pts = benchPerfs?.[leg.ticker]?.points;
      if (pts?.length >= 2) series[leg.ticker] = pts;
    }
    const aligned = alignRange(series, range);
    const fundRet = alignedReturn(aligned, "fund");
    const benchRet = primary ? alignedReturn(aligned, primary.ticker) : null;
    if (!fundRet || !benchRet) {
      lines.push(`${labels[range]}: not available`);
      continue;
    }
    const ptsDiff = (fundRet.total - benchRet.total) * 100;
    const sign = ptsDiff > 0 ? "+" : "";
    const ann =
      fundRet.years > 1 && fundRet.annualized != null && benchRet.annualized != null
        ? `; ann. fund ${formatSignedPct(fundRet.annualized)} vs ${displaySymbol(primary.ticker)} ${formatSignedPct(benchRet.annualized)}`
        : "";
    lines.push(
      `${labels[range]}: fund ${formatSignedPct(fundRet.total)} vs ${primary.ticker} ${formatSignedPct(benchRet.total)} (gap ${sign}${ptsDiff.toFixed(1)} pts)${ann}`,
    );
  }
  return lines.join("\n");
}

export function formatSourcesBlock(sources) {
  if (!sources?.length) return "No online sources were retrieved.";
  return sources
    .map((s) => `- ${s.title || s.url} (${s.domain})\n  ${s.url}\n  ${s.snippet || ""}`.trim())
    .join("\n");
}

export function promptsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "prompts");
}

export function loadPromptTemplate(name, dir) {
  return readFileSync(join(dir || promptsDir(), name), "utf8").replace(/^\uFEFF/, "");
}

export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null && vars[key] !== "" ? String(vars[key]) : "Not available."));
}

export function promptVarsFromPack(pack) {
  return {
    ticker: pack.ticker,
    displayTicker: pack.displayTicker,
    name: pack.name,
    provider: pack.provider,
    asOf: pack.asOf || "—",
    holdings: formatWeightList(pack.topHoldings, (r) => `${r.displaySymbol}${r.name && r.name !== r.displaySymbol ? ` (${r.name})` : ""}`),
    sectors: formatWeightList(pack.sectors, (r) => r.name),
    countries: formatWeightList(pack.countries, (r) => r.name),
    returns: formatReturnsBlock(pack.performance),
    benchmark: formatBenchmarkBlock(pack.benchmark),
    benchmarkGap: formatGapBlock(pack.benchmark, pack.performance, pack.benchmarkPerfs),
    sources: formatSourcesBlock(pack.sources),
    providerPage: pack.providerPage || "Not fetched.",
  };
}

export function renderPrompts(pack, templates) {
  const vars = promptVarsFromPack(pack);
  return {
    system: renderTemplate(templates.system, vars).trim(),
    user: renderTemplate(templates.user, vars).trim(),
    vars,
  };
}

export function stripThink(text) {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function trimSnippet(text, max = 280) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trim()}…`;
}

export function parseSearchResults(payload, engine = "searxng") {
  const rows = [];
  const obj = payload && typeof payload === "object" ? payload : {};
  let list = [];
  if (Array.isArray(obj.results)) list = obj.results;
  else if (Array.isArray(obj.items)) list = obj.items;
  else if (Array.isArray(obj.organic)) list = obj.organic;
  else if (Array.isArray(payload)) list = payload;
  for (const r of list) {
    const url = r.url || r.link || r.href;
    if (!url || typeof url !== "string") continue;
    rows.push({
      title: String(r.title || r.name || url).trim(),
      url: url.trim(),
      domain: domainOf(url),
      snippet: trimSnippet(r.content || r.snippet || r.description || r.abstract || ""),
    });
  }
  void engine;
  return rows;
}

export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./i, "");
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return String(url || "").replace(/\/$/, "").toLowerCase();
  }
}

export function mergeSearchResults(groups, perQuery = 5) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    let n = 0;
    for (const r of group) {
      const key = canonicalUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      n += 1;
      if (n >= perQuery) break;
    }
  }
  return out;
}

export function searchQueries(ticker, name, provider) {
  const tag = displaySymbol(ticker);
  const full = ticker.toUpperCase();
  const nm = (name || "").trim();
  const prov = (provider || "").trim();
  return [
    [full, nm, prov].filter(Boolean).join(" "),
    `${tag} ETF news`,
    `${tag} ETF reddit OR review OR forum`,
  ];
}

function looksLikeHtml(text, contentType = "") {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) return true;
  const head = String(text || "").slice(0, 200).trim().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<head");
}

export function interpretPreflight(status, contentType, bodyText) {
  const text = String(bodyText || "");
  if (status === 403 || (status >= 400 && looksLikeHtml(text, contentType) && status !== 404)) {
    return {
      ok: false,
      reason: "json-disabled",
      message:
        `SearXNG preflight returned HTTP ${status}${looksLikeHtml(text, contentType) ? " (HTML)" : ""}. ` +
        "JSON must be enabled in SearXNG's settings.yml (search: formats: [html, json]). Continuing without search.",
    };
  }
  if (looksLikeHtml(text, contentType)) {
    if (/market desk|lookthru|portfolio x-ray/i.test(text)) {
      return {
        ok: false,
        reason: "wrong-app",
        message:
          "The SEARCH_URL response looks like another app (for example Market Desk), not SearXNG. " +
          "Set SEARCH_URL to the SearXNG instance (default http://localhost:8099). Continuing without search.",
      };
    }
    return {
      ok: false,
      reason: "json-disabled",
      message:
        "SearXNG preflight returned HTML instead of JSON. " +
        "JSON must be enabled in SearXNG's settings.yml (search: formats: [html, json]). Continuing without search.",
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "json-disabled",
      message:
        "SearXNG preflight did not return JSON. " +
        "JSON must be enabled in SearXNG's settings.yml (search: formats: [html, json]). Continuing without search.",
    };
  }
  if (!parsed || typeof parsed !== "object" || !("results" in parsed || "items" in parsed || "organic" in parsed)) {
    return {
      ok: false,
      reason: "wrong-app",
      message:
        "The SEARCH_URL JSON does not look like SearXNG (no results list). " +
        "Set SEARCH_URL if this is the wrong app or port. Continuing without search.",
    };
  }
  return { ok: true, reason: "ok", message: "SearXNG JSON search is available." };
}

export function stripHtml(html, maxChars = DEFAULTS.providerPageChars) {
  const noScript = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return noScript.length <= maxChars ? noScript : `${noScript.slice(0, maxChars).trim()}…`;
}

export function recommendationLine(text) {
  const m = String(text || "").match(/Recommendation:\s*(Recommend|Neutral|Avoid)\b[\s\S]*$/i);
  return m ? m[0].trim() : null;
}

export function bodyWithoutRecommendation(text) {
  const cleaned = stripThink(text);
  return cleaned.replace(/\n*Recommendation:\s*(Recommend|Neutral|Avoid)\b[\s\S]*$/i, "").trim();
}

export function formatNotesMarkdown(notes, generated) {
  const groups = new Map();
  for (const n of notes) {
    const p = n.provider || "Unknown";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(n);
  }
  const providers = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const lines = ["# ETF notes", "", `Generated: ${generated}`, ""];
  for (const provider of providers) {
    lines.push(`## ${provider}`, "");
    const funds = groups.get(provider).slice().sort((a, b) => a.ticker.localeCompare(b.ticker));
    for (const n of funds) {
      lines.push(`### ${n.displayTicker || displaySymbol(n.ticker)} — ${n.name}`, "", n.text.trim(), "");
      if (n.sources?.length) {
        lines.push("Sources:");
        for (const s of n.sources) lines.push(`- ${s.url}`);
        lines.push("");
      }
    }
  }
  return lines.join("\n").trim() + "\n";
}

export function loadNotesJson(path) {
  if (!existsSync(path)) return { generated: null, funds: [] };
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    const funds = Array.isArray(json.funds) ? json.funds : Array.isArray(json) ? json : [];
    return { generated: json.generated ?? null, funds };
  } catch {
    return { generated: null, funds: [] };
  }
}

export function upsertNote(existing, note) {
  const funds = existing.funds.filter((f) => f.ticker !== note.ticker);
  funds.push(note);
  funds.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { generated: note.generated, funds };
}

export function writeNotes(paths, store) {
  mkdirSync(dirname(paths.notesJson), { recursive: true });
  mkdirSync(dirname(paths.notesMd), { recursive: true });
  writeFileSync(paths.notesJson, `${JSON.stringify(store, null, 2)}\n`);
  writeFileSync(paths.notesMd, formatNotesMarkdown(store.funds, store.generated));
}

export function holdingsLookupFromMap(funds) {
  return (symbol) => {
    const key = String(symbol || "").toUpperCase();
    const hit = funds.get(key) || funds.get(`${issuerKey(key)}.TO`) || [...funds.values()].find((f) => issuerKey(f.symbol) === issuerKey(key));
    return hit?.holdings ?? null;
  };
}

export function listFunds(funds, tickers, opts) {
  let list = [...funds.values()];
  if (opts.only?.length) {
    const want = new Set(opts.only.map((s) => s.toUpperCase()));
    list = list.filter((f) => want.has(f.symbol) || want.has(issuerKey(f.symbol)) || want.has(displaySymbol(f.symbol)));
  }
  if (opts.provider) {
    const p = opts.provider.toLowerCase();
    list = list.filter((f) => {
      const meta = resolveFundMeta(f.symbol, f, tickers);
      return meta.provider.toLowerCase().includes(p);
    });
  }
  list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (opts.limit != null) list = list.slice(0, opts.limit);
  return list;
}

export async function timedFetch(url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function preflightSearch(cfg, fetcher = timedFetch) {
  if (!cfg.searchUrl) {
    return { ok: false, reason: "unset", message: "SEARCH_URL is unset. Continuing without search." };
  }
  const url = `${cfg.searchUrl}/search?${new URLSearchParams({ q: "test", format: "json" })}`;
  try {
    const res = await fetcher(url, { headers: { Accept: "application/json,text/html;q=0.8" } }, DEFAULTS.searchTimeoutMs);
    const text = await res.text();
    return interpretPreflight(res.status, res.headers.get("content-type") || "", text);
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      message: `SearXNG preflight failed (${err instanceof Error ? err.message : String(err)}). Continuing without search.`,
    };
  }
}

export async function collectSearch(cfg, ticker, name, provider, fetcher = timedFetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const queries = searchQueries(ticker, name, provider);
  const groups = [];
  for (let i = 0; i < queries.length; i++) {
    if (i > 0 && cfg.searchDelayMs > 0) await sleep(cfg.searchDelayMs);
    const q = queries[i];
    const url =
      cfg.searchEngine === "whoogle"
        ? `${cfg.searchUrl}/search?${new URLSearchParams({ q })}`
        : `${cfg.searchUrl}/search?${new URLSearchParams({ q, format: "json" })}`;
    try {
      const res = await fetcher(url, { headers: { Accept: "application/json,text/html;q=0.8" } }, DEFAULTS.searchTimeoutMs);
      const text = await res.text();
      let payload = text;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
      const rows = parseSearchResults(payload, cfg.searchEngine).slice(0, 5);
      groups.push(rows);
    } catch {
      groups.push([]);
    }
  }
  return { queries, results: mergeSearchResults(groups, 5) };
}

export async function fetchProviderPage(url, fetcher = timedFetch, maxChars = DEFAULTS.providerPageChars) {
  if (!url) return null;
  try {
    const res = await fetcher(url, { headers: { Accept: "text/html,application/xhtml+xml" } }, DEFAULTS.searchTimeoutMs);
    if (!res.ok) return null;
    return stripHtml(await res.text(), maxChars);
  } catch {
    return null;
  }
}

export async function callOllama(cfg, system, user, fetcher = timedFetch) {
  const res = await fetcher(
    `${cfg.ollamaUrl}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: cfg.ollamaModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        think: false,
      }),
    },
    DEFAULTS.ollamaTimeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const json = await res.json();
  const content = json?.message?.content ?? json?.response ?? "";
  return stripThink(content);
}

export function buildFundPack(fund, funds, tickers, db) {
  const meta = resolveFundMeta(fund.symbol, fund, tickers);
  const lookup = holdingsLookupFromMap(funds);
  const match = matchBenchmark(fund.symbol, fund.holdings, { lookup, name: meta.name });
  const performance = performanceFromCache(db, fund.symbol);
  const benchmarkPerfs = {};
  for (const leg of match.def.legs) benchmarkPerfs[leg.ticker] = performanceFromCache(db, leg.ticker);
  const leaves = flattenHoldings(fund.holdings, lookup);
  const exp = measureExposure(leaves, nasdaqConstituents(lookup));
  return {
    ...meta,
    asOf: meta.asOf,
    sourceUrl: meta.sourceUrl,
    topHoldings: topHoldings(fund.holdings, 10),
    sectors: exp.sectors,
    countries: exp.countries,
    benchmark: match,
    benchmarkPerfs,
    performance,
  };
}

export const HELP = `Usage: npm run etf-notes -- [options]

  --force            Redo funds that already have a note
  --limit N          Process at most N funds (after filters)
  --only TICKER      Only this ticker (repeatable)
  --provider NAME    Only funds whose provider matches NAME
  --print-prompt T   Print the rendered prompts for T and exit (no Ollama call)
  --help             Show this help

Reads holdings.json, prices.sqlite and optional tickers.json. Writes
etf-notes.md and etf-notes.json (never committed). Nothing is posted.
`;
