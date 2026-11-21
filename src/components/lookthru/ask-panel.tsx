import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Send, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/lookthru/ui/button";
import { Input } from "@/components/lookthru/ui/input";
import type { EtfContext } from "@/lib/lookthru/ask";

type Turn = { role: "user" | "assistant"; content: string; error?: boolean };

/** "Ask about this ETF" — streams an answer from the local Ollama model, grounded in the look-through. */
export function AskPanel({ context }: { context: EtfContext }) {
  const status = useQuery<{ configured: boolean; model: string }>({
    queryKey: ["ask-status"],
    staleTime: 60 * 1000,
    queryFn: async () => {
      const r = await fetch("/api/ask");
      return (await r.json()) as { configured: boolean; model: string };
    },
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    setTurns([]);
  }, [context.ticker]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = turns.filter((t) => !t.error).slice(-6).map(({ role, content }) => ({ role, content }));
    setTurns((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setText("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const setLast = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1]!)]);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, context, history }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setLast(() => ({ role: "assistant", content: j?.error ?? `Request failed (HTTP ${res.status}).`, error: true }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = dec.decode(value, { stream: true });
        setLast((t) => ({ ...t, content: t.content + piece }));
      }
      setLast((t) => (t.content.trim() ? t : { ...t, content: "The model returned an empty answer.", error: true }));
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        setLast((t) => ({ ...t, content: t.content || "Stopped." }));
      } else {
        setLast(() => ({ role: "assistant", content: "Could not reach the app server.", error: true }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(text);
  }

  const name = context.ticker.replace(/\.(TO|NE|V)$/i, "");
  const configured = status.data?.configured;

  return (
    <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
      <div className="flex items-center gap-2">
        <MessageSquare className="size-4 text-accent" />
        <h2 className="font-medium text-xl tracking-tight">Ask about {name}</h2>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        Answers come from your local Ollama model{status.data?.model ? ` (${status.data.model})` : ""}, using only
        the look-through data on this page. It should say when the data doesn&apos;t cover your question. Not
        investment advice.
      </p>

      {configured === false ? (
        <p className="mt-3 rounded-md border border-line bg-elevated p-3 text-sm text-muted">
          Ollama isn&apos;t configured. Set <span className="font-mono">OLLAMA_URL</span> (and{" "}
          <span className="font-mono">OLLAMA_MODEL</span>) in <span className="font-mono">.env</span> — see
          .env.example — then restart the container.
        </p>
      ) : (
        <>
          {turns.length ? (
            <div className="mt-3 max-h-96 space-y-2 overflow-y-auto">
              {turns.map((t, i) => (
                <div
                  key={i}
                  className={
                    t.role === "user"
                      ? "ml-auto w-fit max-w-[85%] rounded-md bg-elevated px-3 py-2 text-sm"
                      : t.error
                        ? "max-w-[95%] rounded-md border border-down/40 px-3 py-2 text-sm text-down"
                        : "max-w-[95%] whitespace-pre-wrap rounded-md border border-line px-3 py-2 text-sm"
                  }
                >
                  {t.content || (busy && i === turns.length - 1 ? <span className="text-muted">Thinking…</span> : null)}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {[`What does ${name} do?`, `How much leverage does ${name} use?`, `What are ${name}'s biggest holdings?`].map((q) => (
                <Button key={q} type="button" variant="secondary" size="sm" onClick={() => void ask(q)} disabled={busy}>
                  {q}
                </Button>
              ))}
            </div>
          )}
          <form onSubmit={submit} className="mt-3 flex gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Ask a question about ${name}`}
              maxLength={1000}
              aria-label={`Question about ${name}`}
            />
            {busy ? (
              <Button type="button" variant="secondary" className="h-11" onClick={() => abortRef.current?.abort()}>
                <Square />
                Stop
              </Button>
            ) : (
              <Button type="submit" className="h-11" disabled={!text.trim()}>
                <Send />
                Ask
              </Button>
            )}
          </form>
        </>
      )}
    </section>
  );
}
