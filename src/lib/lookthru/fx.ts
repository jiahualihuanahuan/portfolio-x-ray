/**
 * USD→CAD conversion. The whole app reports in CAD; USD-priced securities are converted with the
 * live Yahoo USDCAD=X (or CAD=X) rate, cached on disk. There is no hard-coded fallback rate: if no
 * live quote and no cached copy exist, callers get `null` and must show an error.
 */

export type FxSource = "live" | "cache" | "manual";

export type FxRate = {
  /** CAD per 1 USD. */
  rate: number;
  /** ISO timestamp of when the rate was fetched from Yahoo. */
  asOf: string;
  source: FxSource;
  pair: string;
};

export type FxResolution = { fx: FxRate; error: null } | { fx: null; error: string };

export const FX_UNAVAILABLE =
  "USD→CAD rate unavailable: Yahoo USDCAD=X could not be fetched and no cached rate exists. USD-priced holdings cannot be converted to CAD.";

/** Yahoo sometimes quotes CAD=X as CAD per USD (≈1.37); guard against an inverted pair. */
export function normalizeUsdCad(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1 ? 1 / raw : raw;
}

export function parseCachedFx(text: string | null | undefined): FxRate | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Partial<FxRate>;
    const rate = normalizeUsdCad(typeof j.rate === "number" ? j.rate : null);
    if (rate == null || typeof j.asOf !== "string" || Number.isNaN(Date.parse(j.asOf))) return null;
    return { rate, asOf: j.asOf, source: "cache", pair: typeof j.pair === "string" ? j.pair : "USDCAD=X" };
  } catch {
    return null;
  }
}

/** FX_USDCAD_OVERRIDE ("1.3712"): a manual CAD-per-USD rate. Blank or invalid → null (ignored). */
export function parseOverride(text: string | null | undefined): number | null {
  if (text == null || !String(text).trim()) return null;
  const n = Number(String(text).trim());
  return Number.isFinite(n) && n > 0 ? normalizeUsdCad(n) : null;
}

/**
 * Manual override wins (labelled "manual"); then the live quote; then the cached copy; otherwise
 * an explicit error (never 1:1 or a constant).
 */
export function resolveFx(
  live: { rate: number | null; pair: string } | null,
  cached: FxRate | null,
  now: Date = new Date(),
  override: number | null = null,
): FxResolution {
  if (override != null) {
    return { fx: { rate: override, asOf: now.toISOString(), source: "manual", pair: "FX_USDCAD_OVERRIDE" }, error: null };
  }
  const rate = normalizeUsdCad(live?.rate ?? null);
  if (rate != null && live) {
    return { fx: { rate, asOf: now.toISOString(), source: "live", pair: live.pair }, error: null };
  }
  if (cached) return { fx: { ...cached, source: "cache" }, error: null };
  return { fx: null, error: FX_UNAVAILABLE };
}

export class FxUnavailableError extends Error {
  constructor() {
    super(FX_UNAVAILABLE);
    this.name = "FxUnavailableError";
  }
}

/**
 * Convert an amount quoted in `from` into CAD. CAD passes through. USD needs a valid rate, else
 * this throws FxUnavailableError. Other currencies are treated as USD (unchanged legacy behaviour;
 * Yahoo quotes the app's holdings in CAD or USD).
 */
export function toCad(amount: number, from: string, usdCad: number | null | undefined): number {
  const src = (from || "").toUpperCase();
  if (src === "CAD") return amount;
  const rate = normalizeUsdCad(usdCad);
  if (rate == null) throw new FxUnavailableError();
  return amount * rate;
}

/** True when any of these currencies needs the USD→CAD rate. */
export function needsFx(currencies: Iterable<string>): boolean {
  for (const c of currencies) if ((c || "").toUpperCase() !== "CAD") return true;
  return false;
}
