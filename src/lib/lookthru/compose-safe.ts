import { prepareCad, type ConfirmationItem, type ListingInfo, type PositionCurrency } from "./currency.ts";
import { FX_UNAVAILABLE, FxUnavailableError } from "./fx.ts";
import { composeLookthrough } from "./lookthrough.ts";
import { applyAlias, normalizeTicker } from "./tickers.ts";
import type { Instrument, LookthroughResult, Position } from "./types.ts";

export type Analysis = {
  instruments: Record<string, Instrument>;
  aliases: Record<string, string>;
  fxUsdCad: number | null;
  fxError?: string | null;
  warnings: string[];
  listings?: Record<string, ListingInfo>;
};

export type CadComposition =
  | { result: LookthroughResult; error: null; excluded: ConfirmationItem[]; byPosition: Record<string, PositionCurrency> }
  | { result: null; error: string; excluded: ConfirmationItem[]; byPosition: Record<string, PositionCurrency> };

export const CURRENCY_KEYS = { listingKey: normalizeTicker, aliasKey: applyAlias };

/**
 * Run the (unchanged) look-through engine in CAD. USD rows are converted at their price-date rate,
 * CDR/.NE/.UN rows stay CAD, and rows that need a currency confirmation are left out of every total
 * (returned in `excluded`). A USD row with no rate gives an error instead of a guessed rate.
 */
export function composeCad(positions: Position[], analysis: Analysis): CadComposition {
  const prep = prepareCad(positions, analysis, CURRENCY_KEYS);
  try {
    const result = composeLookthrough(prep.positions, prep.instruments, prep.aliases, analysis.fxUsdCad, "CAD", analysis.warnings);
    // Show the ticker you typed (HYLD.U, IBIT) even when it was priced through another listing.
    const typed = new Map(positions.map((p) => [p.id, p.ticker]));
    for (const v of result.positions) v.ticker = typed.get(v.id) ?? v.ticker;
    return { result, error: null, excluded: prep.excluded, byPosition: prep.byPosition };
  } catch (e) {
    if (e instanceof FxUnavailableError) {
      return { result: null, error: analysis.fxError || FX_UNAVAILABLE, excluded: prep.excluded, byPosition: prep.byPosition };
    }
    throw e;
  }
}

/**
 * Single-ETF view: value the fund at `amount` CAD. Runs the engine once with 1 share to learn the
 * CAD price, then again with amount / price shares, so every look-through line is in CAD dollars.
 */
export function composeEtfCad(ticker: string, amount: number, analysis: Analysis): CadComposition {
  const one = composeCad([{ id: "etf", ticker, shares: 1 }], analysis);
  if (!one.result) return one;
  const price = one.result.nav;
  if (!(price > 0) || !(amount > 0)) return one;
  return composeCad([{ id: "etf", ticker, shares: amount / price }], analysis);
}
