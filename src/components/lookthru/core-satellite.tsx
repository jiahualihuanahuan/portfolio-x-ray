import { AlertTriangle, ArrowRight, CheckCircle2, Plus, X } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/lookthru/ui/badge";
import { Button } from "@/components/lookthru/ui/button";
import { Input } from "@/components/lookthru/ui/input";
import {
  bucketValues,
  parseTickerList,
  planBuckets,
  splitByHoldings,
  validateBuckets,
  type Bucket,
  type BucketView,
} from "@/lib/lookthru/core-satellite";
import { formatMoney, formatPct } from "@/lib/lookthru/format";
import { usePortfolio } from "@/lib/lookthru/store";
import type { LookthroughResult } from "@/lib/lookthru/types";
import { cn } from "@/lib/utils";

const p1 = (x: number) => formatPct(x, x * 1000 % 10 ? 1 : 0);

/** Percent input that stores a fraction; blank → undefined. */
function PctInput({ value, onChange, placeholder, label }: { value?: number; onChange: (v: number | undefined) => void; placeholder?: string; label: string }) {
  return (
    <Input
      key={value ?? "blank"}
      inputMode="decimal"
      defaultValue={value == null ? "" : String(Math.round(value * 10000) / 100)}
      placeholder={placeholder}
      aria-label={label}
      onBlur={(e) => {
        const t = e.target.value.trim();
        if (t === "") return onChange(undefined);
        const n = Number(t.replace("%", ""));
        if (Number.isFinite(n)) onChange(n / 100);
      }}
      className="h-9 w-20 text-right font-mono tabular-nums"
    />
  );
}

/**
 * Core–satellite model: one core bucket with an acceptable % range and satellite buckets with a
 * target % (own band or the global band). Trades go to the nearest band edge with the fewest moves.
 */
export function CoreSatellite({ result, globalBand }: { result: LookthroughResult | null; globalBand: number }) {
  const buckets = usePortfolio((s) => s.buckets);
  const mode = usePortfolio((s) => s.mode);
  const addBucket = usePortfolio((s) => s.addBucket);
  const updateBucket = usePortfolio((s) => s.updateBucket);
  const removeBucket = usePortfolio((s) => s.removeBucket);

  const positions = useMemo(() => (result?.positions ?? []).map((p) => ({ ticker: p.ticker, value: p.value })), [result]);
  const issues = useMemo(() => validateBuckets(buckets, globalBand), [buckets, globalBand]);
  const plan = useMemo(
    () => (issues.length || !buckets.length ? null : planBuckets(buckets, positions, { globalBand, mode })),
    [issues, buckets, positions, globalBand, mode],
  );
  const byTicker = useMemo(() => bucketValues(buckets, positions).byTicker, [buckets, positions]);
  const hasCore = buckets.some((b) => b.role === "core");
  const names = new Map(buckets.map((b) => [b.id, b.name]));

  return (
    <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
      <h3 className="font-medium text-lg tracking-tight">Core–satellite model</h3>
      <p className="mt-1 max-w-3xl text-xs text-muted">
        Put tickers into one <b>core</b> bucket with an acceptable range (e.g. 54–66%, midpoint 60%) and any number of{" "}
        <b>satellite</b> buckets with a target % (e.g. four at 10%). A satellite without its own band uses the global
        band above ({p1(globalBand)} relative, so 10% → {p1(0.1 * (1 - globalBand))}–{p1(0.1 * (1 + globalBand))}).
        Percentages are of the total held in all buckets; holdings in no bucket are listed but not traded. Suggested
        trades move only the minimum needed to bring each bucket to the <b>nearest edge</b> of its range (not to the
        target), pairing the most overweight with the most underweight first.
      </p>

      <div className="mt-3 space-y-2">
        {buckets.map((b) => (
          <BucketEditor key={b.id} bucket={b} globalBand={globalBand} onChange={(patch) => updateBucket(b.id, patch)} onRemove={() => removeBucket(b.id)} invalid={issues.some((i) => i.bucketId === b.id)} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={hasCore} onClick={() => addBucket("core")}>
          <Plus />
          Add core bucket
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => addBucket("satellite")}>
          <Plus />
          Add satellite bucket
        </Button>
      </div>

      {issues.length ? (
        <div role="alert" className="mt-4 rounded-md border border-down/50 p-3 text-sm text-down">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" />
            Fix the model before it can be checked:
          </p>
          <ul className="mt-1 list-disc pl-6">
            {issues.map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : plan && plan.total > 0 ? (
        <div className="mt-4 space-y-3">
          {plan.allInBand ? (
            <p className="flex items-center gap-2 rounded-md border border-up/40 p-3 text-sm">
              <CheckCircle2 className="size-4 text-up" />
              Every bucket is inside its range. No trades needed.
            </p>
          ) : (
            <div role="alert" className="rounded-md border border-down/50 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4 text-down" />
                Rebalance alert: {plan.buckets.filter((b) => b.status !== "in").length} bucket(s) outside their range
              </p>
              {mode === "rebalance" ? (
                <ol className="mt-2 list-decimal space-y-1 pl-6 text-muted">
                  {plan.transfers.map((t, k) => (
                    <li key={k}>
                      Sell {formatMoney(t.amount, "CAD")} of <b className="text-fg">{names.get(t.from)}</b>{" "}
                      <ArrowRight className="inline size-3" /> buy {formatMoney(t.amount, "CAD")} of{" "}
                      <b className="text-fg">{names.get(t.to)}</b>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-1 text-muted">
                  Buy-only: add <b className="text-fg">{formatMoney(plan.newCashTotal, "CAD")}</b> of new cash (the minimum
                  that brings every bucket into range without selling).
                </p>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-[11px] tracking-wide whitespace-nowrap text-muted uppercase">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-medium">Bucket</th>
                  <th className="px-3 py-2 text-right font-medium">Now</th>
                  <th className="px-3 py-2 text-right font-medium">Weight</th>
                  <th className="px-3 py-2 font-medium">Range</th>
                  <th className="px-3 py-2 font-medium">{mode === "rebalance" ? "Trade" : "New cash"}</th>
                  <th className="px-3 py-2 text-right font-medium">After</th>
                </tr>
              </thead>
              <tbody>
                {plan.buckets.map((v) => (
                  <BucketRow key={v.id} v={v} byTicker={byTicker} />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line text-xs text-muted">
                  <td className="px-3 py-2" colSpan={6}>
                    Model total {formatMoney(plan.total, "CAD")}
                    {mode === "buy-only" && plan.newCashTotal > 0
                      ? ` → ${formatMoney(plan.totalAfter, "CAD")} after ${formatMoney(plan.newCashTotal, "CAD")} new cash`
                      : ""}
                    {plan.unassigned.length
                      ? ` · Not in any bucket (not traded): ${plan.unassigned.map((u) => `${u.ticker} ${formatMoney(u.value, "CAD")}`).join(", ")}`
                      : ""}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : buckets.length ? (
        <p className="mt-4 text-xs text-muted">No holdings in these buckets yet — add positions in the Full portfolio tab.</p>
      ) : null}
    </section>
  );
}

function BucketEditor({
  bucket: b,
  globalBand,
  onChange,
  onRemove,
  invalid,
}: {
  bucket: Bucket;
  globalBand: number;
  onChange: (patch: Partial<Omit<Bucket, "id">>) => void;
  onRemove: () => void;
  invalid: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-end gap-3 rounded-md border border-line bg-elevated/40 p-3", invalid && "border-down/50")}>
      <div className="space-y-1">
        <Badge variant={b.role === "core" ? "accent" : "outline"}>{b.role === "core" ? "Core" : "Satellite"}</Badge>
        <Input
          key={b.name}
          defaultValue={b.name}
          onBlur={(e) => onChange({ name: e.target.value })}
          aria-label="Bucket name"
          className="h-9 w-40"
        />
      </div>
      <label className="min-w-0 flex-1 space-y-1">
        <span className="block text-[11px] text-muted">Tickers (comma-separated)</span>
        <Input
          key={b.tickers.join(",")}
          defaultValue={b.tickers.join(", ")}
          placeholder={b.role === "core" ? "HYOD.TO" : "e.g. BTCC.TO"}
          onBlur={(e) => onChange({ tickers: parseTickerList(e.target.value) })}
          aria-label={`Tickers in ${b.name}`}
          className="h-9 font-mono uppercase"
        />
      </label>
      {b.role === "core" ? (
        <>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">Min %</span>
            <PctInput value={b.min} onChange={(v) => onChange({ min: v })} label="Core minimum percent" />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">Max %</span>
            <PctInput value={b.max} onChange={(v) => onChange({ max: v })} label="Core maximum percent" />
          </label>
          <p className="pb-2 text-[11px] text-subtle">
            Midpoint {b.min != null && b.max != null ? p1((b.min + b.max) / 2) : "—"}
          </p>
        </>
      ) : (
        <>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">Target %</span>
            <PctInput value={b.target} onChange={(v) => onChange({ target: v })} label="Satellite target percent" />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted">Band % (relative)</span>
            <PctInput value={b.band} onChange={(v) => onChange({ band: v })} placeholder="global" label={`Satellite band percent (blank = global ${Math.round(globalBand * 1000) / 10}%)`} />
          </label>
        </>
      )}
      <Button type="button" variant="ghost" size="icon" className="size-9" onClick={onRemove} aria-label={`Remove ${b.name}`}>
        <X className="size-4" />
      </Button>
    </div>
  );
}

function BucketRow({ v, byTicker }: { v: BucketView; byTicker: Map<string, number> }) {
  const split = v.trade !== 0 ? splitByHoldings(Math.abs(v.trade), v.tickers, byTicker) : null;
  return (
    <tr className={cn("border-b border-line/70 align-top last:border-0", v.status !== "in" && "bg-down/5")}>
      <td className="px-3 py-2">
        <div className="font-medium">{v.name}</div>
        <div className="font-mono text-[11px] text-subtle">{v.tickers.join(", ") || "no tickers"}</div>
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(v.value, "CAD")}</td>
      <td className={cn("px-3 py-2 text-right font-mono tabular-nums", v.status !== "in" && "text-down")}>{formatPct(v.weight)}</td>
      <td className="px-3 py-2 text-xs">
        <span className="font-mono">
          {formatPct(v.range.lo)}–{formatPct(v.range.hi)}
        </span>
        <div className="text-[11px] text-subtle">
          {v.role === "core" ? `midpoint ${formatPct(v.range.target)}` : `target ${formatPct(v.range.target)}`}
          {v.range.usesGlobalBand ? " · global band" : v.role === "satellite" ? " · own band" : ""}
        </div>
      </td>
      <td className="px-3 py-2">
        {v.trade > 0 ? (
          <Badge variant="gain">Buy {formatMoney(v.trade, "CAD")}</Badge>
        ) : v.trade < 0 ? (
          <Badge variant="loss">Sell {formatMoney(-v.trade, "CAD")}</Badge>
        ) : (
          <span className="text-xs text-muted">{v.status === "in" ? "In range" : "—"}</span>
        )}
        {split ? (
          split.kind === "choose" ? (
            <div className="mt-1 text-[11px] text-down">{split.reason}</div>
          ) : split.basis === "proportional" ? (
            <div className="mt-1 text-[11px] text-subtle">
              Split by current holdings: {split.parts.map((p) => `${p.ticker} ${formatMoney(p.amount, "CAD")}`).join(" · ")}
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-subtle">
              {split.parts[0]!.ticker} {formatMoney(split.parts[0]!.amount, "CAD")}
            </div>
          )
        ) : null}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{formatPct(v.weightAfter)}</td>
    </tr>
  );
}
