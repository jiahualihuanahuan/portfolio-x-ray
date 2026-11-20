import { definePlugin } from "nitro";

/** Start the in-process price prefetch at server boot (disabled during build/tests or when PRICES_PREFETCH=0). */
export default definePlugin(() => {
  void import("../../src/lib/lookthru/prices-prefetch").then((m) => {
    m.startPricePrefetchScheduler();
  });
});
