/**
 * "Ask about this ETF": grounded Q&A against a local Ollama model (/api/chat, streaming).
 * Pure helpers (prompt building, <think> stripping, error mapping) live here so they are unit-tested;
 * the HTTP route is src/routes/api/ask.ts. Config comes from env only: OLLAMA_URL, OLLAMA_MODEL,
 * OLLAMA_TIMEOUT_MS. Nothing is hard-coded to a particular host.
 */
import { z } from "zod";
import type { LookthroughResult } from "./types.ts";

export const EtfContextSchema = z.object({
  ticker: z.string().trim().min(1).max(40),
  name: z.string().max(200).optional(),
  provider: z.string().max(120).optional(),
  source: z.string().max(60).optional(),
  asOf: z.string().max(40).optional(),
  coverage: z.number().finite().optional(),
  equityExposure: z.number().finite().optional(),
  cashWeight: z.number().finite().optional(),
  priceCad: z.number().finite().nullable().optional(),
  holdings: z
    .array(z.object({ symbol: z.string().max(40), name: z.string().max(200), weight: z.number().finite(), sector: z.string().max(80).optional() }))
    .max(60),
  sectors: z.array(z.object({ name: z.string().max(80), weight: z.number().finite() })).max(30),
  childFunds: z.array(z.object({ symbol: z.string().max(40), name: z.string().max(200), weight: z.number().finite() })).max(40),
  warnings: z.array(z.string().max(400)).max(10).optional(),
  totalHoldings: z.number().int().nonnegative().optional(),
});
export type EtfContext = z.infer<typeof EtfContextSchema>;

export const AskInputSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  context: EtfContextSchema,
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(8)
    .optional(),
});
export type AskInput = z.infer<typeof AskInputSchema>;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const pct = (w: number, d = 1) => `${(w * 100).toFixed(d)}%`;

/** Build the compact, client-safe context from a single-ETF look-through result. */
export function contextFromLookthrough(
  result: LookthroughResult,
  meta: { ticker: string; name?: string; provider?: string; asOf?: string; source?: string; coverage?: number },
): EtfContext {
  const leaves = result.leaves;
  const cashWeight = leaves.filter((l) => l.kind === "cash").reduce((s, l) => s + l.weight, 0);
  const tree = result.trees[0];
  const childFunds = (tree?.children ?? [])
    .filter((c) => c.kind === "etf" && c.children.length > 0)
    .map((c) => ({ symbol: c.displaySymbol, name: c.name, weight: c.weightOfParent }))
    .slice(0, 40);
  const pos = result.positions[0];
  return {
    ticker: meta.ticker,
    name: meta.name ?? pos?.name,
    provider: meta.provider,
    source: meta.source ?? pos?.source,
    asOf: meta.asOf ?? pos?.asOf,
    coverage: meta.coverage ?? pos?.coverage,
    equityExposure: result.equityExposure,
    cashWeight,
    priceCad: pos && pos.shares > 0 ? pos.value / pos.shares : null,
    holdings: leaves.slice(0, 40).map((l) => ({ symbol: l.displaySymbol, name: l.name, weight: l.weight, sector: l.sector })),
    sectors: result.sectors.slice(0, 15).map((s) => ({ name: s.name, weight: s.weight })),
    childFunds,
    warnings: result.warnings.slice(0, 5),
    totalHoldings: leaves.length,
  };
}

export function buildSystemPrompt(ctx: EtfContext): string {
  const lines: string[] = [];
  lines.push(
    "You are a careful assistant inside Portfolio X-ray, an ETF look-through tool for a Canadian investor.",
    "Answer questions about the ETF below using ONLY the data provided here plus widely known general facts about how ETF types work (covered calls, leverage, fund-of-funds).",
    "If the data does not contain the answer (for example fees, distributions, option-writing levels or strategy details not shown), say plainly that you don't know from the data available rather than guessing.",
    "Never invent holdings, weights, yields or dates. Quote weights as given. Amounts are in CAD. Keep answers short (under 150 words) and plain. This is not investment advice.",
    "",
    "=== ETF DATA ===",
  );
  lines.push(`Ticker: ${ctx.ticker}`);
  if (ctx.name) lines.push(`Name: ${ctx.name}`);
  if (ctx.provider) lines.push(`Provider: ${ctx.provider}`);
  if (ctx.asOf) lines.push(`Holdings as of: ${ctx.asOf}`);
  if (ctx.source) lines.push(`Holdings source: ${ctx.source}`);
  if (ctx.coverage != null) lines.push(`Share of holdings named by the issuer: ${pct(ctx.coverage)}`);
  if (ctx.priceCad != null) lines.push(`Price: C$${ctx.priceCad.toFixed(2)}`);
  if (ctx.equityExposure != null) lines.push(`Equity exposure (look-through, % of NAV): ${pct(ctx.equityExposure)}`);
  if (ctx.cashWeight != null) {
    lines.push(
      ctx.cashWeight < -0.005
        ? `Cash & leverage: ${pct(ctx.cashWeight)} (negative = borrowing/leverage of about ${pct(-ctx.cashWeight)} of NAV)`
        : `Cash & leverage: ${pct(ctx.cashWeight)}`,
    );
  }
  if (ctx.childFunds.length) {
    lines.push("", "Funds it holds (fund-of-funds layer, weight in this ETF):");
    for (const c of ctx.childFunds) lines.push(`- ${c.symbol} ${c.name}: ${pct(c.weight)}`);
  } else {
    lines.push("", "Funds it holds: none detected (holds securities directly).");
  }
  lines.push("", `Top look-through holdings (${ctx.holdings.length}${ctx.totalHoldings ? ` of ${ctx.totalHoldings}` : ""}, % of NAV):`);
  for (const h of ctx.holdings) lines.push(`- ${h.symbol} ${h.name}: ${pct(h.weight, 2)}${h.sector ? ` [${h.sector}]` : ""}`);
  if (ctx.sectors.length) {
    lines.push("", "Sector mix (look-through, % of NAV):");
    for (const s of ctx.sectors) lines.push(`- ${s.name}: ${pct(s.weight)}`);
  }
  if (ctx.warnings?.length) {
    lines.push("", "Data caveats:");
    for (const w of ctx.warnings) lines.push(`- ${w}`);
  }
  lines.push("=== END ETF DATA ===");
  return lines.join("\n");
}

export function buildAskMessages(input: AskInput): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(input.context) },
    ...(input.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: input.question },
  ];
}

/**
 * Removes <think>…</think> blocks from a token stream. Tags may be split across chunks, so the
 * stripper keeps a small tail buffer until it can tell whether it is the start of a tag.
 */
export class ThinkStripper {
  private buf = "";
  private inThink = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf("</think>");
        if (end < 0) {
          // Keep only a possible partial closing tag.
          this.buf = this.buf.slice(Math.max(0, this.buf.length - 7));
          return out;
        }
        this.buf = this.buf.slice(end + "</think>".length);
        this.inThink = false;
        continue;
      }
      const start = this.buf.indexOf("<think>");
      if (start >= 0) {
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + "<think>".length);
        this.inThink = true;
        continue;
      }
      // Hold back a trailing fragment that could be the beginning of "<think>".
      let keep = 0;
      for (let k = Math.min(6, this.buf.length); k > 0; k--) {
        if ("<think>".startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      out += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  flush(): string {
    const rest = this.inThink ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

export function stripThink(text: string): string {
  const s = new ThinkStripper();
  return (s.push(text) + s.flush()).replace(/^\s+/, "");
}

export type OllamaConfig = { url: string | null; model: string; timeoutMs: number };

export function ollamaConfig(env: Record<string, string | undefined> = process.env): OllamaConfig {
  const url = (env["OLLAMA_URL"] ?? "").trim().replace(/\/+$/, "");
  const timeout = Number(env["OLLAMA_TIMEOUT_MS"]);
  return {
    url: url || null,
    model: (env["OLLAMA_MODEL"] ?? "").trim() || "qwen3.5:9b",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
  };
}

export type AskError = { status: number; error: string };

export const NOT_CONFIGURED: AskError = {
  status: 503,
  error: "Ollama is not configured. Set OLLAMA_URL (and OLLAMA_MODEL) in .env, then restart the container.",
};

/** Map a failed fetch / non-OK Ollama reply into a message the panel shows. */
export function describeOllamaFailure(cfg: OllamaConfig, failure: { status?: number; body?: string; error?: unknown }): AskError {
  if (failure.error) {
    const e = failure.error as { name?: string; message?: string };
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return { status: 504, error: `Ollama at ${cfg.url} did not answer within ${Math.round(cfg.timeoutMs / 1000)} s.` };
    }
    return { status: 502, error: `Could not reach Ollama at ${cfg.url}. Check OLLAMA_URL and that Ollama is running and reachable from the container.` };
  }
  let detail = "";
  try {
    detail = (JSON.parse(failure.body ?? "") as { error?: string }).error ?? "";
  } catch {
    detail = (failure.body ?? "").slice(0, 200);
  }
  if (failure.status === 404 && /model/i.test(detail)) {
    return { status: 502, error: `Ollama does not have model "${cfg.model}". Run \`ollama pull ${cfg.model}\` or change OLLAMA_MODEL.` };
  }
  return { status: 502, error: `Ollama returned HTTP ${failure.status ?? "?"}${detail ? `: ${detail}` : ""}.` };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Call Ollama /api/chat with streaming and return either a plain-text stream of the answer
 * (think blocks removed) or an AskError. Never throws.
 */
export async function askOllama(
  input: AskInput,
  cfg: OllamaConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ stream: ReadableStream<Uint8Array> } | AskError> {
  if (!cfg.url) return NOT_CONFIGURED;
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages: buildAskMessages(input), stream: true, options: { temperature: 0.2 } }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    return describeOllamaFailure(cfg, { error });
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    return describeOllamaFailure(cfg, { status: res.status, body });
  }
  return { stream: ollamaToText(res.body) };
}

/** NDJSON from Ollama → UTF-8 answer text, with <think> blocks stripped. */
export function ollamaToText(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stripper = new ThinkStripper();
  let pending = "";
  let leading = true;
  const emit = (ctrl: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (leading) {
      text = text.replace(/^\s+/, "");
      if (!text) return;
      leading = false;
    }
    ctrl.enqueue(encoder.encode(text));
  };
  const handleLine = (ctrl: TransformStreamDefaultController<Uint8Array>, line: string) => {
    if (!line.trim()) return;
    try {
      const j = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (j.error) emit(ctrl, `\n[Ollama error: ${j.error}]`);
      const piece = j.message?.content ?? "";
      if (piece) emit(ctrl, stripper.push(piece));
    } catch {
      // ignore malformed line
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const l of lines) handleLine(ctrl, l);
      },
      flush(ctrl) {
        pending += decoder.decode();
        if (pending) handleLine(ctrl, pending);
        const rest = stripper.flush();
        if (rest) emit(ctrl, rest);
      },
    }),
  );
}
