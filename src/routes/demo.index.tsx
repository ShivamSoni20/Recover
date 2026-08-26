import { useEffect, useState } from "react";
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
import { formatINR } from "@/lib/demo/types";
import { getMetricsFn, getCasesListFn } from "@/lib/api/server-fns";

const title = "Recover — AI revenue recovery for failed payments";
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
  const [cases, setCases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverMetrics, setServerMetrics] = useState<{
    casesCount: number;
    totalAtRiskMinor: number;
    totalRecoveredMinor: number;
    recoveryRate: number;
  } | null>(null);

  useEffect(() => {
    Promise.all([getMetricsFn(), getCasesListFn()])
      .then(([metrics, caseList]) => {
        setServerMetrics(metrics);
        setCases(caseList || []);
      })
      .catch((err) => console.error("[Overview Error]:", err))
      .finally(() => setLoading(false));
  }, []);

  const atRisk = serverMetrics?.totalAtRiskMinor ?? 0;
  const recovered = serverMetrics?.totalRecoveredMinor ?? 0;
  const rate = serverMetrics?.recoveryRate ?? 0;
  const hasCases = (serverMetrics?.casesCount ?? cases.length) > 0;

  const adaptedCases = cases.map((c) => ({
    caseId: c.case_number,
    orderId: c.original_order_id,
    originalPaymentId: c.original_payment_id,
    amountMinor: Number(c.amount_minor),
    currency: c.currency,
    paymentStatus: c.status,
    failureReason: c.failure_reason,
    failureDetail: c.failure_detail,
    method: c.method || "UPI",
    failedAt: c.failed_at ? new Date(c.failed_at).toLocaleTimeString() : null,
    confidence: c.recovery_diagnoses?.[0]?.confidence
      ? Math.round(Number(c.recovery_diagnoses[0].confidence) * 100)
      : 0,
    failureClass: c.recovery_diagnoses?.[0]?.failure_class || "UNKNOWN",
    diagnosis: c.recovery_diagnoses?.[0]?.summary || "",
    recoveryStrategy: c.action_authorizations?.[0]?.strategy || "FRESH_CHECKOUT",
    gateChecks: [],
    recoveryReference: c.recovery_actions?.[0]?.reference_id || "",
    recoveryLinkId: c.recovery_actions?.[0]?.payment_link_id || "",
    recoveryPaymentId: c.recovery_actions?.[0]?.recovery_payment_id || "",
    verificationChecks: [],
    state: c.terminal_status || c.status,
    events: [],
    customer: {
      name: c.customer_name || "Customer",
      email: c.customer_email || "customer@example.com",
      purpose: "Payment Recovery",
    },
    description: c.description || "Recover Case",
  }));

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
            <h2 className="text-sm font-bold text-foreground">Recovery Overview</h2>
            <span className="rounded-full bg-brand-softer px-2 py-0.5 text-[10px] font-bold tracking-wide text-brand uppercase">
              Supabase Database
            </span>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <DemoMetric label="Recovery cases" value={String(serverMetrics?.casesCount ?? 0)} />
            <DemoMetric label="Revenue at risk" value={formatINR(atRisk)} tone="danger" />
            <DemoMetric label="Recovered" value={formatINR(recovered)} tone="success" />
            <DemoMetric label="Recovery rate" value={`${rate}%`} tone="brand" />
          </div>

          <div className="mt-6 space-y-3">
            {adaptedCases.map((c) => (
              <DemoCaseRow key={c.caseId} demoCase={c as any} />
            ))}
            <div className="flex flex-wrap gap-3 pt-2">
              <DemoButton onClick={() => navigate({ to: "/demo/create" })}>
                Create another test payment <ArrowRight className="h-4 w-4" />
              </DemoButton>
              <Link
                to="/demo/history"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
              >
                View case history
              </Link>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
