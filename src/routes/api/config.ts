import { createFileRoute } from "@tanstack/react-router";

/** GET /api/config — non-secret UI defaults from env (REBALANCE_THRESHOLD_PCT). */
export const Route = createFileRoute("/api/config")({
  server: {
    handlers: {
      GET: async () => {
        const { appConfig } = await import("@/lib/lookthru/app-config");
        return Response.json(appConfig(), { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
