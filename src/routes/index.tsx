import { createFileRoute } from "@tanstack/react-router";
import { LookthruApp } from "@/components/lookthru/app";

export const Route = createFileRoute("/")({
  component: () => (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <LookthruApp />
    </main>
  ),
});
