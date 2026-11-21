import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Toaster, toast } from "sonner";
import { Header } from "@/components/lookthru/header";
import { CompositionCharts } from "@/components/lookthru/charts";
import { PortfolioEditor } from "@/components/lookthru/editor";
import { Kpis } from "@/components/lookthru/kpis";
import { LookthroughTable, PositionsTable } from "@/components/lookthru/tables";
import { HoldingsTree } from "@/components/lookthru/tree";
import { EtfBreakdown } from "@/components/lookthru/etf-breakdown";
import { RebalanceTab } from "@/components/lookthru/rebalance";
import { Skeleton } from "@/components/lookthru/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/lookthru/ui/tabs";
import { analyzeHoldings } from "@/lib/lookthru/analyze";
import { composeCad } from "@/lib/lookthru/compose-safe";
import { usePortfolio, type AppTab } from "@/lib/lookthru/store";
import { applyAlias } from "@/lib/lookthru/tickers";

export function LookthruApp() {
  const hydrated = usePortfolio((s) => s.hydrated);
  const positions = usePortfolio((s) => s.positions);
  const tab = usePortfolio((s) => s.tab);
  const setTab = usePortfolio((s) => s.setTab);
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

  // Everything is in CAD. A USD holding with no USD→CAD rate gives an error, never a guessed rate.
  const composed = useMemo(() => (analysis ? composeCad(positions, analysis) : null), [analysis, positions]);
  const result = composed?.result ?? null;
  const fxError = composed?.error ?? null;

  // Loading while a portfolio exists but has no result yet, otherwise the empty prompt.
  const portfolioPlaceholder = fxError ? (
    <p className="rounded-xl bg-surface p-6 text-sm text-down border border-down/40">{fxError}</p>
  ) : tickers.length > 0 ? (
    <LoadingState />
  ) : (
    <EmptyState />
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <Toaster theme="dark" position="bottom-right" />
      <Header />

      <p className="max-w-2xl text-xl font-medium tracking-tight">
        See the stocks inside your ETFs.
      </p>
      <p className="max-w-2xl text-sm text-muted">
        Lookthru unrolls Hamilton, Harvest, Evolve, Purpose, Global X, Brompton and iShares wrappers —
        including funds that hold other funds — into the stocks, gold and crypto you actually own.
      </p>

      <Tabs value={tab} onValueChange={(v) => setTab(v as AppTab)}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="etf">ETF breakdown</TabsTrigger>
          <TabsTrigger value="portfolio">Full portfolio</TabsTrigger>
          <TabsTrigger value="rebalance">Target &amp; rebalance</TabsTrigger>
        </TabsList>

        <TabsContent value="etf" forceMount className="data-[state=inactive]:hidden">
          <EtfBreakdown />
        </TabsContent>

        <TabsContent value="portfolio" className="space-y-5">
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

          <Tabs defaultValue="lookthrough">
            <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
              <TabsTrigger value="lookthrough">Look-through</TabsTrigger>
              <TabsTrigger value="positions">Positions</TabsTrigger>
              <TabsTrigger value="tree">Nested tree</TabsTrigger>
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
          </Tabs>
        </TabsContent>

        <TabsContent value="rebalance">
          <RebalanceTab result={result} error={fxError} />
        </TabsContent>
      </Tabs>

      <footer className="border-t border-line pt-4 text-[11px] text-subtle">
        All amounts in CAD; USD prices are converted at the USD→CAD rate shown at the top.
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
        ETFs that nest all the way down to names like RY, NVDA and AAPL. Or open ETF breakdown to
        inspect a single fund without building a portfolio.
      </p>
    </section>
  );
}
