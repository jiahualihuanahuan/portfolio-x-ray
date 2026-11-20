import { createFileRoute } from "@tanstack/react-router";

/** GET /api/fund/HMAX.TO/history — total-return series from the local SQLite price cache.
 *  Pass compare=1 to include the matched Canadian-listed benchmark (not used when fetching the benchmark itself).
 */
export const Route = createFileRoute("/api/fund/$ticker/history")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const ticker = String(params.ticker ?? "").slice(0, 40);
        const compare = new URL(request.url).searchParams.get("compare") === "1";
        const { ensureTickerHistory } = await import("@/lib/lookthru/prices-prefetch");
        const result = await ensureTickerHistory(ticker);
        if (!compare || result.status !== "ok") {
          return Response.json(result, { headers: { "cache-control": "no-store" } });
        }
        const { fileHoldings } = await import("@/lib/lookthru/holdings-file");
        const { catalogInstrument } = await import("@/lib/lookthru/catalog");
        const { matchBenchmark } = await import("@/lib/lookthru/benchmarks");
        const file = fileHoldings(result.symbol);
        const catalog = catalogInstrument(result.symbol);
        const holdings = file?.holdings ?? catalog?.holdings ?? [];
        const lookup = (symbol: string) => fileHoldings(symbol)?.holdings ?? catalogInstrument(symbol)?.holdings ?? null;
        const match = matchBenchmark(result.symbol, holdings, { lookup, name: file?.name ?? catalog?.name });
        const { id, def, ...rest } = match;
        return Response.json(
          { ...result, benchmark: { id, label: def.label, legs: def.legs, ...rest } },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
