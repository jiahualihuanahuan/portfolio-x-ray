import { applyAlias, normalizeTicker } from "./tickers.ts";
import type { LookthroughResult } from "./types.ts";

/**
 * Target & rebalance math. Pure functions, no I/O, so they are unit-tested.
 *
 * - A target is a CAD amount for one ticker or one sector (the whole app reports in CAD).
 * - Ticker targets are compared with the value of the position you hold directly in that
 *   ticker (what you can actually buy or sell). Sector targets are compared with the
 *   look-through sector value (the same numbers as the Full portfolio sector mix).
 * - Deviation is relative: |actual − target| / target. A target of 0 with any holding
 *   counts as an infinite deviation.
 * - A row "breaches" when deviation > threshold (default 10%). Only breached rows get a
 *   suggested trade, sized to bring that row back to exactly its target.
 * - "rebalance" mode: sell overweight rows, buy underweight rows.
 *   "buy-only" mode: buy underweight rows with new cash; overweight rows are left alone.
 * - Ticker and sector targets are evaluated separately; nothing decides which wins.
 */

export type TargetKind = "ticker" | "sector";
export type RebalanceMode = "rebalance" | "buy-only";

export type Target = {
  id: string;
  kind: TargetKind;
  /** Ticker (e.g. HYLD.TO) or sector name (e.g. Financials). */
  key: string;
  /** Target amount in CAD. */
  amount: number;
};

export type TradeAction = "buy" | "sell" | "hold";

export type RebalanceRow = {
  id: string;
  kind: TargetKind;
  key: string;
  target: number;
  actual: number;
  /** actual − target (positive = overweight). */
  diff: number;
  /** |diff| / target; Infinity when target is 0 and actual ≠ 0; 0 when both are 0. */
  deviation: number;
  breached: boolean;
  action: TradeAction;
  /** Suggested trade size (always ≥ 0). */
  tradeAmount: number;
  /** True when the row is overweight but buy-only mode suppressed the sell. */
  sellSkipped: boolean;
};

export type RebalanceSummary = {
  rows: RebalanceRow[];
  breaches: number;
  totalBuy: number;
  totalSell: number;
  /** Buys minus sells. Positive = new cash needed; negative = cash freed. */
  netCash: number;
};

export const DEFAULT_THRESHOLD = 0.1;

export function relativeDeviation(actual: number, target: number): number {
  const diff = actual - target;
  if (target === 0) return diff === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(diff) / Math.abs(target);
}

export function evaluateRow(
  id: string,
  kind: TargetKind,
  key: string,
  target: number,
  actual: number,
  threshold: number,
  mode: RebalanceMode,
): RebalanceRow {
  const diff = actual - target;
  const deviation = relativeDeviation(actual, target);
  // Tiny epsilon so 10.0000001% from float noise doesn't flip an exact-10% row.
  const breached = deviation > threshold + 1e-9;
  let action: TradeAction = "hold";
  let tradeAmount = 0;
  let sellSkipped = false;
  if (breached) {
    if (diff < 0) {
      action = "buy";
      tradeAmount = -diff;
    } else if (diff > 0) {
      if (mode === "rebalance") {
        action = "sell";
        tradeAmount = diff;
      } else {
        sellSkipped = true;
      }
    }
  }
  return { id, kind, key, target, actual, diff, deviation, breached, action, tradeAmount, sellSkipped };
}

export function summarize(rows: RebalanceRow[]): RebalanceSummary {
  const totalBuy = rows.filter((r) => r.action === "buy").reduce((s, r) => s + r.tradeAmount, 0);
  const totalSell = rows.filter((r) => r.action === "sell").reduce((s, r) => s + r.tradeAmount, 0);
  return {
    rows,
    breaches: rows.filter((r) => r.breached).length,
    totalBuy,
    totalSell,
    netCash: totalBuy - totalSell,
  };
}

/** Key used to match a target ticker with a held position (aliases and class shares fold). */
export function tickerKey(t: string): string {
  return applyAlias(normalizeTicker(t));
}

export function normalizeSector(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Value of each directly held ticker, in the result's currency. */
export function actualByTicker(result: LookthroughResult | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of result?.positions ?? []) {
    const k = tickerKey(p.ticker);
    out.set(k, (out.get(k) ?? 0) + p.value);
  }
  return out;
}

/** Look-through value of each sector (lower-cased key), in the result's currency. */
export function actualBySector(result: LookthroughResult | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of result?.sectors ?? []) {
    const k = normalizeSector(s.name);
    out.set(k, (out.get(k) ?? 0) + s.value);
  }
  return out;
}

/** Evaluate CAD targets of one kind against CAD actuals from the look-through. */
export function computeRebalance(
  targets: Target[],
  kind: TargetKind,
  actuals: Map<string, number>,
  opts: { threshold: number; mode: RebalanceMode },
): RebalanceSummary {
  const rows = targets
    .filter((t) => t.kind === kind)
    .map((t) => {
      const key = kind === "ticker" ? tickerKey(t.key) : normalizeSector(t.key);
      const target = t.amount;
      const actual = actuals.get(key) ?? 0;
      return evaluateRow(t.id, kind, t.key, target, actual, opts.threshold, opts.mode);
    });
  return summarize(rows);
}

/** Parse a threshold typed as a percent ("10" → 0.1). Falls back to the default. */
export function parseThresholdPct(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_THRESHOLD;
  return n / 100;
}
