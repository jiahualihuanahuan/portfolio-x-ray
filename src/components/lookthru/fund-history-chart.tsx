import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/components/lookthru/ui/skeleton";
import { Button } from "@/components/lookthru/ui/button";
import {
  alignRange,
  alignedReturn,
  benchmarkSummaryLine,
  formatSignedPct,
  type BenchmarkBasis,
  type BenchmarkId,
  type BenchmarkLeg,
} from "@/lib/lookthru/benchmarks";
import {
  HISTORY_RANGES,
  historySummary,
  sliceHistory,
  type FundHistoryResult,
  type HistoryPoint,
  type HistoryRange,
} from "@/lib/lookthru/fund-history";
import { cn } from "@/lib/utils";

export type HistoryBenchmark = {
  id: BenchmarkId;
  label: string;
  legs: BenchmarkLeg[];
  basis: BenchmarkBasis;
  reason: string;
  canadaWeight: number;
  usWeight: number;
  nasdaqOverlap: number;
  topSector: { name: string; weight: number } | null;
};

type FundHistoryPayload = FundHistoryResult & { benchmark?: HistoryBenchmark };

const BENCH_COLORS: Record<string, string> = {
  unhedged: "var(--color-chart-3)",
  hedged: "var(--color-chart-4)",
  none: "var(--color-chart-3)",
};

function formatAxisDate(date: string, range: HistoryRange): string {
  const [y, m, d] = date.split("-");
  if (!y || !m) return date;
  if (range === "1Y") return `${m}/${d}`;
  return `${y}-${m}`;
}

function sourceNote(result: Extract<FundHistoryResult, { status: "ok" }>): string {
  if (result.totalReturnSource === "adjclose") {
    return "Total return includes distributions reinvested (Yahoo adjusted close).";
  }
  if (result.totalReturnSource === "dividends") {
    return "Total return includes distributions reinvested from dividend events.";
  }
  return "Distribution data was not available. This chart shows price return only.";
}

async function fetchHistory(ticker: string, compare: boolean): Promise<FundHistoryPayload> {
  const q = compare ? "?compare=1" : "";
  const res = await fetch(`/api/fund/${encodeURIComponent(ticker)}/history${q}`);
  const data = (await res.json().catch(() => null)) as FundHistoryPayload | null;
  return data ?? { status: "error", query: ticker, symbol: ticker, message: "No price history is available for this fund." };
}

export function FundTotalReturnChart({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<HistoryRange>("MAX");
  const [showUnhedged, setShowUnhedged] = useState(true);
  const [showHedged, setShowHedged] = useState(true);

  const query = useQuery<FundHistoryPayload>({
    queryKey: ["fund-history", ticker],
    enabled: Boolean(ticker),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: () => fetchHistory(ticker, true),
  });

  const benchmark = query.data?.status === "ok" ? query.data.benchmark : undefined;
  const legs = benchmark?.legs ?? [];
  const hasHedgePair = legs.some((l) => l.hedge === "unhedged") && legs.some((l) => l.hedge === "hedged");

  const benchQuery = useQuery<Record<string, HistoryPoint[]>>({
    queryKey: ["fund-history-benchmarks", ticker, legs.map((l) => l.ticker).join(",")],
    enabled: Boolean(ticker) && query.data?.status === "ok" && legs.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const entries = await Promise.all(
        legs.map(async (leg) => {
          const hist = await fetchHistory(leg.ticker, false);
          return [leg.ticker, hist.status === "ok" ? hist.points : []] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

  const visibleLegs = legs.filter((l) => {
    if (l.hedge === "unhedged") return showUnhedged;
    if (l.hedge === "hedged") return showHedged;
    return true;
  });

  const aligned = useMemo(() => {
    if (query.data?.status !== "ok") return [];
    const series: Record<string, HistoryPoint[]> = { fund: query.data.points };
    for (const leg of visibleLegs) {
      const pts = benchQuery.data?.[leg.ticker];
      if (pts && pts.length >= 2) series[leg.ticker] = pts;
    }
    return alignRange(series, range);
  }, [query.data, benchQuery.data, visibleLegs, range]);

  const slicedFund = useMemo(() => {
    if (query.data?.status !== "ok") return [];
    return sliceHistory(query.data.points, range);
  }, [query.data, range]);

  const fundSummary = useMemo(() => {
    const fromAligned = alignedReturn(aligned, "fund");
    if (fromAligned) return fromAligned;
    const s = historySummary(slicedFund);
    return s ? { total: s.totalReturn, annualized: s.annualized, years: s.years } : null;
  }, [aligned, slicedFund]);

  const chartData = useMemo(() => {
    if (aligned.length >= 2) {
      return aligned.map((p) => {
        const row: Record<string, string | number> = { date: p.date, total: (p.values.fund - 1) * 100 };
        for (const leg of visibleLegs) {
          if (p.values[leg.ticker] != null) row[leg.ticker] = (p.values[leg.ticker]! - 1) * 100;
        }
        return row;
      });
    }
    return slicedFund.map((p) => ({ date: p.date, total: (p.totalIndex - 1) * 100, price: (p.priceIndex - 1) * 100 }));
  }, [aligned, slicedFund, visibleLegs]);

  const comparisonLine = useMemo(() => {
    if (!benchmark || !fundSummary || aligned.length < 2) return null;
    const benchReturns = visibleLegs
      .map((leg) => {
        const ret = alignedReturn(aligned, leg.ticker);
        return ret ? { ticker: leg.ticker, name: leg.name, total: ret.total, annualized: ret.annualized } : null;
      })
      .filter((x): x is { ticker: string; name: string; total: number; annualized: number | null } => Boolean(x));
    return benchmarkSummaryLine(
      { ...benchmark, def: { id: benchmark.id, label: benchmark.label, legs: benchmark.legs } },
      range,
      fundSummary,
      benchReturns,
    );
  }, [benchmark, fundSummary, aligned, visibleLegs, range]);

  return (
    <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-xl tracking-tight">Total return</h2>
          {query.data?.status === "ok" ? (
            <p className="mt-0.5 text-xs text-muted">{sourceNote(query.data)}</p>
          ) : (
            <p className="mt-0.5 text-xs text-muted">Price return plus distributions reinvested, when the data is available.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {HISTORY_RANGES.map((r) => (
            <Button
              key={r}
              type="button"
              size="sm"
              variant={range === r ? "secondary" : "ghost"}
              className={cn("h-8 px-2.5", range === r && "border border-line")}
              onClick={() => setRange(r)}
            >
              {r === "MAX" ? "Max" : r}
            </Button>
          ))}
        </div>
      </div>

      {query.isPending ? (
        <Skeleton className="mt-3 h-64 rounded-md" />
      ) : query.data?.status !== "ok" || chartData.length < 2 ? (
        <p className="mt-4 text-sm text-muted">
          {query.data && "message" in query.data && query.data.message
            ? query.data.message
            : "No price history is available for this fund."}
        </p>
      ) : (
        <>
          {fundSummary ? (
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
              <div>
                <dt className="text-[11px] tracking-wide text-subtle uppercase">Total return</dt>
                <dd className={cn("mt-0.5 font-mono text-sm tabular-nums", fundSummary.total < 0 ? "text-down" : "text-up")}>
                  {formatSignedPct(fundSummary.total)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] tracking-wide text-subtle uppercase">Annualized</dt>
                <dd className={cn("mt-0.5 font-mono text-sm tabular-nums", (fundSummary.annualized ?? 0) < 0 ? "text-down" : "text-up")}>
                  {fundSummary.annualized == null ? "—" : formatSignedPct(fundSummary.annualized)}
                </dd>
              </div>
            </dl>
          ) : null}

          {hasHedgePair ? (
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <label className="inline-flex items-center gap-1.5 text-muted">
                <input type="checkbox" checked={showUnhedged} onChange={(e) => setShowUnhedged(e.target.checked)} />
                Unhedged
              </label>
              <label className="inline-flex items-center gap-1.5 text-muted">
                <input type="checkbox" checked={showHedged} onChange={(e) => setShowHedged(e.target.checked)} />
                Hedged
              </label>
            </div>
          ) : null}

          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ left: 8, right: 12, top: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={28}
                  tickFormatter={(d: string) => formatAxisDate(d, range)}
                />
                <YAxis
                  tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}
                />
                <Tooltip
                  cursor={{ stroke: "var(--color-line)" }}
                  contentStyle={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-line)",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "var(--color-fg)",
                  }}
                  formatter={(value, name) => {
                    const v = Number(value);
                    if (name === "total") return [formatSignedPct(v / 100), "Fund"];
                    const leg = legs.find((l) => l.ticker === name);
                    return [formatSignedPct(v / 100), leg ? `${leg.ticker} (${leg.name})` : String(name)];
                  }}
                  labelFormatter={(d) => String(d)}
                />
                <Line type="monotone" dataKey="total" name="total" stroke="var(--color-chart-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
                {visibleLegs.map((leg) => (
                  <Line
                    key={leg.ticker}
                    type="monotone"
                    dataKey={leg.ticker}
                    name={leg.ticker}
                    stroke={BENCH_COLORS[leg.hedge] ?? "var(--color-chart-3)"}
                    strokeWidth={1.5}
                    strokeDasharray={leg.hedge === "hedged" ? "4 4" : undefined}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {comparisonLine ? <p className="mt-3 text-xs text-muted">{comparisonLine}</p> : null}
        </>
      )}
    </section>
  );
}
