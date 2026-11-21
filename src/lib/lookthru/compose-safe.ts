import { FX_UNAVAILABLE, FxUnavailableError } from "./fx.ts";
import { composeLookthrough } from "./lookthrough.ts";
import type { Instrument, LookthroughResult, Position } from "./types.ts";

export type Analysis = {
  instruments: Record<string, Instrument>;
  aliases: Record<string, string>;
  fxUsdCad: number | null;
  fxError?: string | null;
  warnings: string[];
};

/**
 * Run the (unchanged) look-through engine in CAD. If a USD-priced holding needs converting and no
 * USD→CAD rate exists, return an error instead of guessing a rate.
 */
export function composeCad(
  positions: Position[],
  analysis: Analysis,
): { result: LookthroughResult; error: null } | { result: null; error: string } {
  try {
    return {
      result: composeLookthrough(positions, analysis.instruments, analysis.aliases, analysis.fxUsdCad, "CAD", analysis.warnings),
      error: null,
    };
  } catch (e) {
    if (e instanceof FxUnavailableError) return { result: null, error: analysis.fxError || FX_UNAVAILABLE };
    throw e;
  }
}

/**
 * Single-ETF view: value the fund at `amount` CAD. Runs the engine once with 1 share to learn the
 * CAD price, then again with amount / price shares, so every look-through line is in CAD dollars.
 */
export function composeEtfCad(
  ticker: string,
  amount: number,
  analysis: Analysis,
): { result: LookthroughResult; error: null } | { result: null; error: string } {
  const one = composeCad([{ id: "etf", ticker, shares: 1 }], analysis);
  if (!one.result) return one;
  const price = one.result.nav;
  if (!(price > 0) || !(amount > 0)) return one;
  return composeCad([{ id: "etf", ticker, shares: amount / price }], analysis);
}
