import { createFileRoute } from "@tanstack/react-router";

/**
 * POST /api/ask — grounded Q&A about one ETF via the local Ollama model.
 * Body: { question, context: EtfContext, history? }. Success streams text/plain; errors are JSON
 * { error } with 4xx/5xx so the panel can show them. GET returns whether Ollama is configured.
 */
export const Route = createFileRoute("/api/ask")({
  server: {
    handlers: {
      GET: async () => {
        const { ollamaConfig } = await import("@/lib/lookthru/ask");
        const cfg = ollamaConfig();
        return Response.json({ configured: Boolean(cfg.url), model: cfg.model }, { headers: { "cache-control": "no-store" } });
      },
      POST: async ({ request }) => {
        const { AskInputSchema, askOllama, ollamaConfig } = await import("@/lib/lookthru/ask");
        const raw = await request.json().catch(() => null);
        const parsed = AskInputSchema.safeParse(raw);
        if (!parsed.success) return Response.json({ error: "Invalid question or ETF data." }, { status: 400 });
        const out = await askOllama(parsed.data, ollamaConfig());
        if ("error" in out) return Response.json({ error: out.error }, { status: out.status });
        return new Response(out.stream, {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
        });
      },
    },
  },
});
