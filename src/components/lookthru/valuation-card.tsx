import { useQuery } from "@tanstack/react-query";
import type { ValuationReport } from "@/lib/lookthru/valuation";
import { formatPct } from "@/lib/lookthru/format";
import type { LeafExposure } from "@/lib/lookthru/types";

async function fetchValuation(ticker: string): Promise<ValuationReport> {
  const res = await fetch(`/api/valuation/${encodeURIComponent(ticker)}`);
  return (await res.json()) as ValuationReport;
}

async function fetchPortfolioValuation(leaves: LeafExposure[]): Promise<ValuationReport> {
  const res = await fetch("/api/valuation/PORTFOLIO", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Look-through portfolio",
      holdings: leaves.map((l) => ({
        symbol: l.symbol,
        name: l.name,
        weight: l.weight,
        sector: l.sector,
        kind: l.kind,
      })),
    }),
  });
  return (await res.json()) as ValuationReport;
}

export function useFundValuation(ticker: string | null) {
  return useQuery({
    queryKey: ["valuation", ticker],
    enabled: Boolean(ticker),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: () => fetchValuation(ticker!),
  });
}

export function usePortfolioValuation(leaves: LeafExposure[] | undefined) {
  return useQuery({
    queryKey: ["valuation-portfolio", (leaves ?? []).map((l) => `${l.symbol}:${l.weight}`).join("|")],
    enabled: Boolean(leaves && leaves.length),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: () => fetchPortfolioValuation(leaves!),
  });
}

/** Small card under the Fund Lookup benchmark summary. */
export function ValuationCard({ ticker }: { ticker: string }) {
  const q = useFundValuation(ticker);
  const r = q.data?.status === "ok" ? q.data : null;
  return (
    <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
      <h2 className="font-medium text-xl tracking-tight">Valuation</h2>
      {q.isPending ? (
        <p className="mt-2 text-sm text-muted">Loading forward P/E…</p>
      ) : !r ? (
        <p className="mt-2 text-sm text-muted">Forward P/E is not available for this ticker yet.</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <Meta label="Forward P/E" value={r.peLabel} />
            <Meta label="Coverage" value={`${formatPct(r.coverage)} · ${r.namesCovered} names`} />
            <Meta
              label="Percentile"
              value={r.percentile == null ? "—" : `${r.percentile.toFixed(0)}th`}
            />
            {r.benchmark ? (
              <Meta label={r.benchmark.label} value={`${r.benchmark.peLabel} bench.`} />
            ) : (
              <Meta label="Analysts (median)" value={r.medianAnalystCount != null ? String(r.medianAnalystCount) : "—"} />
            )}
          </dl>
          {r.sectors.length ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[400px] text-left text-sm">
                <thead className="text-[11px] tracking-wide whitespace-nowrap text-muted uppercase">
                  <tr className="border-b border-line">
                    <th className="px-0 py-2 font-medium">Sector</th>
                    <th className="px-3 py-2 text-right font-medium">Weight</th>
                    <th className="px-3 py-2 text-right font-medium">P/E</th>
                    <th className="px-3 py-2 text-right font-medium">Percentile</th>
                  </tr>
                </thead>
                <tbody>
                  {r.sectors.slice(0, 6).map((s) => (
                    <tr key={s.sector} className="border-b border-line/60 last:border-0">
                      <td className="px-0 py-1.5">{s.sector}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{formatPct(s.weight)}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{s.peLabel}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">
                        {s.percentile == null ? "—" : `${s.percentile.toFixed(0)}th`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-muted">{r.methodology[0]} {r.percentileLabel === "proxy, based on reported EPS" ? "Percentiles use a proxy history, based on reported EPS." : "Percentiles use nightly consensus snapshots."}</p>
          {r.constituents ? (
            <p className="mt-1 text-xs text-subtle">
              {r.constituents.partial ? "Partial" : "Full"} {r.constituents.proxyFor} constituents from {r.constituents.source}
              {r.constituents.count ? ` (${r.constituents.count} names)` : ""}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide text-subtle uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-fg">{value}</dd>
    </div>
  );
}

/** Forward P/E figure for the Look-through KPI row. */
export function ForwardPeValue({ leaves }: { leaves: LeafExposure[] }) {
  const q = usePortfolioValuation(leaves);
  if (q.isPending) return "…";
  if (q.data?.status !== "ok") return "—";
  return q.data.peLabel;
}
