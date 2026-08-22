import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DemoButton, Panel } from "@/components/demo/ui";
import { DemoCaseRow } from "@/components/demo/proof";
import { getCasesListFn } from "@/lib/api/server-fns";

const title = "Case history — Recover";
const description = "Every recovery case processed by Recover in Razorpay Test Mode.";

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
  const [cases, setCases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCasesListFn()
      .then((data) => setCases(data || []))
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, []);

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
    confidence: c.recovery_diagnoses?.[0]?.confidence ? Math.round(Number(c.recovery_diagnoses[0].confidence) * 100) : 0,
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
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Recovery Cases</h1>
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold tracking-wide text-brand uppercase">
          Supabase Database
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Live database records persisted in PostgreSQL for Razorpay Test Mode sessions.
      </p>

      <div className="mt-8 space-y-3">
        {adaptedCases.length === 0 ? (
          <Panel className="px-6 py-10 text-center">
            <p className="text-sm font-semibold text-foreground">No recovery cases in database yet.</p>
            <DemoButton className="mt-5" onClick={() => navigate({ to: "/demo/create" })}>
              Create Test Payment
            </DemoButton>
          </Panel>
        ) : (
          adaptedCases.map((c) => <DemoCaseRow key={c.caseId} demoCase={c as any} />)
        )}
      </div>
    </main>
  );
}
