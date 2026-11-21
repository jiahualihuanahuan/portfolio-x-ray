import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SAMPLE_POSITIONS } from "./catalog";
import { normalizeTicker } from "./tickers";
import { assignTicker, type Bucket } from "./core-satellite";
import { type RebalanceMode, type Target, type TargetKind } from "./rebalance";
import type { CurrencyCode, Position } from "./types";

export type AppTab = "etf" | "portfolio" | "rebalance";

type PortfolioState = {
  hydrated: boolean;
  positions: Position[];
  currency: CurrencyCode;
  setHydrated: () => void;
  setCurrency: (c: CurrencyCode) => void;
  addPosition: (ticker: string, shares: number, currency?: "CAD" | "USD") => void;
  addMany: (rows: { ticker: string; shares: number; currency?: "CAD" | "USD" }[]) => void;
  /** Confirm a holding's currency (Needs your confirmation list). */
  setPositionCurrency: (id: string, currency: "CAD" | "USD") => void;
  /** Replace a holding's ticker (merges into an existing row with the new ticker). */
  fixTicker: (id: string, ticker: string, currency?: "CAD" | "USD") => void;
  updateShares: (id: string, shares: number) => void;
  removePosition: (id: string) => void;
  loadSample: () => void;
  clear: () => void;
  // Shared across tabs and persisted with the portfolio.
  tab: AppTab;
  setTab: (t: AppTab) => void;
  etfTicker: string;
  etfAmount: number;
  setEtf: (ticker: string, amount: number) => void;
  targets: Target[];
  /** null = use the server default (REBALANCE_THRESHOLD_PCT, 10% if unset). */
  threshold: number | null;
  mode: RebalanceMode;
  addTarget: (kind: TargetKind, key: string, amount: number) => void;
  updateTarget: (id: string, amount: number) => void;
  removeTarget: (id: string) => void;
  clearTargets: () => void;
  setThreshold: (t: number | null) => void;
  setMode: (m: RebalanceMode) => void;
  // Core–satellite buckets (Target & rebalance tab).
  buckets: Bucket[];
  addBucket: (role: Bucket["role"]) => void;
  updateBucket: (id: string, patch: Partial<Omit<Bucket, "id">>) => void;
  removeBucket: (id: string) => void;
  /** Move a ticker into one bucket (removed from all others); null = Unassigned. */
  assignTicker: (ticker: string, bucketId: string | null) => void;
};

function nid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toPositions(rows: { ticker: string; shares: number; currency?: "CAD" | "USD" }[]): Position[] {
  return rows.map((r) => ({
    id: nid(),
    ticker: normalizeTicker(r.ticker),
    shares: r.shares,
    ...(r.currency ? { currency: r.currency } : {}),
  }));
}

export const usePortfolio = create<PortfolioState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      positions: toPositions(SAMPLE_POSITIONS),
      currency: "CAD",
      setHydrated: () => set({ hydrated: true }),
      // CAD-only since the CAD switch; kept so older callers compile.
      setCurrency: () => set({ currency: "CAD" }),
      addPosition: (ticker, shares, currency) => {
        const t = normalizeTicker(ticker);
        if (!t || !Number.isFinite(shares) || shares === 0) return;
        const existing = get().positions.find((p) => p.ticker === t);
        if (existing) {
          set({
            positions: get().positions.map((p) =>
              p.id === existing.id
                ? { ...p, shares: p.shares + shares, ...(currency ? { currency } : {}) }
                : p,
            ),
          });
          return;
        }
        set({
          positions: [
            ...get().positions,
            { id: nid(), ticker: t, shares, ...(currency ? { currency } : {}) },
          ],
        });
      },
      addMany: (rows) => {
        for (const row of rows) get().addPosition(row.ticker, row.shares, row.currency);
      },
      setPositionCurrency: (id, currency) =>
        set({ positions: get().positions.map((p) => (p.id === id ? { ...p, currency } : p)) }),
      fixTicker: (id, ticker, currency) => {
        const t = normalizeTicker(ticker);
        const row = get().positions.find((p) => p.id === id);
        if (!t || !row) return;
        const other = get().positions.find((p) => p.ticker === t && p.id !== id);
        if (other) {
          set({
            positions: get()
              .positions.filter((p) => p.id !== id)
              .map((p) =>
                p.id === other.id
                  ? { ...p, shares: p.shares + row.shares, ...(currency ? { currency } : {}) }
                  : p,
              ),
          });
          return;
        }
        set({
          positions: get().positions.map((p) => {
            if (p.id !== id) return p;
            const next: Position = { id: p.id, ticker: t, shares: p.shares };
            if (currency) next.currency = currency;
            return next;
          }),
        });
      },
      updateShares: (id, shares) => {
        if (!Number.isFinite(shares) || shares <= 0) return;
        set({
          positions: get().positions.map((p) => (p.id === id ? { ...p, shares } : p)),
        });
      },
      removePosition: (id) =>
        set({ positions: get().positions.filter((p) => p.id !== id) }),
      loadSample: () => set({ positions: toPositions(SAMPLE_POSITIONS) }),
      clear: () => set({ positions: [] }),
      tab: "portfolio",
      setTab: (tab) => set({ tab }),
      etfTicker: "",
      etfAmount: 10_000,
      setEtf: (etfTicker, etfAmount) =>
        set({
          etfTicker: normalizeTicker(etfTicker),
          etfAmount: Number.isFinite(etfAmount) && etfAmount > 0 ? etfAmount : 10_000,
        }),
      targets: [],
      threshold: null,
      mode: "rebalance",
      addTarget: (kind, key, amount) => {
        const k = kind === "ticker" ? normalizeTicker(key) : key.trim();
        if (!k || !Number.isFinite(amount) || amount < 0) return;
        const same = (t: Target) =>
          t.kind === kind && t.key.toLowerCase() === k.toLowerCase();
        const existing = get().targets.find(same);
        if (existing) {
          set({
            targets: get().targets.map((t) =>
              t.id === existing.id ? { ...t, amount } : t,
            ),
          });
          return;
        }
        set({ targets: [...get().targets, { id: nid(), kind, key: k, amount }] });
      },
      updateTarget: (id, amount) => {
        if (!Number.isFinite(amount) || amount < 0) return;
        set({ targets: get().targets.map((t) => (t.id === id ? { ...t, amount } : t)) });
      },
      removeTarget: (id) => set({ targets: get().targets.filter((t) => t.id !== id) }),
      clearTargets: () => set({ targets: [] }),
      setThreshold: (threshold) => {
        if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0)) return;
        set({ threshold });
      },
      setMode: (mode) => set({ mode }),
      buckets: [],
      addBucket: (role) => {
        const n = get().buckets.filter((b) => b.role === "satellite").length + 1;
        const b: Bucket =
          role === "core"
            ? { id: nid(), name: "Core", role, tickers: [], min: 0.54, max: 0.66 }
            : { id: nid(), name: `Satellite ${n}`, role, tickers: [], target: 0.1 };
        set({ buckets: [...get().buckets, b] });
      },
      updateBucket: (id, patch) =>
        set({ buckets: get().buckets.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
      removeBucket: (id) => set({ buckets: get().buckets.filter((b) => b.id !== id) }),
      assignTicker: (ticker, bucketId) => set({ buckets: assignTicker(get().buckets, ticker, bucketId) }),
    }),
    {
      name: "lookthru-book-v4",
      partialize: (s) => ({
        positions: s.positions,
        currency: s.currency,
        tab: s.tab,
        etfTicker: s.etfTicker,
        etfAmount: s.etfAmount,
        targets: s.targets,
        threshold: s.threshold,
        mode: s.mode,
        buckets: s.buckets,
      }),
      onRehydrateStorage: () => (state) => {
        // The app reports in CAD only; older saved books may still say USD.
        state?.setCurrency("CAD");
        state?.setHydrated();
      },
    },
  ),
);
