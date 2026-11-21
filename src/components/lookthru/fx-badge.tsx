import { useQuery } from "@tanstack/react-query";
import type { FxRate } from "@/lib/lookthru/fx";
import { cn } from "@/lib/utils";

type FxResponse = { fx: FxRate | null; error: string | null };

export function useFx() {
  return useQuery<FxResponse>({
    queryKey: ["fx-usdcad"],
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    queryFn: async () => {
      const res = await fetch("/api/fx");
      const j = (await res.json().catch(() => null)) as FxResponse | null;
      return j ?? { fx: null, error: "Could not load the USD→CAD rate." };
    },
  });
}

export function formatFxTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

const LABEL: Record<FxRate["source"], string> = { live: "live", cache: "saved rate", manual: "manual", "prices-db": "prices.sqlite" };

/** Header chip: "All amounts in CAD · USD→CAD 1.3712 (live, Nov 21, 9:30 a.m. EST)". */
export function FxBadge() {
  const q = useFx();
  const fx = q.data?.fx ?? null;
  const err = q.data?.error ?? null;
  return (
    <div
      className={cn(
        "rounded-md border border-line bg-elevated px-3 py-1.5 text-right text-[11px] leading-tight",
        err && !fx && "border-down/50",
      )}
      aria-live="polite"
    >
      <p className="font-mono text-xs text-fg">All amounts in C$ (CAD)</p>
      {q.isPending ? (
        <p className="text-muted">Loading USD→CAD…</p>
      ) : fx ? (
        <p className="text-muted" title={`Source: Yahoo ${fx.pair}`}>
          USD→CAD <span className="font-mono text-fg">{fx.rate.toFixed(4)}</span> · {LABEL[fx.source]}
          {fx.source === "manual"
            ? " (FX_USDCAD_OVERRIDE)"
            : fx.source === "live"
              ? ` · ${formatFxTime(fx.asOf)}`
              : ` · rate of ${fx.date ?? formatFxTime(fx.asOf)}`}
        </p>
      ) : (
        <p className="max-w-xs text-down">{err ?? "USD→CAD rate unavailable."}</p>
      )}
    </div>
  );
}
