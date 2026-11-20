import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ExternalLink, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { FundTotalReturnChart } from "@/components/lookthru/fund-history-chart";
import { ValuationCard } from "@/components/lookthru/valuation-card";
import { Badge } from "@/components/lookthru/ui/badge";
import { Button } from "@/components/lookthru/ui/button";
import { Input } from "@/components/lookthru/ui/input";
import { Skeleton } from "@/components/lookthru/ui/skeleton";
import { lookupFundHoldings } from "@/lib/lookthru/analyze";
import { formatPct } from "@/lib/lookthru/format";
import type { FundHoldingKind, FundHoldingRow, FundLookupResult } from "@/lib/lookthru/fund-lookup";
import type { TickerSearchHit } from "@/lib/lookthru/ticker-search";
import { cn } from "@/lib/utils";

const MAX_NEST = 3;
type SearchResponse = { query: string; results: TickerSearchHit[] };

function useTickerSuggest(query: string, enabled: boolean) {
  return useQuery<TickerSearchHit[]>({
    queryKey: ["ticker-search", query],
    enabled: enabled && query.trim().length > 0,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const res = await fetch(`/api/tickers/search?q=${encodeURIComponent(query.trim())}`);
      const data = (await res.json().catch(() => null)) as SearchResponse | null;
      return data?.results ?? [];
    },
  });
}



function useFund(ticker: string | null) {
  return useQuery<FundLookupResult>({
    queryKey: ["fund-lookup", ticker],
    enabled: Boolean(ticker),
    staleTime: 5 * 60 * 1000,
    queryFn: () => lookupFundHoldings({ data: { ticker: ticker ?? "" } }),
  });
}

function KindBadge({ kind }: { kind: FundHoldingKind }) {
  if (kind === "fund") return <Badge variant="accent">Fund</Badge>;
  if (kind === "cash") return <Badge>Cash</Badge>;
  if (kind === "options") return <Badge variant="loss">Options</Badge>;
  if (kind === "other") return <Badge>Other</Badge>;
  return <Badge variant="outline">Stock</Badge>;
}

/** Fund Lookup tab: one ticker → that fund's own holdings. Needs no portfolio. */
export function FundLookup() {
  const [text, setText] = useState("");
  const [trail, setTrail] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = trail.at(-1) ?? null;
  const query = useFund(current);
  const suggest = useTickerSuggest(text, open);
  const hits = suggest.data ?? [];

  useEffect(() => {
    setActive(0);
  }, [text]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function lookup(ticker: string, push: boolean) {
    const t = ticker.trim();
    if (!t) return;
    setText(t);
    setOpen(false);
    setTrail((prev) => (push ? [...prev, t] : [t]));
  }

  function pick(hit: TickerSearchHit) {
    lookup(hit.ticker, false);
  }

  function resolvedSubmit(): string {
    const typed = text.trim();
    if (!typed) return "";
    const hit = hits[active] ?? hits.find((h) => h.ticker.toUpperCase() === typed.toUpperCase() || h.displaySymbol.toUpperCase() === typed.toUpperCase());
    return hit?.ticker ?? typed;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = resolvedSubmit();
    if (t) lookup(t, false);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (!open) {
        setOpen(true);
        return;
      }
      if (!hits.length) return;
      e.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter" && open && hits[active]) {
      e.preventDefault();
      pick(hits[active]!);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div ref={boxRef} className="relative min-w-0 flex-1 space-y-1.5">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium tracking-wide text-muted">Fund ticker</span>
            <Input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKey}
              placeholder="HDIV, HYLD.TO, BMAX"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono uppercase"
              role="combobox"
              aria-label="Fund ticker"
              aria-autocomplete="list"
              aria-expanded={open && hits.length > 0}
              aria-controls={listId}
              aria-activedescendant={open && hits[active] ? `${listId}-${hits[active]!.ticker}` : undefined}
            />
          </label>
          {open && hits.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-line bg-surface py-1 shadow-lg"
            >
              {hits.map((hit, i) => (
                <li key={hit.ticker} role="option" id={`${listId}-${hit.ticker}`} aria-selected={i === active}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left",
                      i === active ? "bg-elevated" : "hover:bg-elevated/60",
                    )}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(hit)}
                  >
                    <span className="font-mono text-sm">{hit.ticker}</span>
                    <span className="text-xs text-muted">
                      {hit.name}
                      {hit.provider ? ` · ${hit.provider}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Button type="submit" className="h-11 w-full sm:w-auto" disabled={!text.trim()}>
          <Search />
          Look up
        </Button>
      </form>

      {trail.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const prev = trail.slice(0, -1);
              setTrail(prev);
              setText(prev.at(-1) ?? "");
            }}
          >
            <ArrowLeft />
            Back
          </Button>
          <span className="font-mono">{trail.join(" → ")}</span>
        </div>
      ) : null}

      {!current ? (
        <section className="rounded-xl bg-surface px-5 py-8 text-center border border-line">
          <p className="font-medium text-lg tracking-tight">Look inside one fund</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Type a ticker such as HDIV, HYLD or BMAX (with or without .TO) to see its holdings,
            weights, as-of date and source. No portfolio needed.
          </p>
        </section>
      ) : query.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : query.isError ? (
        <p className="rounded-xl bg-surface p-6 text-sm text-muted border border-line">
          The lookup failed. Try again in a moment.
        </p>
      ) : query.data ? (
        <FundResult result={query.data} onOpen={(t) => lookup(t, true)} />
      ) : null}
    </div>
  );
}

function FundResult({ result, onOpen }: { result: FundLookupResult; onOpen: (t: string) => void }) {
  if (result.status !== "ok") {
    return (
      <section className="rounded-xl bg-surface px-5 py-8 text-center border border-line">
        <p className="font-medium text-lg tracking-tight">
          {result.status === "no_holdings" ? "No holdings published" : "Fund not found"}
        </p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">{result.message}</p>
      </section>
    );
  }
  return (
    <div className="space-y-3">
      <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-lg">{result.displaySymbol}</span>
          <span className="text-base font-medium">{result.name}</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Meta label="As of" value={result.asOf ?? "—"} />
          <Meta
            label="Source"
            value={
              result.sourceUrl ? (
                <a href={result.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                  {result.source}
                  <ExternalLink className="size-3" />
                </a>
              ) : (
                result.source
              )
            }
          />
          <Meta
            label="Coverage"
            value={`${formatPct(result.coverage)}${result.scope && result.scope !== "full" ? ` (${result.scope})` : ""}`}
          />
          <Meta label="Holdings" value={String(result.holdings.length)} />
        </dl>
      </section>
      <HoldingsTable rows={result.holdings} onOpen={onOpen} depth={0} ancestors={[result.symbol]} />
      <FundTotalReturnChart ticker={result.symbol} />
      <ValuationCard ticker={result.symbol} />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide text-subtle uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-fg">{value}</dd>
    </div>
  );
}

function HoldingsTable({
  rows,
  onOpen,
  depth,
  ancestors,
}: {
  rows: FundHoldingRow[];
  onOpen: (t: string) => void;
  depth: number;
  ancestors: string[];
}) {
  return (
    <div className={cn("overflow-x-auto rounded-xl bg-surface border border-line", depth > 0 && "rounded-md bg-elevated")}>
      <table className="w-full min-w-[560px] text-left text-sm">
        {depth === 0 ? (
          <thead className="text-[11px] tracking-wide whitespace-nowrap text-muted uppercase">
            <tr className="border-b border-line">
              <th className="w-8 px-2 py-3" />
              <th className="px-3 py-3 font-medium">Holding</th>
              <th className="px-3 py-3 font-medium">Ticker</th>
              <th className="px-3 py-3 font-medium">Kind</th>
              <th className="px-3 py-3 font-medium">Sector</th>
              <th className="px-3 py-3 font-medium">Country</th>
              <th className="px-3 py-3 text-right font-medium">Weight</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((row, i) => (
            <HoldingRow key={`${row.symbol}-${i}`} row={row} onOpen={onOpen} depth={depth} ancestors={ancestors} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingRow({
  row,
  onOpen,
  depth,
  ancestors,
}: {
  row: FundHoldingRow;
  onOpen: (t: string) => void;
  depth: number;
  ancestors: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = Boolean(row.lookup) && depth < MAX_NEST && !ancestors.includes(row.lookup ?? "");
  return (
    <>
      <tr className="border-b border-line/60 last:border-0">
        <td className="px-2 py-2 align-middle">
          {canExpand ? (
            <button
              type="button"
              aria-label={expanded ? `Collapse ${row.displaySymbol}` : `Expand ${row.displaySymbol}`}
              onClick={() => setExpanded((v) => !v)}
              className="rounded p-1 hover:bg-elevated"
            >
              <ChevronRight className={cn("size-4 text-subtle transition-transform", expanded && "rotate-90")} />
            </button>
          ) : null}
        </td>
        <td className="max-w-[320px] truncate px-3 py-2">{row.name}</td>
        <td className="px-3 py-2 font-mono">
          {row.lookup ? (
            <button type="button" className="underline decoration-dotted hover:text-accent" onClick={() => onOpen(row.lookup!)}>
              {row.displaySymbol}
            </button>
          ) : (
            row.displaySymbol
          )}
        </td>
        <td className="px-3 py-2">
          <KindBadge kind={row.kind} />
        </td>
        <td className="px-3 py-2 text-xs text-muted">{row.sector || "—"}</td>
        <td className="px-3 py-2 text-xs text-muted">{row.country || "—"}</td>
        <td className={cn("px-3 py-2 text-right font-mono tabular-nums", row.weight < 0 && "text-down")}>
          {formatPct(row.weight, 2)}
        </td>
      </tr>
      {expanded && row.lookup ? (
        <tr>
          <td colSpan={7} className="px-2 pb-3 pl-8">
            <NestedFund ticker={row.lookup} onOpen={onOpen} depth={depth + 1} ancestors={[...ancestors, row.lookup]} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function NestedFund({
  ticker,
  onOpen,
  depth,
  ancestors,
}: {
  ticker: string;
  onOpen: (t: string) => void;
  depth: number;
  ancestors: string[];
}) {
  const q = useFund(ticker);
  if (q.isPending) return <Skeleton className="h-16 rounded-md" />;
  if (q.isError || !q.data) return <p className="text-xs text-muted">Could not load {ticker}.</p>;
  if (q.data.status !== "ok") return <p className="text-xs text-muted">{q.data.message}</p>;
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-subtle">
        {q.data.name} · as of {q.data.asOf ?? "—"} · {q.data.source} · coverage {formatPct(q.data.coverage)}
      </p>
      <HoldingsTable rows={q.data.holdings} onOpen={onOpen} depth={depth} ancestors={ancestors} />
    </div>
  );
}
