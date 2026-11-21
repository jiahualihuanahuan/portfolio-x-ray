import { createContext, useContext, useState, type ReactNode } from "react";
import { Badge } from "@/components/lookthru/ui/badge";
import { Button } from "@/components/lookthru/ui/button";
import { Input } from "@/components/lookthru/ui/input";
import type { ConfirmationItem, PositionCurrency } from "@/lib/lookthru/currency";
import { formatMoney } from "@/lib/lookthru/format";
import { usePortfolio } from "@/lib/lookthru/store";
import { normalizeTicker } from "@/lib/lookthru/tickers";

/** Currency facts per typed ticker (normalized), shared by every list that shows holdings. */
const CurrencyCtx = createContext<Record<string, PositionCurrency>>({});

export function CurrencyProvider({ value, children }: { value: Record<string, PositionCurrency>; children: ReactNode }) {
  return <CurrencyCtx.Provider value={value}>{children}</CurrencyCtx.Provider>;
}

export function useTickerCurrency(ticker: string): PositionCurrency | undefined {
  return useContext(CurrencyCtx)[normalizeTicker(ticker)];
}

/** Plain-text suffix for <option> labels: " · USD" / " · CDR". */
export function useCurrencyLabel() {
  const map = useContext(CurrencyCtx);
  return (ticker: string) => {
    const c = map[normalizeTicker(ticker)];
    if (!c) return "";
    if (c.currency === "USD") return " · USD";
    return c.cdrUnderlying ? " · CDR" : "";
  };
}

/** "USD" flag (with the rate used) or "CDR · KO" badge; nothing for ordinary CAD rows. */
export function CurrencyBadge({ ticker }: { ticker: string }) {
  const c = useTickerCurrency(ticker);
  if (!c) return null;
  if (c.currency === "USD") {
    const title = c.fx
      ? `Converted to CAD at ${c.fx.rate.toFixed(4)} (${c.fx.source === "manual" ? "FX_USDCAD_OVERRIDE" : c.fx.source === "prices-db" ? "prices.sqlite" : "saved rate"}, ${c.fx.date})${c.fx.exact ? "" : " — the latest rate on or before the price date"}`
      : "USD";
    return (
      <Badge variant="accent" title={title} className="ml-1.5 align-middle">
        USD{c.fx && !c.fx.exact ? ` · rate from ${c.fx.date}` : ""}
      </Badge>
    );
  }
  if (c.cdrUnderlying) {
    return (
      <Badge variant="outline" title="Canadian Depositary Receipt, traded in CAD. Underlying shown for reference only." className="ml-1.5 align-middle">
        CDR · {c.cdrUnderlying}
      </Badge>
    );
  }
  return null;
}

/** Native USD price under the CAD price in the Positions table. */
export function NativePrice({ ticker }: { ticker: string }) {
  const c = useTickerCurrency(ticker);
  if (!c || c.currency !== "USD" || c.nativePrice == null || !c.fx) return null;
  return (
    <div className="text-[11px] text-subtle">
      {formatMoney(c.nativePrice, "USD", true)} USD × {c.fx.rate.toFixed(4)}
    </div>
  );
}

/** Rows whose currency could not be determined: excluded from all totals and rebalancing until fixed. */
export function NeedsConfirmation({ items, compact = false }: { items: ConfirmationItem[]; compact?: boolean }) {
  if (!items.length) return null;
  if (compact) {
    return (
      <p className="rounded-xl border border-down/40 bg-surface px-4 py-3 text-xs text-down">
        {items.length} holding{items.length === 1 ? "" : "s"} ({items.map((i) => i.ticker).join(", ")}) need
        {items.length === 1 ? "s" : ""} your currency confirmation and {items.length === 1 ? "is" : "are"} left out of
        the totals, targets and rebalancing below. Confirm in Full portfolio.
      </p>
    );
  }
  return (
    <section className="rounded-xl border border-down/40 bg-surface">
      <div className="border-b border-line px-4 py-3">
        <p className="text-sm font-medium">Needs your confirmation</p>
        <p className="text-xs text-muted">
          These rows are excluded from totals, allocation, targets, deviation and rebalancing until you confirm the currency or fix the ticker.
        </p>
      </div>
      <ul>
        {items.map((it) => (
          <ConfirmRow key={it.id} item={it} />
        ))}
      </ul>
    </section>
  );
}

function ConfirmRow({ item }: { item: ConfirmationItem }) {
  const setCurrency = usePortfolio((s) => s.setPositionCurrency);
  const fixTicker = usePortfolio((s) => s.fixTicker);
  const [draft, setDraft] = useState("");
  const canPickCurrency = item.flag.kind === "ambiguous" || item.flag.kind === "unknown-usd" || item.flag.kind === "mismatch";
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-line/70 px-4 py-3 last:border-0">
      <span className="font-mono text-sm">{item.ticker}</span>
      <span className="text-xs text-muted">{item.shares} sh</span>
      <span className="min-w-[200px] flex-1 text-xs text-down">
        {item.flag.message}
        {item.flag.kind === "no-rate" ? " Set FX_USDCAD_OVERRIDE or wait for the daily price fetch." : ""}
      </span>
      {canPickCurrency ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setCurrency(item.id, "CAD")}>
            CAD{item.flag.cadListing ? ` (${item.flag.cadListing})` : ""}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCurrency(item.id, "USD")}>
            USD
          </Button>
        </>
      ) : null}
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) fixTicker(item.id, draft.trim());
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Fix ticker"
          aria-label={`Fix ticker for ${item.ticker}`}
          className="h-8 w-32 font-mono uppercase"
        />
        <Button size="sm" type="submit" variant="outline" disabled={!draft.trim()}>
          Apply
        </Button>
      </form>
    </li>
  );
}
