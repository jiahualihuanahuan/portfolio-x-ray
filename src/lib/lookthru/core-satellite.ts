/**
 * Core–satellite bucket model with minimal-transaction rebalancing. Pure functions (unit-tested).
 *
 * - One optional CORE bucket with an acceptable range of the model total (e.g. 54–66%, midpoint 60%).
 * - SATELLITE buckets, each with a target % and an optional relative band; without one the global
 *   band applies (e.g. 10% target, 10% band → 9–11%).
 * - Bucket value = value of the positions you hold directly in its tickers (CAD). The model total is
 *   the sum of all bucket values; holdings in no bucket are reported separately and not traded.
 * - Rebalancing moves only what is needed to bring each bucket to the NEAREST EDGE of its range, not
 *   to its target. Sell & buy pairs the most overweight with the most underweight greedily; buy-only
 *   finds the smallest new cash that brings every bucket into range without selling.
 */
import { tickerKey } from "./rebalance.ts";

export type BucketRole = "core" | "satellite";

export type Bucket = {
  id: string;
  name: string;
  role: BucketRole;
  tickers: string[];
  /** Core only: acceptable range, fractions (0.54 = 54%). */
  min?: number;
  max?: number;
  /** Satellite only: target fraction (0.10 = 10%). */
  target?: number;
  /** Satellite only: relative band (0.10 = ±10% of target). Undefined → global band. */
  band?: number;
};

export type BucketRange = { lo: number; hi: number; target: number; usesGlobalBand: boolean };

export type ValidationIssue = { bucketId?: string; message: string };

const EPS = 1e-9;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function bucketRange(b: Bucket, globalBand: number): BucketRange {
  if (b.role === "core") {
    const lo = b.min ?? 0;
    const hi = b.max ?? 0;
    return { lo, hi, target: (lo + hi) / 2, usesGlobalBand: false };
  }
  const t = b.target ?? 0;
  const band = b.band ?? globalBand;
  return { lo: Math.max(0, t * (1 - band)), hi: t * (1 + band), target: t, usesGlobalBand: b.band == null };
}

/** Errors that make the model unusable. An empty list means it can be evaluated. */
export function validateBuckets(buckets: Bucket[], globalBand: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cores = buckets.filter((b) => b.role === "core");
  if (cores.length > 1) issues.push({ message: "Only one core bucket is allowed." });

  const owner = new Map<string, Bucket>();
  for (const b of buckets) {
    if (!b.name.trim()) issues.push({ bucketId: b.id, message: "Every bucket needs a name." });
    const seen = new Set<string>();
    for (const raw of b.tickers) {
      const k = tickerKey(raw);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const prev = owner.get(k);
      if (prev) {
        const roles =
          prev.role !== b.role ? "both the core and a satellite" : `two ${b.role} buckets`;
        issues.push({ bucketId: b.id, message: `${k} is in ${roles} ("${prev.name}" and "${b.name}"). A ticker can belong to one bucket only.` });
      } else owner.set(k, b);
    }
    if (b.role === "core") {
      const { min, max } = b;
      if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) {
        issues.push({ bucketId: b.id, message: `Core "${b.name}" needs a min and max %.` });
      } else if (min < 0 || max > 1 || min > max) {
        issues.push({ bucketId: b.id, message: `Core "${b.name}" range must satisfy 0% ≤ min ≤ max ≤ 100% (got ${pct(min)}–${pct(max)}).` });
      }
    } else {
      if (b.target == null || !Number.isFinite(b.target) || b.target <= 0 || b.target > 1) {
        issues.push({ bucketId: b.id, message: `Satellite "${b.name}" needs a target between 0% and 100%.` });
      }
      if (b.band != null && (!Number.isFinite(b.band) || b.band < 0 || b.band >= 1)) {
        issues.push({ bucketId: b.id, message: `Satellite "${b.name}" band must be between 0% and 100% (relative).` });
      }
    }
  }
  if (issues.length) return issues;

  const sats = buckets.filter((b) => b.role === "satellite");
  const satTargets = sats.reduce((s, b) => s + (b.target ?? 0), 0);
  const core = cores[0];
  if (core) {
    if (core.min! + satTargets > 1 + EPS) {
      issues.push({ message: `Core minimum ${pct(core.min!)} + satellite targets ${pct(satTargets)} = ${pct(core.min! + satTargets)}, more than 100%.` });
    }
    if (core.max! + satTargets < 1 - EPS) {
      issues.push({ message: `Core maximum ${pct(core.max!)} + satellite targets ${pct(satTargets)} = ${pct(core.max! + satTargets)}, less than 100%; the buckets can't add up.` });
    }
  } else if (sats.length && Math.abs(satTargets - 1) > 0.005) {
    issues.push({ message: `Without a core bucket the satellite targets must add up to 100% (they add up to ${pct(satTargets)}).` });
  }
  if (!issues.length && buckets.length) {
    const ranges = buckets.map((b) => bucketRange(b, globalBand));
    const lo = ranges.reduce((s, r) => s + r.lo, 0);
    const hi = ranges.reduce((s, r) => s + r.hi, 0);
    if (lo > 1 + EPS) issues.push({ message: `The bucket minimums add up to ${pct(lo)}, more than 100%; no portfolio can satisfy them.` });
    if (hi < 1 - EPS) issues.push({ message: `The bucket maximums add up to ${pct(hi)}, less than 100%; no portfolio can satisfy them.` });
  }
  return issues;
}

export type BucketStatus = "under" | "in" | "over";

export type BucketView = {
  id: string;
  name: string;
  role: BucketRole;
  tickers: string[];
  value: number;
  weight: number;
  range: BucketRange;
  status: BucketStatus;
  /** Net trade for this bucket in CAD: positive = buy, negative = sell. */
  trade: number;
  weightAfter: number;
};

export type Transfer = { from: string; to: string; amount: number };

export type BucketPlan = {
  mode: "rebalance" | "buy-only";
  total: number;
  totalAfter: number;
  buckets: BucketView[];
  /** Sell & buy: money moved from one bucket to another (each is one sell + one buy). */
  transfers: Transfer[];
  /** Buy-only: new cash per bucket id. */
  newCash: Record<string, number>;
  newCashTotal: number;
  unassigned: { ticker: string; value: number }[];
  allInBand: boolean;
};

function statusOf(value: number, total: number, r: BucketRange): BucketStatus {
  if (total <= 0) return "in";
  const w = value / total;
  if (w < r.lo - EPS) return "under";
  if (w > r.hi + EPS) return "over";
  return "in";
}

export function bucketValues(buckets: Bucket[], positions: { ticker: string; value: number }[]) {
  const byTicker = new Map<string, number>();
  for (const p of positions) byTicker.set(tickerKey(p.ticker), (byTicker.get(tickerKey(p.ticker)) ?? 0) + p.value);
  const assigned = new Set<string>();
  const values = buckets.map((b) => {
    let v = 0;
    for (const t of new Set(b.tickers.map(tickerKey))) {
      v += byTicker.get(t) ?? 0;
      assigned.add(t);
    }
    return v;
  });
  const unassigned = [...byTicker.entries()]
    .filter(([t, v]) => !assigned.has(t) && Math.abs(v) > 0.005)
    .map(([ticker, value]) => ({ ticker, value }));
  return { values, unassigned, byTicker };
}

/** Greedy pairing, largest first. Returns transfers between ids. */
export function greedyPair(sources: { id: string; amount: number }[], sinks: { id: string; amount: number }[]): Transfer[] {
  const src = sources.filter((s) => s.amount > EPS).map((s) => ({ ...s }));
  const dst = sinks.filter((s) => s.amount > EPS).map((s) => ({ ...s }));
  const out: Transfer[] = [];
  for (;;) {
    src.sort((a, b) => b.amount - a.amount);
    dst.sort((a, b) => b.amount - a.amount);
    const s = src[0];
    const d = dst[0];
    if (!s || !d || s.amount <= 1e-6 || d.amount <= 1e-6) break;
    const amt = Math.min(s.amount, d.amount);
    out.push({ from: s.id, to: d.id, amount: amt });
    s.amount -= amt;
    d.amount -= amt;
    if (s.amount <= 1e-6) src.shift();
    if (d.amount <= 1e-6) dst.shift();
  }
  return out;
}

/**
 * Plan the smallest moves that bring every bucket into its range. Assumes validateBuckets() passed.
 */
export function planBuckets(
  buckets: Bucket[],
  positions: { ticker: string; value: number }[],
  opts: { globalBand: number; mode: "rebalance" | "buy-only" },
): BucketPlan {
  const { values, unassigned } = bucketValues(buckets, positions);
  const ranges = buckets.map((b) => bucketRange(b, opts.globalBand));
  const T = values.reduce((s, v) => s + v, 0);
  const trades = buckets.map(() => 0);
  let transfers: Transfer[] = [];
  const newCash: Record<string, number> = {};
  let totalAfter = T;

  if (T > 0 && opts.mode === "rebalance") {
    const excess = values.map((v, i) => Math.max(0, v - ranges[i]!.hi * T));
    const deficit = values.map((v, i) => Math.max(0, ranges[i]!.lo * T - v));
    const E = excess.reduce((s, x) => s + x, 0);
    const D = deficit.reduce((s, x) => s + x, 0);
    const sources = buckets.map((b, i) => ({ id: b.id, amount: excess[i]! }));
    const sinks = buckets.map((b, i) => ({ id: b.id, amount: deficit[i]! }));
    if (E > D + EPS) {
      // Overweights must still shed money: park it in buckets that are not overweight, up to their max
      // (after any floor top-up), largest room first.
      let left = E - D;
      const room = buckets
        .map((b, i) => ({ i, amount: excess[i]! > 0 ? 0 : ranges[i]!.hi * T - Math.max(values[i]!, ranges[i]!.lo * T) }))
        .filter((r) => r.amount > EPS)
        .sort((a, b) => b.amount - a.amount);
      for (const r of room) {
        if (left <= EPS) break;
        const take = Math.min(left, r.amount);
        sinks[r.i]!.amount += take;
        left -= take;
      }
    } else if (D > E + EPS) {
      // Underweights need more than the overweights free up: trim buckets that are not underweight
      // further, down to their minimum, largest slack first.
      let left = D - E;
      const slack = buckets
        .map((b, i) => ({ i, amount: deficit[i]! > 0 ? 0 : Math.min(values[i]!, ranges[i]!.hi * T) - ranges[i]!.lo * T }))
        .filter((r) => r.amount > EPS)
        .sort((a, b) => b.amount - a.amount);
      for (const r of slack) {
        if (left <= EPS) break;
        const take = Math.min(left, r.amount);
        sources[r.i]!.amount += take;
        left -= take;
      }
    }
    transfers = greedyPair(sources, sinks);
    const idx = new Map(buckets.map((b, i) => [b.id, i]));
    for (const t of transfers) {
      trades[idx.get(t.from)!]! -= t.amount;
      trades[idx.get(t.to)!]! += t.amount;
    }
  } else if (T > 0 && opts.mode === "buy-only") {
    // Smallest new total T' with: overweights fit under their max, and the minimum buys to lift
    // underweights to their floor fit inside the new cash T' − T.
    let tLow = T;
    for (let i = 0; i < buckets.length; i++) {
      const hi = ranges[i]!.hi;
      if (values[i]! > hi * T + EPS) tLow = Math.max(tLow, hi > 0 ? values[i]! / hi : Number.POSITIVE_INFINITY);
    }
    const need = (t: number) => values.reduce((s, v, i) => s + Math.max(0, ranges[i]!.lo * t - v), 0);
    const fits = (t: number) => need(t) <= t - T + 1e-6;
    let tNew = tLow;
    if (Number.isFinite(tNew) && !fits(tNew)) {
      let a = tNew;
      let b = tNew * 2 + 1;
      while (!fits(b) && b < T * 1e6) b *= 2;
      for (let k = 0; k < 200; k++) {
        const m = (a + b) / 2;
        if (fits(m)) b = m;
        else a = m;
      }
      tNew = b;
    }
    if (Number.isFinite(tNew)) {
      totalAfter = tNew;
      const buys = values.map((v, i) => Math.max(0, ranges[i]!.lo * tNew - v));
      let left = tNew - T - buys.reduce((s, x) => s + x, 0);
      // Cash left over (because an overweight forced a bigger total) goes to the buckets with most room.
      const room = buckets
        .map((_, i) => ({ i, amount: ranges[i]!.hi * tNew - values[i]! - buys[i]! }))
        .filter((r) => r.amount > EPS)
        .sort((a, b) => b.amount - a.amount);
      for (const r of room) {
        if (left <= 1e-6) break;
        const take = Math.min(left, r.amount);
        buys[r.i]! += take;
        left -= take;
      }
      buckets.forEach((b, i) => {
        trades[i] = buys[i]!;
        if (buys[i]! > 1e-6) newCash[b.id] = buys[i]!;
      });
    }
  }

  const views: BucketView[] = buckets.map((b, i) => {
    const after = values[i]! + trades[i]!;
    return {
      id: b.id,
      name: b.name,
      role: b.role,
      tickers: b.tickers,
      value: values[i]!,
      weight: T > 0 ? values[i]! / T : 0,
      range: ranges[i]!,
      status: statusOf(values[i]!, T, ranges[i]!),
      trade: Math.abs(trades[i]!) < 1e-6 ? 0 : trades[i]!,
      weightAfter: totalAfter > 0 ? after / totalAfter : 0,
    };
  });
  const newCashTotal = Object.values(newCash).reduce((s, x) => s + x, 0);
  return {
    mode: opts.mode,
    total: T,
    totalAfter,
    buckets: views,
    transfers,
    newCash,
    newCashTotal,
    unassigned,
    allInBand: views.every((v) => v.status === "in"),
  };
}

export type TickerSplit =
  | { kind: "split"; basis: "single" | "proportional"; parts: { ticker: string; amount: number }[] }
  | { kind: "choose"; reason: string };

/**
 * Split a bucket-level amount across its tickers in proportion to current holdings. A bucket with one
 * ticker gets it all. With several tickers and nothing held (or no tickers) the user must choose.
 */
export function splitByHoldings(amount: number, tickers: string[], byTicker: Map<string, number>): TickerSplit {
  const keys = [...new Set(tickers.map(tickerKey).filter(Boolean))];
  if (!keys.length) return { kind: "choose", reason: "This bucket has no tickers yet — add the ticker to buy." };
  if (keys.length === 1) return { kind: "split", basis: "single", parts: [{ ticker: keys[0]!, amount }] };
  const held = keys.map((t) => ({ ticker: t, value: Math.max(0, byTicker.get(t) ?? 0) }));
  const sum = held.reduce((s, h) => s + h.value, 0);
  if (sum <= 0) return { kind: "choose", reason: "Nothing is held in this bucket yet — choose which ticker to buy." };
  return { kind: "split", basis: "proportional", parts: held.filter((h) => h.value > 0).map((h) => ({ ticker: h.ticker, amount: (amount * h.value) / sum })) };
}

/** "HYLD.TO, xeqt" → ["HYLD.TO", "XEQT"]. */
export function parseTickerList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean))];
}
