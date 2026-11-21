import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CoreSatellite } from "@/components/lookthru/core-satellite";
import { Badge } from "@/components/lookthru/ui/badge";
import { Button } from "@/components/lookthru/ui/button";
import { Input } from "@/components/lookthru/ui/input";
import type { AppConfig } from "@/lib/lookthru/app-config";
import { formatMoney, formatPct, formatShares } from "@/lib/lookthru/format";
import {
  actualBySector,
  actualByTicker,
  computeRebalance,
  DEFAULT_THRESHOLD,
  tickerKey,
  type RebalanceRow,
  type RebalanceSummary,
  type TargetKind,
} from "@/lib/lookthru/rebalance";
import { usePortfolio } from "@/lib/lookthru/store";
import type { LookthroughResult } from "@/lib/lookthru/types";
import { cn } from "@/lib/utils";

function useAppConfig() {
  return useQuery<AppConfig>({
    queryKey: ["app-config"],
    staleTime: Infinity,
    queryFn: async () => {
      const r = await fetch("/api/config");
      return (await r.json()) as AppConfig;
    },
  });
}

/**
 * Tab 3 — Target & rebalance. CAD targets per ticker and/or per sector, compared with the Full
 * portfolio tab's holdings. Ticker and sector targets are two separate views; neither overrides
 * the other.
 */
export function RebalanceTab({ result, error }: { result: LookthroughResult | null; error: string | null }) {
  const targets = usePortfolio((s) => s.targets);
  const stored = usePortfolio((s) => s.threshold);
  const mode = usePortfolio((s) => s.mode);
  const addTarget = usePortfolio((s) => s.addTarget);
  const updateTarget = usePortfolio((s) => s.updateTarget);
  const removeTarget = usePortfolio((s) => s.removeTarget);
  const clearTargets = usePortfolio((s) => s.clearTargets);
  const setThreshold = usePortfolio((s) => s.setThreshold);
  const setMode = usePortfolio((s) => s.setMode);
  const cfg = useAppConfig();
  const threshold = stored ?? cfg.data?.rebalanceThreshold ?? DEFAULT_THRESHOLD;

  const tickerActuals = useMemo(() => actualByTicker(result), [result]);
  const sectorActuals = useMemo(() => actualBySector(result), [result]);
  const opts = { threshold, mode };
  const tickerView = computeRebalance(targets, "ticker", tickerActuals, opts);
  const sectorView = computeRebalance(targets, "sector", sectorActuals, opts);
  const breaches = tickerView.breaches + sectorView.breaches;

  const priceByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of result?.positions ?? []) if (p.shares > 0 && p.value > 0) m.set(tickerKey(p.ticker), p.value / p.shares);
    return m;
  }, [result]);
  const leafByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of result?.leaves ?? []) m.set(tickerKey(l.displaySymbol), (m.get(tickerKey(l.displaySymbol)) ?? 0) + l.value);
    return m;
  }, [result]);

  return (
    <div className="space-y-4">
      <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
        <h2 className="font-medium text-xl tracking-tight">Targets &amp; rebalance alerts</h2>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          Set a target in C$ for any ticker or sector. A row is flagged when it is more than the band away from
          its target: |actual − target| ÷ target &gt; band. Only flagged rows get a suggested trade, sized to bring
          that row back to its target. <b>Ticker</b> targets compare with the position you hold in that ticker
          (Full portfolio tab). <b>Sector</b> targets compare with look-through sector exposure (all ETFs unrolled).
          The two views are independent — if both apply, both are shown and neither takes priority.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="space-y-1.5">
            <span className="block text-xs font-medium tracking-wide text-muted">Global band (%, relative)</span>
            <Input
              key={threshold}
              type="number"
              min={0}
              step="any"
              defaultValue={Math.round(threshold * 10000) / 100}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (e.target.value.trim() === "") setThreshold(null);
                else if (Number.isFinite(n) && n >= 0) setThreshold(n / 100);
              }}
              className="h-10 w-28 font-mono tabular-nums"
              aria-label="Alert band in percent"
            />
          </label>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium tracking-wide text-muted">Suggested trades</span>
            <div className="flex h-10 items-center rounded-md bg-elevated p-1 border border-line" role="group" aria-label="Trade mode">
              {(
                [
                  ["rebalance", "Sell & buy"],
                  ["buy-only", "Buy-only (new cash)"],
                ] as const
              ).map(([m, label]) => (
                <Button
                  key={m}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={cn("h-8 px-3 text-xs", mode === m && "bg-surface text-fg border border-line")}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {stored != null ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setThreshold(null)}>
              Reset band to default ({formatPct(cfg.data?.rebalanceThreshold ?? DEFAULT_THRESHOLD, 0)})
            </Button>
          ) : null}
        </div>
        <p className="mt-2 text-[11px] text-subtle">
          The global band applies to C$ targets and to satellite buckets without their own band. Buy-only adds new cash to underweight rows and never sells; overweight rows are shown but left alone,
          so they stay overweight in dollars.
        </p>
      </section>

      {error ? (
        <p className="rounded-xl bg-surface p-4 text-sm text-down border border-down/40">{error}</p>
      ) : !result ? (
        <p className="text-xs text-muted">No portfolio loaded yet — actual values count as C$0 until you add holdings in the Full portfolio tab.</p>
      ) : null}

      <CoreSatellite result={result} globalBand={threshold} />

      <div>
        <h3 className="font-medium text-lg tracking-tight">C$ targets by ticker or sector</h3>
        <p className="text-xs text-muted">
          Separate from the core–satellite model. Flagged rows get a trade back to the exact C$ target.
        </p>
      </div>
      <TargetForm result={result} onAdd={addTarget} />

      {targets.length ? (
        <>
          <AlertBanner breaches={breaches} threshold={threshold} ticker={tickerView} sector={sectorView} mode={mode} />
          <TargetTable
            title="Ticker targets"
            subtitle="Actual = value of the position you hold directly in that ticker."
            summary={tickerView}
            mode={mode}
            threshold={threshold}
            onUpdate={updateTarget}
            onRemove={removeTarget}
            extra={(r) => {
              const k = tickerKey(r.key);
              const price = priceByTicker.get(k);
              const via = leafByTicker.get(k);
              return (
                <>
                  {price && r.tradeAmount > 0 ? (
                    <div className="text-[11px] text-subtle">≈ {formatShares(r.tradeAmount / price)} sh @ {formatMoney(price, "CAD", true)}</div>
                  ) : null}
                  {!r.actual && via ? (
                    <div className="text-[11px] text-subtle">Look-through exposure {formatMoney(via, "CAD")} (not held directly)</div>
                  ) : null}
                </>
              );
            }}
          />
          <TargetTable
            title="Sector targets"
            subtitle="Actual = look-through sector exposure. Trades are sector amounts; pick the funds or stocks yourself."
            summary={sectorView}
            mode={mode}
            threshold={threshold}
            onUpdate={updateTarget}
            onRemove={removeTarget}
          />
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={clearTargets}>
              <Trash2 />
              Clear all targets
            </Button>
          </div>
        </>
      ) : (
        <section className="rounded-xl bg-surface px-5 py-8 text-center border border-line">
          <p className="font-medium text-lg tracking-tight">No targets yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Add a C$ target for a ticker (e.g. HYLD.TO C$50,000) or a sector (e.g. Financials C$30,000), or fill in
            every held ticker at today&apos;s value and edit from there.
          </p>
        </section>
      )}
    </div>
  );
}

function TargetForm({
  result,
  onAdd,
}: {
  result: LookthroughResult | null;
  onAdd: (kind: TargetKind, key: string, amount: number) => void;
}) {
  const [kind, setKind] = useState<TargetKind>("ticker");
  const [key, setKey] = useState("");
  const [amount, setAmount] = useState("");
  const tickers = [...new Set((result?.positions ?? []).map((p) => p.ticker))];
  const sectors = (result?.sectors ?? []).map((s) => s.name);

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(amount.replace(/[^0-9.]/g, ""));
    if (!key.trim() || amount.trim() === "" || !Number.isFinite(n) || n < 0) return;
    onAdd(kind, key, n);
    setKey("");
    setAmount("");
  }

  return (
    <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <span className="block text-xs font-medium tracking-wide text-muted">Target by</span>
          <div className="flex h-11 items-center rounded-md bg-elevated p-1 border border-line" role="group" aria-label="Target type">
            {(["ticker", "sector"] as const).map((k) => (
              <Button
                key={k}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k);
                  setKey("");
                }}
                className={cn("h-9 px-3 text-xs capitalize", kind === k && "bg-surface text-fg border border-line")}
              >
                {k}
              </Button>
            ))}
          </div>
        </div>
        <label className="min-w-0 flex-1 space-y-1.5">
          <span className="text-xs font-medium tracking-wide text-muted">{kind === "ticker" ? "Ticker" : "Sector"}</span>
          <Input
            list={kind === "ticker" ? "rebalance-tickers" : "rebalance-sectors"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={kind === "ticker" ? "HYLD.TO" : "Financials"}
            autoCorrect="off"
            spellCheck={false}
            className={kind === "ticker" ? "font-mono uppercase" : undefined}
          />
          <datalist id="rebalance-tickers">
            {tickers.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <datalist id="rebalance-sectors">
            {sectors.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="w-full space-y-1.5 sm:w-40">
          <span className="text-xs font-medium tracking-wide text-muted">Target (C$)</span>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25000" className="font-mono tabular-nums" />
        </label>
        <Button type="submit" className="h-11 w-full sm:w-auto">
          <Plus />
          Set target
        </Button>
      </form>
      {result?.positions.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              for (const p of result.positions) if (p.value > 0) onAdd("ticker", p.ticker, Math.round(p.value * 100) / 100);
            }}
          >
            Fill ticker targets with current values
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              for (const s of result.sectors) if (s.value > 0) onAdd("sector", s.name, Math.round(s.value * 100) / 100);
            }}
          >
            Fill sector targets with current values
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function AlertBanner({
  breaches,
  threshold,
  ticker,
  sector,
  mode,
}: {
  breaches: number;
  threshold: number;
  ticker: RebalanceSummary;
  sector: RebalanceSummary;
  mode: "rebalance" | "buy-only";
}) {
  if (!breaches) {
    return (
      <section className="flex items-center gap-2 rounded-xl border border-up/40 bg-surface p-4 text-sm">
        <CheckCircle2 className="size-4 text-up" />
        All targets are within ±{formatPct(threshold, threshold * 100 % 1 ? 1 : 0)}. No rebalance needed.
      </section>
    );
  }
  const part = (s: RebalanceSummary, label: string) =>
    s.breaches ? (
      <li>
        {label}: {s.breaches} outside the band —{" "}
        {mode === "rebalance"
          ? `sell ${formatMoney(s.totalSell, "CAD")}, buy ${formatMoney(s.totalBuy, "CAD")}, ${
              s.netCash >= 0 ? `new cash needed ${formatMoney(s.netCash, "CAD")}` : `cash freed ${formatMoney(-s.netCash, "CAD")}`
            }`
          : s.totalBuy > 0
            ? `buy ${formatMoney(s.totalBuy, "CAD")} with new cash`
            : "all overweight; buy-only mode suggests no trades (switch to Sell & buy to trim)"}
      </li>
    ) : null;
  return (
    <section role="alert" className="rounded-xl border border-down/50 bg-surface p-4 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 text-down" />
        Rebalance alert: {breaches} target{breaches === 1 ? "" : "s"} off by more than {formatPct(threshold, threshold * 100 % 1 ? 1 : 0)}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-muted">
        {part(ticker, "Ticker view")}
        {part(sector, "Sector view")}
      </ul>
      {ticker.breaches && sector.breaches ? (
        <p className="mt-2 text-[11px] text-subtle">The two views are separate suggestions; acting on one changes the other.</p>
      ) : null}
    </section>
  );
}

function TargetTable({
  title,
  subtitle,
  summary,
  mode,
  threshold,
  onUpdate,
  onRemove,
  extra,
}: {
  title: string;
  subtitle: string;
  summary: RebalanceSummary;
  mode: "rebalance" | "buy-only";
  threshold: number;
  onUpdate: (id: string, amount: number) => void;
  onRemove: (id: string) => void;
  extra?: (r: RebalanceRow) => ReactNode;
}) {
  if (!summary.rows.length) return null;
  return (
    <section className="overflow-x-auto rounded-xl bg-surface border border-line">
      <div className="px-4 pt-4">
        <h3 className="font-medium text-lg tracking-tight">{title}</h3>
        <p className="text-xs text-muted">{subtitle}</p>
      </div>
      <table className="mt-2 w-full min-w-[720px] text-left text-sm">
        <thead className="text-[11px] tracking-wide whitespace-nowrap text-muted uppercase">
          <tr className="border-b border-line">
            <th className="px-4 py-3 font-medium">{title.startsWith("Ticker") ? "Ticker" : "Sector"}</th>
            <th className="px-4 py-3 text-right font-medium">Target (C$)</th>
            <th className="px-4 py-3 text-right font-medium">Actual</th>
            <th className="px-4 py-3 text-right font-medium">Off by</th>
            <th className="px-4 py-3 font-medium">Suggested trade</th>
            <th className="w-12 px-2 py-3" />
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((r) => (
            <tr key={r.id} className={cn("border-b border-line/70 last:border-0", r.breached && "bg-down/5")}>
              <td className="px-4 py-3">
                <span className={title.startsWith("Ticker") ? "font-mono" : undefined}>{r.key}</span>
              </td>
              <td className="px-4 py-3 text-right">
                <Input
                  key={`${r.id}-${r.target}`}
                  inputMode="decimal"
                  defaultValue={String(Math.round(r.target * 100) / 100)}
                  onBlur={(e) => {
                    const n = Number(e.target.value.replace(/[^0-9.]/g, ""));
                    if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= 0 && n !== r.target) onUpdate(r.id, n);
                  }}
                  className="ml-auto h-9 w-32 text-right font-mono tabular-nums"
                  aria-label={`Target for ${r.key} in CAD`}
                />
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">{formatMoney(r.actual, "CAD")}</td>
              <td className={cn("px-4 py-3 text-right font-mono tabular-nums", r.breached && "text-down")}>
                <div>{Number.isFinite(r.deviation) ? `${r.diff >= 0 ? "+" : "−"}${formatPct(r.deviation)}` : "∞"}</div>
                <div className="text-[11px] text-subtle">
                  {r.diff >= 0 ? "+" : "−"}
                  {formatMoney(Math.abs(r.diff), "CAD")}
                </div>
              </td>
              <td className="px-4 py-3">
                {r.action === "buy" ? (
                  <Badge variant="gain">Buy {formatMoney(r.tradeAmount, "CAD")}</Badge>
                ) : r.action === "sell" ? (
                  <Badge variant="loss">Sell {formatMoney(r.tradeAmount, "CAD")}</Badge>
                ) : r.sellSkipped ? (
                  <span className="text-xs text-muted">Overweight — buy-only, no sell</span>
                ) : (
                  <span className="text-xs text-muted">Within ±{formatPct(threshold, threshold * 100 % 1 ? 1 : 0)}</span>
                )}
                {extra?.(r)}
              </td>
              <td className="px-2 py-3">
                <Button type="button" variant="ghost" size="icon" className="size-9" onClick={() => onRemove(r.id)} aria-label={`Remove target ${r.key}`}>
                  <X className="size-4" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line text-xs text-muted">
            <td className="px-4 py-3" colSpan={6}>
              {mode === "rebalance" ? (
                <>
                  Sell {formatMoney(summary.totalSell, "CAD")} · Buy {formatMoney(summary.totalBuy, "CAD")} ·{" "}
                  {summary.netCash >= 0 ? `New cash needed ${formatMoney(summary.netCash, "CAD")}` : `Cash freed ${formatMoney(-summary.netCash, "CAD")}`}
                </>
              ) : (
                <>Cash needed (buy-only): {formatMoney(summary.totalBuy, "CAD")}</>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
