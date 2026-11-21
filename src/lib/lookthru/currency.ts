/**
 * Which currency a pasted holding trades in, and how it becomes CAD. Pure functions (unit-tested).
 *
 * Rules, in order:
 *  1. CDRs and Canadian trust units are CAD, never converted, never flagged: `.NE` (Cboe Canada, where
 *     CDRs such as AAPL.NE list), `.UN` (KO.UN as Jenny writes CDRs; REI.UN-style REIT/trust units),
 *     anything in the CDR mapping file, and quotes whose name says "CDR". The underlying US ticker is
 *     attached for identification only, and only for known CDRs (mapping file or "CDR" in the name).
 *  2. A currency you declared (pasted Currency column, US exchange, a trailing "USD"/"CAD", or a
 *     confirmation in the app).
 *  3. Ticker suffix: `.U` / `-U` (optionally `.TO`/`.NE`) = USD units of a Canadian ETF; `-USD` crypto = USD;
 *     `.TO` / `.V` / `.CN` = CAD unless the price data says USD.
 *  4. Bare tickers (AAPL, IBIT) are USD when only a US listing exists. If a Canadian listing of the same
 *     symbol also exists (X.TO / X.NE), the currency is ambiguous and needs your confirmation.
 * Rows that need confirmation (ambiguous, a USD-looking ticker with no quote, no USD→CAD rate for the
 * price date, or a currency other than CAD/USD) are excluded from every total and from rebalancing.
 */
import type { Instrument, Position } from "./types.ts";

export type Ccy = "CAD" | "USD";

export type FxPoint = { rate: number; date: string; source: "manual" | "prices-db" | "cache"; exact: boolean };

export type ListingInfo = {
  /** Resolved Yahoo symbol, or null when no quote was found. */
  symbol: string | null;
  /** Currency reported by the price data. */
  quoteCurrency: string | null;
  /** Trading date of the price (Toronto), YYYY-MM-DD. */
  priceDate: string | null;
  name: string | null;
  /** Bare tickers only: a Canadian (CAD) listing of the same symbol, e.g. "AAPL.NE". */
  cadListing: string | null;
  /** Known CDR: the underlying US ticker (identification only). */
  cdrUnderlying: string | null;
  /** USD→CAD rate for priceDate (manual override → prices.sqlite on/before → json cache), or null. */
  fx: FxPoint | null;
  /** Price of `symbol` in `quoteCurrency` (for USD units this is the USD listing, not the CAD fund). */
  price?: number | null;
};

export type FlagKind = "ambiguous" | "unknown-usd" | "no-rate" | "unsupported" | "mismatch";

export type CurrencyFlag = { kind: FlagKind; message: string; cadListing?: string | null };

export type CurrencyDecision = {
  currency: Ccy | null;
  basis: "cdr" | "declared" | "suffix" | "quote" | "none";
  cdrUnderlying: string | null;
  flag: CurrencyFlag | null;
  /** Listing to price the position with when it differs from the typed ticker (e.g. declared CAD → X.NE). */
  useListing?: string;
};

const up = (s: string) => s.trim().toUpperCase();

/** `.NE`, `.NEO` and `.UN` are always CAD (CDRs, trust units). */
export function isForcedCad(ticker: string): boolean {
  return /\.(NE|NEO)$/.test(up(ticker)) || /[.-]UN(\.(TO|NE|V))?$/.test(up(ticker));
}

/** Currency implied by the ticker alone, or null for a bare ticker. */
export function suffixCurrency(ticker: string): Ccy | null {
  const t = up(ticker);
  if (isForcedCad(t)) return "CAD";
  if (/[.-]U(\.(TO|NE|V))?$/.test(t)) return "USD";
  if (/-USD$/.test(t) || /^[A-Z]{3}USD=X$/.test(t)) return "USD";
  if (/\.(TO|V|CN)$/.test(t)) return "CAD";
  return null;
}

export function isBareTicker(ticker: string): boolean {
  const t = up(ticker);
  return /^[A-Z][A-Z0-9]{0,5}$/.test(t) || /^[A-Z]{1,5}[.-][A-Z]$/.test(t) && !/[.-]U$/.test(t);
}

export function decideCurrency(ticker: string, declared: Ccy | undefined, info: ListingInfo | undefined, aliased?: string): CurrencyDecision {
  const t = up(ticker);
  // Aliases that point at trust units (BIP-U → BIP.UN.TO) count as .UN.
  const aliasCad = aliased ? /[.-]UN(\.(TO|NE|V))?$/.test(up(aliased)) : false;
  const quoteCcy = info?.quoteCurrency ? up(info.quoteCurrency) : null;
  const cdrByName = Boolean(info?.name && /\bCDR\b/i.test(info.name));
  const cdrUnderlying = info?.cdrUnderlying ?? null;

  // 1. CDRs / trust units / .NE: CAD, no conversion, never flagged.
  if (isForcedCad(t) || aliasCad || cdrUnderlying || (cdrByName && quoteCcy !== "USD")) {
    return { currency: "CAD", basis: "cdr", cdrUnderlying, flag: null };
  }

  const finish = (currency: Ccy, basis: CurrencyDecision["basis"], useListing?: string): CurrencyDecision => {
    if (currency === "USD" && !info?.symbol) {
      return {
        currency: null,
        basis,
        cdrUnderlying: null,
        flag: { kind: "unknown-usd", message: `${t} looks like a USD product but no matching ticker or price was found. Fix the ticker.` },
      };
    }
    if (currency === "USD" && !info?.fx) {
      return {
        currency: null,
        basis,
        cdrUnderlying: null,
        flag: {
          kind: "no-rate",
          message: `No USD→CAD rate on or before ${info?.priceDate ?? "the price date"} (prices.sqlite, the saved rate and FX_USDCAD_OVERRIDE are all empty).`,
        },
      };
    }
    return { currency, basis, cdrUnderlying: null, flag: null, useListing };
  };

  // 2. Declared by you.
  if (declared) {
    if (declared === "CAD" && quoteCcy === "USD" && !suffixCurrency(t)) {
      if (info?.cadListing) return finish("CAD", "declared", info.cadListing);
      return {
        currency: null,
        basis: "declared",
        cdrUnderlying: null,
        flag: { kind: "mismatch", message: `${t} is marked CAD but only a USD listing was found. Fix the ticker (e.g. add .TO or .NE).` },
      };
    }
    if (declared === "USD" && quoteCcy === "CAD") {
      return {
        currency: null,
        basis: "declared",
        cdrUnderlying: null,
        flag: { kind: "mismatch", message: `${t} is marked USD but its price is quoted in CAD. Fix the ticker (USD units usually end in .U).` },
      };
    }
    return finish(declared, "declared");
  }

  // 3. Suffix.
  const sfx = suffixCurrency(t);
  if (sfx === "USD") return finish("USD", "suffix");
  if (sfx === "CAD") {
    if (quoteCcy === "USD") return finish("USD", "quote");
    return { currency: "CAD", basis: "suffix", cdrUnderlying: null, flag: null };
  }

  // 4. Bare ticker.
  if (!info?.symbol) {
    if (isBareTicker(t)) return finish("USD", "none");
    return { currency: null, basis: "none", cdrUnderlying: null, flag: null };
  }
  if (quoteCcy && quoteCcy !== "CAD" && quoteCcy !== "USD") {
    return { currency: null, basis: "quote", cdrUnderlying: null, flag: { kind: "unsupported", message: `${t} is priced in ${quoteCcy}; only CAD and USD are supported.` } };
  }
  if (quoteCcy === "USD" && info.cadListing) {
    return {
      currency: null,
      basis: "none",
      cdrUnderlying: null,
      flag: {
        kind: "ambiguous",
        message: `${t} trades in USD (US listing) and in CAD (${info.cadListing}). Which one do you hold?`,
        cadListing: info.cadListing,
      },
    };
  }
  return finish(quoteCcy === "CAD" ? "CAD" : "USD", "quote");
}

/** Most recent rate on or before `date` from date-sorted or unsorted rows. */
export function fxOnOrBefore(rows: { date: string; close: number | null }[], date: string): { rate: number; date: string; exact: boolean } | null {
  let best: { rate: number; date: string } | null = null;
  for (const r of rows) {
    if (r.close == null || !Number.isFinite(r.close) || r.close <= 0) continue;
    if (r.date > date) continue;
    if (!best || r.date > best.date) best = { rate: r.close < 1 ? 1 / r.close : r.close, date: r.date };
  }
  return best ? { ...best, exact: best.date === date } : null;
}

/**
 * One source of truth for USD→CAD on a date: FX_USDCAD_OVERRIDE (manual, explicit) → prices.sqlite
 * USDCAD=X on or before the date → the saved fx-usdcad.json rate if it is dated on or before → null.
 */
export function resolveFxForDate(
  date: string,
  sources: { override: number | null; dbRows: { date: string; close: number | null }[]; cached: { rate: number; date: string } | null },
): FxPoint | null {
  if (sources.override != null) return { rate: sources.override, date, source: "manual", exact: true };
  const db = fxOnOrBefore(sources.dbRows, date);
  if (db) return { ...db, source: "prices-db" };
  if (sources.cached && sources.cached.date <= date) {
    return { rate: sources.cached.rate, date: sources.cached.date, source: "cache", exact: sources.cached.date === date };
  }
  return null;
}

export type ConfirmationItem = { id: string; ticker: string; shares: number; flag: CurrencyFlag };

export type PositionCurrency = { currency: Ccy; basis: CurrencyDecision["basis"]; fx: FxPoint | null; cdrUnderlying: string | null; nativePrice: number | null };

export type PreparedCad = {
  positions: Position[];
  instruments: Record<string, Instrument>;
  aliases: Record<string, string>;
  excluded: ConfirmationItem[];
  byPosition: Record<string, PositionCurrency>;
};

/**
 * Turn the server's analysis into CAD-only inputs for the (unchanged) look-through engine: USD
 * instruments get CAD prices at their price-date rate, CDR/.NE/.UN stay CAD, and rows that need
 * confirmation are taken out (listed in `excluded`). CAD rows pass through untouched.
 * `listingKey` normalizes a typed ticker (server listing keys); `aliasKey` is the engine's alias key.
 */
export function prepareCad(
  positions: Position[],
  analysis: { instruments: Record<string, Instrument>; aliases: Record<string, string>; listings?: Record<string, ListingInfo> },
  keys: { listingKey: (t: string) => string; aliasKey: (t: string) => string },
): PreparedCad {
  const instruments: Record<string, Instrument> = { ...analysis.instruments };
  const aliases: Record<string, string> = { ...analysis.aliases };
  const kept: Position[] = [];
  const excluded: ConfirmationItem[] = [];
  const byPosition: Record<string, PositionCurrency> = {};
  const relabel = new Map<string, Instrument>();

  const instFor = (t: string | null | undefined) => {
    if (!t) return undefined;
    const sym = aliases[keys.aliasKey(t)] ?? t;
    return instruments[sym] ?? analysis.instruments[t];
  };

  for (const pos of positions) {
    const info = analysis.listings?.[keys.listingKey(pos.ticker)];
    if (!info) {
      kept.push(pos); // synthetic rows or an older server: unchanged behaviour
      continue;
    }
    const d = decideCurrency(pos.ticker, pos.currency, info, keys.aliasKey(pos.ticker));
    if (d.flag) {
      excluded.push({ id: pos.id, ticker: pos.ticker, shares: pos.shares, flag: d.flag });
      continue;
    }
    if (!d.currency) {
      kept.push(pos); // unresolved non-USD-looking ticker: the existing "Unresolved" note handles it
      continue;
    }
    let row: Position = pos;
    let inst = instFor(pos.ticker);
    if (d.useListing) {
      const alt = instFor(d.useListing);
      if (!alt || alt.price == null) {
        excluded.push({ id: pos.id, ticker: pos.ticker, shares: pos.shares, flag: { kind: "mismatch", message: `${pos.ticker}: no price for ${d.useListing}. Fix the ticker.` } });
        continue;
      }
      row = { ...pos, ticker: d.useListing };
      inst = alt;
    }
    let nativePrice = inst?.price ?? null;
    if (d.currency === "USD") {
      const fx = info.fx!;
      const usdPrice = (info.quoteCurrency ?? "").toUpperCase() === "USD" && info.price != null ? info.price : inst?.price ?? null;
      nativePrice = usdPrice;
      if (inst && usdPrice != null && info.symbol && info.symbol !== inst.symbol) {
        // USD units of a CAD fund (HYLD.U): own CAD-priced instrument, same holdings as the fund.
        const key = `${info.symbol}#USD`; // own key: never collides with the CAD fund or its aliases
        instruments[key] = { ...inst, symbol: key, displaySymbol: key, price: usdPrice * fx.rate, currency: "CAD", priceDate: info.priceDate ?? undefined };
        aliases[keys.aliasKey(key)] = key;
        row = { ...row, ticker: key };
      } else if (inst && inst.price != null && (inst.currency || "").toUpperCase() !== "CAD") {
        relabel.set(inst.symbol, relabel.get(inst.symbol) ?? { ...inst, price: inst.price * fx.rate, currency: "CAD" });
      }
    } else if (inst && (inst.currency || "").toUpperCase() !== "CAD") {
      // CDR / .NE / .UN or declared CAD: the quote already is the CAD value; relabel, don't convert.
      relabel.set(inst.symbol, relabel.get(inst.symbol) ?? { ...inst, currency: "CAD" });
    }
    byPosition[pos.id] = { currency: d.currency, basis: d.basis, fx: d.currency === "USD" ? info.fx : null, cdrUnderlying: d.cdrUnderlying, nativePrice };
    kept.push(row);
  }
  if (relabel.size) {
    for (const [k, v] of Object.entries(instruments)) {
      const c = relabel.get(v.symbol);
      if (c) instruments[k] = c;
    }
  }
  return { positions: kept, instruments, aliases, excluded, byPosition };
}

/** Wealthsimple/Questrade exchange or MIC → currency (US venues are USD). */
export function exchangeCurrency(exchange: string, mic = ""): Ccy | null {
  const ex = exchange.toUpperCase();
  const m = mic.toUpperCase();
  if (/TSX|CBOE CANADA|NEO|CSE/.test(ex) || ["XTSE", "XTSX", "NEOE", "XCNQ"].includes(m)) return "CAD";
  if (/NYSE|NASDAQ|ARCA|BATS|AMEX|CBOE BZX|OTC/.test(ex) || ["XNYS", "XNAS", "ARCX", "BATS", "XASE", "OTCM"].includes(m)) return "USD";
  return null;
}

export function parseCcy(text: string | undefined | null): Ccy | undefined {
  const t = (text ?? "").trim().toUpperCase();
  return t === "CAD" || t === "USD" ? t : undefined;
}
