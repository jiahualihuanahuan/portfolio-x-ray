import { createFileRoute } from "@tanstack/react-router";

/** Liveness probe for Docker and the in-container watchdog. No upstream calls. */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          {
            ok: true,
            service: "portfolio-x-ray",
            time: new Date().toISOString(),
          },
          { headers: { "cache-control": "no-store" } },
        ),
    },
  },
});
