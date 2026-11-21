import { DEFAULT_THRESHOLD } from "./rebalance.ts";

export type AppConfig = { rebalanceThreshold: number };

/** REBALANCE_THRESHOLD_PCT=10 → 0.10. Invalid or unset → 10%. */
export function appConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const n = Number((env["REBALANCE_THRESHOLD_PCT"] ?? "").trim());
  const ok = (env["REBALANCE_THRESHOLD_PCT"] ?? "").trim() !== "" && Number.isFinite(n) && n > 0 && n < 1000;
  return { rebalanceThreshold: ok ? n / 100 : DEFAULT_THRESHOLD };
}
