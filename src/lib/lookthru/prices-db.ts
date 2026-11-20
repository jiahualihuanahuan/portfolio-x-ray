import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Local SQLite cache of Yahoo daily prices, dividends and splits. Never committed. */
export const DEFAULT_PRICES_DB_FILE = "/data/lookthru/prices.sqlite";
export const STALE_AFTER_MS = 20 * 60 * 60 * 1000;

export type TickerStatus = "ok" | "error" | "empty";

export type TickerMeta = {
  ticker: string;
  lastFetched: number | null;
  firstDate: string | null;
  lastDate: string | null;
  status: TickerStatus;
  error: string | null;
};

export type PriceRow = {
  ticker: string;
  date: string;
  close: number | null;
  adjclose: number | null;
};

export type DividendRow = { ticker: string; date: string; amount: number };
export type SplitRow = { ticker: string; date: string; numerator: number; denominator: number };

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS ticker_meta (
  ticker TEXT PRIMARY KEY,
  last_fetched INTEGER,
  first_date TEXT,
  last_date TEXT,
  status TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS prices (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL,
  adjclose REAL,
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
`;

let db: DatabaseSync | null = null;
let openPath: string | null = null;

export function pricesDbPath(path?: string): string {
  return path || process.env["PRICES_DB_FILE"] || DEFAULT_PRICES_DB_FILE;
}

export function getPricesDb(path?: string): DatabaseSync {
  const file = pricesDbPath(path);
  if (db && openPath === file) return db;
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
    openPath = null;
  }
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const next = new DatabaseSync(file);
  next.exec(SCHEMA);
  db = next;
  openPath = file;
  return next;
}

export function closePricesDb(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
  openPath = null;
}


function withTx(database: DatabaseSync, fn: () => void): void {
  database.exec("BEGIN");
  try {
    fn();
    database.exec("COMMIT");
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function getTickerMeta(ticker: string, path?: string): TickerMeta | null {
  const row = getPricesDb(path)
    .prepare("SELECT ticker, last_fetched, first_date, last_date, status, error FROM ticker_meta WHERE ticker = ?")
    .get(ticker) as
    | { ticker: string; last_fetched: number | null; first_date: string | null; last_date: string | null; status: string; error: string | null }
    | undefined;
  if (!row) return null;
  const status: TickerStatus = row.status === "ok" || row.status === "error" || row.status === "empty" ? row.status : "error";
  return {
    ticker: row.ticker,
    lastFetched: num(row.last_fetched),
    firstDate: str(row.first_date),
    lastDate: str(row.last_date),
    status,
    error: str(row.error),
  };
}

export function listTickerMeta(path?: string): TickerMeta[] {
  const rows = getPricesDb(path)
    .prepare("SELECT ticker, last_fetched, first_date, last_date, status, error FROM ticker_meta")
    .all() as Array<{
    ticker: string;
    last_fetched: number | null;
    first_date: string | null;
    last_date: string | null;
    status: string;
    error: string | null;
  }>;
  return rows.map((row) => ({
    ticker: row.ticker,
    lastFetched: num(row.last_fetched),
    firstDate: str(row.first_date),
    lastDate: str(row.last_date),
    status: (row.status === "ok" || row.status === "error" || row.status === "empty" ? row.status : "error") as TickerStatus,
    error: str(row.error),
  }));
}

export function upsertTickerMeta(meta: TickerMeta, path?: string): void {
  getPricesDb(path)
    .prepare(
      `INSERT INTO ticker_meta (ticker, last_fetched, first_date, last_date, status, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         last_fetched = excluded.last_fetched,
         first_date = excluded.first_date,
         last_date = excluded.last_date,
         status = excluded.status,
         error = excluded.error`,
    )
    .run(meta.ticker, meta.lastFetched, meta.firstDate, meta.lastDate, meta.status, meta.error);
}

export function upsertPrices(rows: PriceRow[], path?: string): void {
  if (!rows.length) return;
  const database = getPricesDb(path);
  const stmt = database.prepare(
    `INSERT INTO prices (ticker, date, close, adjclose) VALUES (?, ?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET close = excluded.close, adjclose = excluded.adjclose`,
  );
  withTx(database, () => {
    for (const r of rows) stmt.run(r.ticker, r.date, r.close, r.adjclose);
  });
}

export function upsertDividends(rows: DividendRow[], path?: string): void {
  if (!rows.length) return;
  const database = getPricesDb(path);
  const stmt = database.prepare(
    `INSERT INTO dividends (ticker, date, amount) VALUES (?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET amount = excluded.amount`,
  );
  withTx(database, () => {
    for (const r of rows) stmt.run(r.ticker, r.date, r.amount);
  });
}

export function upsertSplits(rows: SplitRow[], path?: string): void {
  if (!rows.length) return;
  const database = getPricesDb(path);
  const stmt = database.prepare(
    `INSERT INTO splits (ticker, date, numerator, denominator) VALUES (?, ?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET numerator = excluded.numerator, denominator = excluded.denominator`,
  );
  withTx(database, () => {
    for (const r of rows) stmt.run(r.ticker, r.date, r.numerator, r.denominator);
  });
}

export function getPrices(ticker: string, path?: string): PriceRow[] {
  return getPricesDb(path)
    .prepare("SELECT ticker, date, close, adjclose FROM prices WHERE ticker = ? ORDER BY date")
    .all(ticker) as PriceRow[];
}

export function getDividends(ticker: string, path?: string): DividendRow[] {
  return getPricesDb(path)
    .prepare("SELECT ticker, date, amount FROM dividends WHERE ticker = ? ORDER BY date")
    .all(ticker) as DividendRow[];
}

export function getSplits(ticker: string, path?: string): SplitRow[] {
  return getPricesDb(path)
    .prepare("SELECT ticker, date, numerator, denominator FROM splits WHERE ticker = ? ORDER BY date")
    .all(ticker) as SplitRow[];
}

export function priceDateRange(ticker: string, path?: string): { firstDate: string | null; lastDate: string | null; count: number } {
  const row = getPricesDb(path)
    .prepare("SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS count FROM prices WHERE ticker = ? AND close IS NOT NULL")
    .get(ticker) as { first_date: string | null; last_date: string | null; count: number };
  return { firstDate: str(row.first_date), lastDate: str(row.last_date), count: Number(row.count) || 0 };
}

/** True when the ticker has never been fetched, or last_fetched is older than ~20 hours. */
export function isTickerStale(meta: TickerMeta | null, now = Date.now(), maxAgeMs = STALE_AFTER_MS): boolean {
  if (!meta || meta.lastFetched == null) return true;
  return now - meta.lastFetched > maxAgeMs;
}

export function hasCachedPrices(ticker: string, path?: string): boolean {
  const row = getPricesDb(path)
    .prepare("SELECT 1 AS ok FROM prices WHERE ticker = ? AND close IS NOT NULL LIMIT 1")
    .get(ticker) as { ok: number } | undefined;
  return Boolean(row);
}
