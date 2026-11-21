import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AskPanel } from "@/components/lookthru/ask-panel";
import { CompositionCharts } from "@/components/lookthru/charts";
import { FundLookup, TickerCombobox, useFund } from "@/components/lookthru/fund-lookup";
import { LookthroughTable } from "@/components/lookthru/tables";
import { ForwardPeValue } from "@/components/lookthru/valuation-card";
import { Input } from "@/components/lookthru/ui/input";
import { Skeleton } from "@/components/lookthru/ui/skeleton";
import { analyzeHoldings } from "@/lib/lookthru/analyze";
import { contextFromLookthrough } from "@/lib/lookthru/ask";
import { composeEtfCad } from "@/lib/lookthru/compose-safe";
import { formatMoney, formatPct } from "@/lib/lookthru/format";
import { usePortfolio } from "@/lib/lookthru/store";
import { applyAlias } from "@/lib/lookthru/tickers";

/**
 * Tab 1 — ETF breakdown: pick one fund and see only what it owns, unrolled to single stocks by the
 * same look-through engine as the portfolio. Valued at an amount in CAD (default C$10,000).
 */
export function EtfBreakdown() {
  const ticker = usePortfolio((s) => s.etfTicker);
  const amount = usePortfolio((s) => s.etfAmount);
  const setEtf = usePortfolio((s) => s.setEtf);
  const [amountText, setAmountText] = useState(String(amount));
  const [provider, setProvider] = useState<string | undefined>(undefined);

  const symbol = ticker ? applyAlias(ticker) : "";
  const query = useQuery({
    queryKey: ["lookthru", [symbol]],
    enabled: Boolean(symbol),
    staleTime: 5 * 60 * 1000,
    queryFn: () => analyzeHoldings({ data: { tickers: [symbol] } }),
  });
  const fund = useFund(ticker || null);
  const fundMeta = fund.data?.status === "ok" ? fund.data : null;

  const composed = useMemo(() => {
    if (!query.data || !ticker) return null;
    return composeEtfCad(ticker, amount, query.data);
  }, [query.data, ticker, amount]);
  const result = composed?.result ?? null;

  const context = useMemo(() => {
    if (!result || !ticker) return null;
    return contextFromLookthrough(result, {
      ticker: result.positions[0]?.resolved ?? ticker,
      name: fundMeta?.name || result.positions[0]?.name,
      provider,
      asOf: fundMeta?.asOf ?? result.positions[0]?.asOf,
      source: fundMeta?.source,
    });
  }, [result, ticker, fundMeta, provider]);

  function applyAmount(text: string) {
    const n = Number(text.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) setEtf(ticker, n);
  }

  const pos = result?.positions[0];
  const stockCount = result?.leaves.filter((l) => l.kind === "equity").length ?? 0;
  const cash = result?.leaves.filter((l) => l.kind === "cash").reduce((s, l) => s + l.weight, 0) ?? 0;

  return (
    <div className="space-y-4">
      <section className="rounded-xl bg-surface p-4 border border-line sm:p-5">
        <TickerCombobox
          key={ticker || "empty"}
          initial={ticker}
          label="ETF ticker"
          button="Break down"
          onPick={(t, hit) => {
            setProvider(hit?.provider || undefined);
            setEtf(t, amount);
          }}
        >
          <label className="w-full space-y-1.5 sm:w-36">
            <span className="text-xs font-medium tracking-wide text-muted">Amount (C$)</span>
            <Input
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              onBlur={(e) => applyAmount(e.target.value)}
              className="font-mono tabular-nums"
              aria-label="Amount in CAD"
            />
          </label>
        </TickerCombobox>
        <p className="mt-2 text-xs text-muted">
          Shows only this fund&apos;s underlying holdings — every layer of funds-of-funds unrolled to single
          stocks — valued as if you held the amount above in CAD. Your portfolio is not changed.
        </p>
      </section>

      {!ticker ? (
        <section className="rounded-xl bg-surface px-5 py-10 text-center border border-line">
          <p className="font-medium text-2xl tracking-tight">Pick one ETF to unroll</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Try BMAX, HMAX, HYLD or XEQT. Funds that hold other funds are opened all the way down.
          </p>
        </section>
      ) : query.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : query.isError ? (
        <p className="rounded-xl bg-surface p-6 text-sm text-muted border border-line">
          Could not load market data. Try again in a moment.
        </p>
      ) : composed?.error ? (
        <p className="rounded-xl bg-surface p-6 text-sm text-down border border-down/40">{composed.error}</p>
      ) : result && pos && result.nav > 0 ? (
        <>
          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line border border-line sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: "Fund", value: pos.name || pos.ticker, small: true },
              { label: "Price", value: formatMoney(pos.value / pos.shares, "CAD", true) },
              { label: "Underlying names", value: String(stockCount) },
              { label: "Equity exposure", value: formatPct(result.equityExposure, 0) },
              { label: "Cash & leverage", value: formatPct(cash) },
              { label: "Forward P/E", value: <ForwardPeValue leaves={result.leaves} /> },
            ].map((k) => (
              <div key={k.label} className="bg-surface px-4 py-4">
                <p className="text-[11px] tracking-wide text-muted uppercase">{k.label}</p>
                <p className={k.small ? "mt-1 truncate text-sm text-fg" : "mt-1 font-mono text-lg tabular-nums text-fg"}>
                  {k.value}
                </p>
              </div>
            ))}
          </section>
          {result.warnings.length ? <p className="text-xs text-muted">{result.warnings.join(" ")}</p> : null}
          {context ? <AskPanel context={context} /> : null}
          <LookthroughTable
            result={result}
            limit={600}
            weightLabel="Of fund"
            foldNote="more names not shown."
          />
          <CompositionCharts result={result} />
          <details className="rounded-xl border border-line bg-surface p-4 sm:p-5">
            <summary className="cursor-pointer text-sm font-medium">
              Fund details — direct holdings (one layer), total return, valuation
            </summary>
            <div className="mt-4">
              <FundLookup ticker={ticker} />
            </div>
          </details>
        </>
      ) : (
        <section className="rounded-xl bg-surface px-5 py-8 text-center border border-line">
          <p className="font-medium text-lg tracking-tight">No price or holdings for {ticker}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            {result?.unresolved.length ? `Could not resolve ${result.unresolved.join(", ")}. ` : ""}
            Check the ticker (Canadian listings end in .TO or .NE).
          </p>
        </section>
      )}
    </div>
  );
}
