import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Loader2, ShieldAlert } from "lucide-react";
import { DemoButton } from "@/components/demo/ui";
import { ProofStrip, RecoveryTimelineDrawer, VerificationReceipt, type VerificationReceiptView } from "@/components/demo/proof";
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
        <p className="mt-4 text-sm font-semibold text-foreground">Loading verified receipt from database...</p>
      </main>
    );
  }

  const receipt = caseData.verification_receipts?.[0];
  const action = caseData.recovery_actions?.[0];
  const authorization = caseData.action_authorizations?.[0];
  const events = (caseData.case_events || []).map((e: any) => ({
    time: new Date(e.created_at).toLocaleTimeString(),
    label: e.label,
  }));

  // Strict check: if receipt record is missing, do not render fake success
  if (!receipt || receipt.status !== "VERIFIED") {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <h1 className="mt-4 text-xl font-bold tracking-tight text-foreground">
          Verification record incomplete
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Canonical provider verification receipt could not be validated.
        </p>
        <DemoButton className="mt-6" onClick={() => navigate({ to: "/demo/payment/$id", params: { id } })}>
          Back to case details
        </DemoButton>
      </main>
    );
  }

  const receiptView: VerificationReceiptView = {
    receiptId: receipt.id,
    originalOrderId: receipt.original_order_id,
    originalPaymentId: receipt.original_payment_id,
    recoveryLinkId: receipt.recovery_link_id,
    recoveryReferenceId: action?.reference_id,
    recoveryPaymentId: receipt.recovery_payment_id,
    amountMinor: Number(receipt.amount_minor),
    currency: receipt.currency,
    status: receipt.status,
    verifiedAt: receipt.verified_at,
    checks: receipt.checks_passed || [],
  };

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          {formatINRMinor(receipt.amount_minor)} recovered.
        </h1>
        <p className="mt-2 text-sm font-semibold text-success">Revenue recovered — VERIFIED</p>
      </div>

      <ProofStrip
        originalStatus="FAILED"
        recoveryStrategy={authorization?.strategy || "FRESH_CHECKOUT"}
        recoveryPaymentStatus="CAPTURED"
        verificationStatus="VERIFIED"
        className="mt-8"
      />

      <div className="mt-8">
        <VerificationReceipt receipt={receiptView} amountMinor={Number(receipt.amount_minor)} />
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

      <RecoveryTimelineDrawer open={drawerOpen} onOpenChange={setDrawerOpen} events={events} />
    </main>
  );
}
