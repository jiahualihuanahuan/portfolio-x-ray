import { classificationOf, type Bucket } from "@/lib/lookthru/core-satellite";
import { usePortfolio } from "@/lib/lookthru/store";
import { cn } from "@/lib/utils";

const CONFLICT = "__conflict__";
const UNASSIGNED = "";

/**
 * Core / satellite / Unassigned picker for one ticker. Picking moves the ticker into that bucket and
 * out of every other one. A ticker typed into two buckets shows "Conflict" until it is resolved.
 */
export function ClassificationSelect({
  ticker,
  buckets,
  className,
  placeholder,
}: {
  ticker: string;
  buckets: Bucket[];
  className?: string;
  placeholder?: string;
}) {
  const assign = usePortfolio((s) => s.assignTicker);
  const c = classificationOf(buckets, ticker);
  const value = c.kind === "bucket" ? c.id : c.kind === "conflict" ? CONFLICT : UNASSIGNED;
  const core = buckets.filter((b) => b.role === "core");
  const sats = buckets.filter((b) => b.role === "satellite");
  const names = c.kind === "conflict" ? c.ids.map((id) => buckets.find((b) => b.id === id)?.name ?? id).join(" + ") : "";
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === CONFLICT) return;
        assign(ticker, e.target.value === UNASSIGNED ? null : e.target.value);
      }}
      aria-label={`Classification for ${ticker}`}
      title={c.kind === "conflict" ? `${ticker} is in ${names}. Pick one bucket to fix it.` : undefined}
      className={cn(
        "h-9 max-w-[11rem] rounded-sm border border-line bg-elevated px-2 text-xs text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
        c.kind === "conflict" && "border-down/60 text-down",
        className,
      )}
    >
      {c.kind === "conflict" ? (
        <option value={CONFLICT} disabled>
          Conflict: {names}
        </option>
      ) : null}
      <option value={UNASSIGNED}>{placeholder ?? "Unassigned"}</option>
      {core.map((b) => (
        <option key={b.id} value={b.id}>
          Core{b.name && b.name !== "Core" ? ` — ${b.name}` : ""}
        </option>
      ))}
      {sats.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name || "Satellite"}
        </option>
      ))}
    </select>
  );
}
