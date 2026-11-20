/**
 * One-shot price prefetch: npm run prefetch
 * Logs how many tickers were cached, how many failed, and how long it took.
 */
import { runPrefetch } from "./prices-prefetch.ts";

const started = Date.now();
const result = await runPrefetch({
  onTicker: (ev) => {
    if (ev.status === "skipped") return;
    const tag = ev.status === "ok" ? "ok" : "fail";
    console.log(`[${tag}] ${ev.ticker}${ev.error ? ` — ${ev.error}` : ""}`);
  },
});
const secs = (result.elapsedMs / 1000).toFixed(1);
console.log(
  `Prefetch finished: ${result.ok} cached, ${result.failed} failed, ${result.skipped} already fresh, ${secs}s elapsed.`,
);
if (result.failed > 0 && result.ok === 0) process.exitCode = 1;
void started;
