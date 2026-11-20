import { createFileRoute } from "@tanstack/react-router";

/** GET /api/tickers/search?q=HHI — prefix autocomplete for Fund Lookup. */
export const Route = createFileRoute("/api/tickers/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const q = (url.searchParams.get("q") ?? "").slice(0, 40);
        const { searchFundTickers } = await import("@/lib/lookthru/ticker-search");
        const results = searchFundTickers(q);
        return Response.json({ query: q, results }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
