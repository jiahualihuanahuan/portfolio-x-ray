import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Toaster, toast } from "sonner";
import { Header } from "@/components/lookthru/header";
import { CompositionCharts } from "@/components/lookthru/charts";
import { PortfolioEditor } from "@/components/lookthru/editor";
import { Kpis } from "@/components/lookthru/kpis";
import { LookthroughTable, PositionsTable } from "@/components/lookthru/tables";
import { HoldingsTree } from "@/components/lookthru/tree";
import { FundLookup } from "@/components/lookthru/fund-lookup";
import { Skeleton } from "@/components/lookthru/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/lookthru/ui/tabs";
import { analyzeHoldings } from "@/lib/lookthru/analyze";
import { composeLookthrough } from "@/lib/lookthru/lookthrough";
import { usePortfolio } from "@/lib/lookthru/store";
import { applyAlias } from "@/lib/lookthru/tickers";

export function LookthruApp() {
  const hydrated = usePortfolio((s) => s.hydrated);
  const positions = usePortfolio((s) => s.positions);
  const currency = usePortfolio((s) => s.currency);
  const setCurrency = usePortfolio((s) => s.setCurrency);
  const addPosition = usePortfolio((s) => s.addPosition);
  const addMany = usePortfolio((s) => s.addMany);
  const updateShares = usePortfolio((s) => s.updateShares);
  const removePosition = usePortfolio((s) => s.removePosition);
  const loadSample = usePortfolio((s) => s.loadSample);
  const clear = usePortfolio((s) => s.clear);
  const setHydrated = usePortfolio((s) => s.setHydrated);

  useEffect(() => {
    const unsub = usePortfolio.persist.onFinishHydration(() => setHydrated());
    if (usePortfolio.persist.hasHydrated()) setHydrated();
    else usePortfolio.persist.rehydrate();
    const t = window.setTimeout(() => setHydrated(), 400);
    return () => {
      unsub();
      window.clearTimeout(t);
    };
  }, [setHydrated]);

  const tickers = useMemo(
    () => [...new Set(positions.map((p) => applyAlias(p.ticker)))],
    [positions],
  );

  const liveRef = useRef(false);
  const query = useQuery({
    queryKey: ["lookthru", tickers],
    enabled: hydrated && tickers.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: () => analyzeHoldings({ data: { tickers, live: liveRef.current } }),
  });

  useEffect(() => {
    const onRefresh = () => {
      liveRef.current = true;
      void query.refetch().finally(() => {
        liveRef.current = false;
      });
    };
    window.addEventListener("desk-refresh", onRefresh);
    return () => window.removeEventListener("desk-refresh", onRefresh);
  }, [query]);

  useEffect(() => {
    if (query.error) toast.error("Could not load market data. Try again in a moment.");
  }, [query.error]);

  const analysis = query.data;

  const result = useMemo(() => {
    if (!analysis) return null;
    return composeLookthrough(
      positions,
      analysis.instruments,
      analysis.aliases,
      analysis.fxUsdCad,
      currency,
      analysis.warnings,
    );
  }, [analysis, positions, currency]);

  // Same states as before the tabs became always-visible: loading while a portfolio
  // exists but has no result yet, otherwise the empty prompt.
  const portfolioPlaceholder = tickers.length > 0 ? <LoadingState /> : <EmptyState />;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <Toaster theme="dark" position="bottom-right" />
      <Header currency={currency} onCurrency={setCurrency} />

      <p className="max-w-2xl text-xl font-medium tracking-tight">
        See the stocks inside your ETFs.
      </p>
      <p className="max-w-2xl text-sm text-muted">
        Lookthru unrolls Hamilton, Harvest, Evolve, Purpose, Global X and iShares wrappers —
        including the Harvest High Income Shares inside HHIS and nested XEQT — into the stocks,
        gold and crypto you actually own.
      </p>

      <PortfolioEditor
        onAdd={addPosition}
        onPaste={addMany}
        onSample={loadSample}
        onClear={clear}
        disabled={!hydrated}
      />

      {result ? (
        <>
          <Kpis result={result} />
          {result.warnings.length ? (
            <p className="text-xs text-muted">{result.warnings[0]}</p>
          ) : null}
          {result.unresolved.length ? (
            <p className="text-xs text-down">Unresolved: {result.unresolved.join(", ")}</p>
          ) : null}
          <CompositionCharts result={result} />
        </>
      ) : null}

      {/* Tabs are always reachable so Fund Lookup works without a portfolio; the three
          portfolio tabs show the same loading / empty / error states as before. */}
      <Tabs defaultValue="lookthrough">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="lookthrough">Look-through</TabsTrigger>
          <TabsTrigger value="positions">Positions</TabsTrigger>
          <TabsTrigger value="tree">Nested tree</TabsTrigger>
          <TabsTrigger value="fund">Fund Lookup</TabsTrigger>
        </TabsList>
        <TabsContent value="lookthrough">
          {result ? <LookthroughTable result={result} /> : portfolioPlaceholder}
        </TabsContent>
        <TabsContent value="positions">
          {result ? (
            <PositionsTable result={result} onShares={updateShares} onRemove={removePosition} />
          ) : (
            portfolioPlaceholder
          )}
        </TabsContent>
        <TabsContent value="tree">
          {result ? <HoldingsTree result={result} /> : portfolioPlaceholder}
        </TabsContent>
        <TabsContent value="fund" forceMount className="data-[state=inactive]:hidden">
          <FundLookup />
        </TabsContent>
      </Tabs>

      <footer className="border-t border-line pt-4 text-[11px] text-subtle">
        Quotes delayed via Yahoo Finance. ETF weights come from each issuer’s latest
        holdings file when available, then Yahoo, then last disclosed snapshots. Leverage
        (negative cash) can push equity exposure above 100%. Not investment advice.
      </footer>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function EmptyState() {
  return (
    <section className="rounded-xl bg-surface px-5 py-10 text-center border border-line">
      <p className="font-medium text-2xl tracking-tight">Add a holding to unroll it</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        Try HDIV.TO for a Canadian covered-call wrapper, XLK for US tech, or HYLD.TO — funds of
        ETFs that nest all the way down to names like RY, NVDA and AAPL. Or open Fund Lookup to
        inspect a single fund without building a portfolio.
      </p>
    </section>
  );
}
