import { Layers } from "lucide-react";
import { FxBadge } from "@/components/lookthru/fx-badge";

export function Header() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-elevated border border-line">
          <Layers className="size-4 text-accent" strokeWidth={1.5} />
        </span>
        <div>
          <p className="font-medium text-2xl leading-none tracking-tight">Portfolio X-ray</p>
          <p className="mt-1 text-xs text-muted">ETF look-through · underlying stocks</p>
        </div>
      </div>
      <FxBadge />
    </header>
  );
}
