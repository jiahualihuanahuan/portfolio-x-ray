import { createFileRoute } from "@tanstack/react-router";

/**
 * GET  /api/valuation/HHIS.TO  — forward P/E for a fund, index proxy, or stock.
 * POST /api/valuation/PORTFOLIO — same math for a look-through book of leaves
 *   (body: { holdings: [{ symbol, weight, sector, kind }], name?, benchmarkTicker? }).
 */
export const Route = createFileRoute("/api/valuation/$ticker")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const ticker = String(params.ticker ?? "").slice(0, 40);
        const { valuationForTicker } = await import("@/lib/lookthru/valuation.server");
        const result = await valuationForTicker(ticker);
        return Response.json(result, {
          status: result.status === "ok" ? 200 : 404,
          headers: { "cache-control": "no-store" },
        });
      },
      POST: async ({ params, request }) => {
        const ticker = String(params.ticker ?? "").slice(0, 40);
        const body = (await request.json().catch(() => null)) as
          | { holdings?: unknown; name?: string; benchmarkTicker?: string }
          | null;
        const { valuationForPortfolio, valuationForTicker } = await import("@/lib/lookthru/valuation.server");
        if (body && Array.isArray(body.holdings)) {
          const result = await valuationForPortfolio({
            holdings: body.holdings as { symbol: string; weight: number; sector?: string; kind?: string; name?: string }[],
            name: body.name,
            benchmarkTicker: body.benchmarkTicker,
          });
          return Response.json(result, { headers: { "cache-control": "no-store" } });
        }
        const result = await valuationForTicker(ticker);
        return Response.json(result, {
          status: result.status === "ok" ? 200 : 404,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
