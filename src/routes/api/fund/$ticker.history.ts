import { createFileRoute } from "@tanstack/react-router";

/** GET /api/fund/HMAX.TO/history — total-return series from the local SQLite price cache. */
export const Route = createFileRoute("/api/fund/$ticker/history")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const ticker = String(params.ticker ?? "").slice(0, 40);
        const { ensureTickerHistory } = await import("@/lib/lookthru/prices-prefetch");
        const result = await ensureTickerHistory(ticker);
        const status = result.status === "ok" ? 200 : 200;
        return Response.json(result, {
          status,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
