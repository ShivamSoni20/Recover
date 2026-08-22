import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import { DemoButton } from "@/components/demo/ui";
import { ProofStrip, RecoveryTimelineDrawer, VerificationReceipt } from "@/components/demo/proof";
import { getCaseFn } from "@/lib/api/server-fns";
import { formatINRMinor } from "@/lib/domain/money";

const title = "Revenue recovered — verified | Recover";
const description =
  "The failed payment was recovered through a fresh checkout and independently verified against canonical payment state.";

export const Route = createFileRoute("/demo/recovery/$id/result")({
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
  component: RecoveryResult,
});

function RecoveryResult() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [caseData, setCaseData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    getCaseFn({ data: id })
      .then((data) => {
        setCaseData(data);
        // Guard route: if not verified, redirect to verify or case screen
        if (!data || data.terminal_status !== "RECOVERED_VERIFIED") {
          navigate({ to: "/demo/payment/$id", params: { id } });
        }
      })
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, [id, navigate]);

  if (loading || !caseData) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center px-6 py-24 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="mt-4 text-sm font-semibold text-foreground">Loading verified receipt...</p>
      </main>
    );
  }

  const receipt = caseData.verification_receipts?.[0];
  const action = caseData.recovery_actions?.[0];
  const events = caseData.case_events || [];

  const demoCaseAdapter = {
    caseId: caseData.case_number,
    orderId: caseData.original_order_id,
    originalPaymentId: caseData.original_payment_id,
    amountMinor: Number(caseData.amount_minor),
    currency: caseData.currency,
    paymentStatus: "CAPTURED" as const,
    failureReason: caseData.failure_reason,
    failureDetail: caseData.failure_detail,
    method: caseData.method || "Card / UPI",
    failedAt: caseData.failed_at ? new Date(caseData.failed_at).toLocaleTimeString() : null,
    confidence: 100,
    failureClass: "CUSTOMER_CORRECTABLE",
    diagnosis: "",
    recoveryStrategy: "FRESH_CHECKOUT",
    gateChecks: [],
    recoveryReference: action?.reference_id || "rcv_ref",
    recoveryLinkId: receipt?.recovery_link_id || action?.payment_link_id || "plink_verified",
    recoveryPaymentId: receipt?.recovery_payment_id || action?.recovery_payment_id || "pay_verified",
    verificationChecks: [],
    state: "RECOVERED_VERIFIED" as any,
    events: events.map((e: any) => ({
      time: new Date(e.created_at).toLocaleTimeString(),
      label: e.label,
    })),
    customer: {
      name: caseData.customer_name || "Customer",
      email: caseData.customer_email || "customer@example.com",
      purpose: "Payment Recovery",
    },
    description: caseData.description || "Recover Case",
  };

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          {formatINRMinor(caseData.amount_minor)} recovered.
        </h1>
        <p className="mt-2 text-sm font-semibold text-success">Revenue recovered — VERIFIED</p>
      </div>

      <ProofStrip className="mt-8" />

      <div className="mt-8">
        <VerificationReceipt demoCase={demoCaseAdapter} />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <DemoButton onClick={() => navigate({ to: "/demo/create" })}>
          Run another test <ArrowRight className="h-4 w-4" />
        </DemoButton>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Return to landing page
        </Link>
        <DemoButton variant="outline" onClick={() => setDrawerOpen(true)}>
          View recovery timeline
        </DemoButton>
      </div>

      <RecoveryTimelineDrawer open={drawerOpen} onOpenChange={setDrawerOpen} demoCase={demoCaseAdapter} />
    </main>
  );
}
