import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Bot,
  CircleAlert,
  ListChecks,
  RefreshCcw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { DemoButton, DemoMetric, Panel } from "@/components/demo/ui";
import { DemoCaseRow } from "@/components/demo/proof";
import { useDemoStore } from "@/lib/demo/store";
import { formatINR } from "@/lib/demo/types";

const title = "Recover Demo — watch a failed payment get recovered";
const description =
  "Create your own test payment, fail it deliberately, and watch Recover diagnose, authorize, recover and independently verify it.";

export const Route = createFileRoute("/demo/")({
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
  component: DemoWelcome,
});

const flow = [
  { icon: ListChecks, label: "Create", copy: "You choose the payment." },
  { icon: CircleAlert, label: "Fail", copy: "The payment attempt fails." },
  { icon: Bot, label: "Diagnose", copy: "AI understands why it failed." },
  {
    icon: ShieldCheck,
    label: "Authorize",
    copy: "Deterministic rules decide whether recovery is safe.",
  },
  { icon: Zap, label: "Recover", copy: "A fresh checkout is created." },
  { icon: RefreshCcw, label: "Verify", copy: "Success is independently confirmed." },
];

function DemoWelcome() {
  const navigate = useNavigate();
  const { cases } = useDemoStore();

  const atRisk = cases.reduce((sum, c) => sum + c.amountMinor, 0);
  const recovered = cases
    .filter((c) => c.state === "RECOVERED_VERIFIED")
    .reduce((sum, c) => sum + c.amountMinor, 0);
  const rate = atRisk ? Math.round((recovered / atRisk) * 100) : 0;
  const hasCases = cases.length > 0;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <h1 className="max-w-2xl text-3xl font-extrabold leading-tight tracking-tight text-foreground sm:text-4xl">
        Make a payment fail.
        <br />
        Watch <span className="text-brand">Recover</span> bring it back.
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
        You&apos;ll create a test payment, deliberately fail it, let Recover diagnose the failure,
        recover it through a fresh checkout, and verify the result.
      </p>

      {!hasCases ? (
        <>
          <ol className="mt-10 grid gap-y-7 sm:grid-cols-2 lg:grid-cols-6 lg:gap-x-2">
            {flow.map(({ icon: Icon, label, copy }, i) => (
              <li key={label} className="relative pr-4">
                {i < flow.length - 1 ? (
                  <span className="absolute top-4 left-9 hidden h-px w-[calc(100%-2.25rem)] bg-border lg:block" />
                ) : null}
                <span className="relative flex h-8 w-8 items-center justify-center rounded-full border border-brand-soft bg-brand-softer text-brand">
                  <Icon className="h-4 w-4" />
                </span>
                <p className="mt-3 text-[11px] font-bold tracking-wide text-foreground uppercase">
                  {label}
                </p>
                <p className="mt-1 max-w-[13rem] text-[11px] leading-5 text-muted-foreground">
                  {copy}
                </p>
              </li>
            ))}
          </ol>

          <Panel className="mt-10 px-6 py-10 text-center">
            <p className="text-base font-bold tracking-tight text-foreground">
              No recovery cases yet.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Create one yourself and watch the full recovery machine run.
            </p>
            <DemoButton className="mt-6" onClick={() => navigate({ to: "/demo/create" })}>
              Create a Test Payment <ArrowRight className="h-4 w-4" />
            </DemoButton>
            <p className="mt-3 text-[11px] text-muted-foreground">
              No signup required · about 60 seconds
            </p>
          </Panel>

          <div className="mt-6 rounded-2xl border border-brand-soft bg-brand-softer px-6 py-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {["AI reasons", "Code authorizes", "Provider proves"].map((s, i) => (
                <span key={s} className="flex items-center gap-3">
                  <span className="rounded-full border border-brand-soft bg-card px-3 py-1 text-[11px] font-bold tracking-wide text-brand uppercase">
                    {s}
                  </span>
                  {i < 2 ? <ArrowRight className="h-3.5 w-3.5 text-brand" /> : null}
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              AI can recommend an action. It cannot authorize or verify money.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="mt-10 flex items-center gap-3">
            <h2 className="text-sm font-bold text-foreground">Recovery overview</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
              Demo data
            </span>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <DemoMetric label="Recovery cases" value={String(cases.length)} />
            <DemoMetric label="Revenue at risk" value={formatINR(atRisk)} tone="danger" />
            <DemoMetric label="Recovered" value={formatINR(recovered)} tone="success" />
            <DemoMetric label="Recovery rate" value={`${rate}%`} tone="brand" />
          </div>

          <div className="mt-6 space-y-3">
            {cases.map((c) => (
              <DemoCaseRow key={c.caseId} demoCase={c} />
            ))}
            <div className="flex flex-wrap gap-3 pt-2">
              <DemoButton onClick={() => navigate({ to: "/demo/create" })}>
                Create another test payment <ArrowRight className="h-4 w-4" />
              </DemoButton>
              <Link
                to="/demo/history"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
              >
                View demo history
              </Link>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
