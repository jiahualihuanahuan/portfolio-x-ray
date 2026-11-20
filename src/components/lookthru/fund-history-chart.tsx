import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/components/lookthru/ui/skeleton";
import { Button } from "@/components/lookthru/ui/button";
import {
  HISTORY_RANGES,
  historySummary,
  sliceHistory,
  type FundHistoryResult,
  type HistoryRange,
} from "@/lib/lookthru/fund-history";
import { cn } from "@/lib/utils";

function formatSignedPct(fraction: number, digits = 1): string {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

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

export function FundTotalReturnChart({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<HistoryRange>("MAX");
  const query = useQuery<FundHistoryResult>({
    queryKey: ["fund-history", ticker],
    enabled: Boolean(ticker),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(`/api/fund/${encodeURIComponent(ticker)}/history`);
      const data = (await res.json().catch(() => null)) as FundHistoryResult | null;
      if (!data) {
        return { status: "error", query: ticker, symbol: ticker, message: "No price history is available for this fund." };
      }
      return data;
    },
  });

  const sliced = useMemo(() => {
    if (query.data?.status !== "ok") return [];
    return sliceHistory(query.data.points, range);
  }, [query.data, range]);

  const summary = useMemo(() => historySummary(sliced), [sliced]);
  const chartData = useMemo(
    () =>
      sliced.map((p) => ({
        date: p.date,
        total: (p.totalIndex - 1) * 100,
        price: (p.priceIndex - 1) * 100,
      })),
    [sliced],
  );

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
          {summary ? (
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
              <div>
                <dt className="text-[11px] tracking-wide text-subtle uppercase">Total return</dt>
                <dd className={cn("mt-0.5 font-mono text-sm tabular-nums", summary.totalReturn < 0 ? "text-down" : "text-up")}>
                  {formatSignedPct(summary.totalReturn)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] tracking-wide text-subtle uppercase">Annualized</dt>
                <dd className={cn("mt-0.5 font-mono text-sm tabular-nums", (summary.annualized ?? 0) < 0 ? "text-down" : "text-up")}>
                  {summary.annualized == null ? "—" : formatSignedPct(summary.annualized)}
                </dd>
              </div>
              {query.data.dividendsIncluded ? (
                <div>
                  <dt className="text-[11px] tracking-wide text-subtle uppercase">Price only</dt>
                  <dd className="mt-0.5 font-mono text-sm tabular-nums text-muted">{formatSignedPct(summary.priceReturn)}</dd>
                </div>
              ) : null}
            </dl>
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
                    const label = name === "total" ? "Total return" : "Price only";
                    return [formatSignedPct(v / 100), label];
                  }}
                  labelFormatter={(d) => String(d)}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  name="total"
                  stroke="var(--color-chart-2)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                {query.data.dividendsIncluded ? (
                  <Line
                    type="monotone"
                    dataKey="price"
                    name="price"
                    stroke="var(--color-chart-1)"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </section>
  );
}
