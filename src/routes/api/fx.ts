import { createFileRoute } from "@tanstack/react-router";

/** GET /api/fx — the USD→CAD rate the app uses: { fx: { rate, asOf, source, pair } | null, error }. */
export const Route = createFileRoute("/api/fx")({
  server: {
    handlers: {
      GET: async () => {
        const { usdCadRate } = await import("@/lib/lookthru/yahoo.server");
        const res = await usdCadRate();
        return Response.json(res, { status: res.fx ? 200 : 503, headers: { "cache-control": "no-store" } });
      },
    },
  },
});
