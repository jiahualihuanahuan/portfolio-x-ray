/** CDR mapping (editable JSON): "KO.UN" → { listing: "KO.NE", underlying: "KO" }. Pure helpers. */
export type CdrEntry = { listing: string; underlying: string };
export type CdrMap = Record<string, CdrEntry>;

export function parseCdrMap(json: unknown): CdrMap {
  const out: CdrMap = {};
  if (!json || typeof json !== "object") return out;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (k.startsWith("_") || !v || typeof v !== "object") continue;
    const e = v as Partial<CdrEntry>;
    if (typeof e.listing !== "string" || typeof e.underlying !== "string") continue;
    out[k.trim().toUpperCase()] = { listing: e.listing.trim().toUpperCase(), underlying: e.underlying.trim().toUpperCase() };
  }
  return out;
}

/** Look up a typed ticker (KO.UN, KO-UN, KO.UN.TO) or a listing (KO.NE) in the map. */
export function cdrLookup(map: CdrMap, ticker: string): CdrEntry | null {
  const t = ticker.trim().toUpperCase();
  const variants = [t, t.replace(/-UN(\.TO)?$/, ".UN"), t.replace(/\.UN\.TO$/, ".UN")];
  for (const v of variants) if (map[v]) return map[v]!;
  for (const e of Object.values(map)) if (e.listing === t) return e;
  return null;
}
