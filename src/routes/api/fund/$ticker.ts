import { createFileRoute } from "@tanstack/react-router";

/** GET /api/fund/HDIV — same single-fund lookup as the Fund Lookup tab, as JSON. */
export const Route = createFileRoute("/api/fund/$ticker")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const ticker = String(params.ticker ?? "").slice(0, 40);
        const { lookupFundServer } = await import("@/lib/lookthru/fund-lookup.server");
        const result = await lookupFundServer(ticker);
        return Response.json(result, {
          status: result.status === "ok" ? 200 : 404,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
