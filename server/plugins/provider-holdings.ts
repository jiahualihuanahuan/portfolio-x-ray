import { definePlugin } from "nitro";

/** Warm the Brompton provider-holdings cache at boot (off during build/tests or with PROVIDER_HOLDINGS_PREFETCH=0). */
export default definePlugin(() => {
  void import("../../src/lib/lookthru/brompton.server").then((m) => {
    m.startProviderHoldingsWarmup();
  });
});
