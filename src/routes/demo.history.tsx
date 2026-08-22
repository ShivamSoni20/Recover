import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DemoButton, Panel } from "@/components/demo/ui";
import { DemoCaseRow } from "@/components/demo/proof";
import { useDemoStore } from "@/lib/demo/store";

const title = "Demo case history — Recover";
const description = "Every recovery case created during this interactive Recover demo session.";

export const Route = createFileRoute("/demo/history")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DemoHistory,
});

function DemoHistory() {
  const navigate = useNavigate();
  const { cases } = useDemoStore();

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Demo cases</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
          Demo data
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Cases are stored locally in your browser for this demo session only.
      </p>

      <div className="mt-8 space-y-3">
        {cases.length === 0 ? (
          <Panel className="px-6 py-10 text-center">
            <p className="text-sm font-semibold text-foreground">No demo cases yet.</p>
            <DemoButton className="mt-5" onClick={() => navigate({ to: "/demo/create" })}>
              Create Test Payment
            </DemoButton>
          </Panel>
        ) : (
          cases.map((c) => <DemoCaseRow key={c.caseId} demoCase={c} />)
        )}
      </div>
    </main>
  );
}
