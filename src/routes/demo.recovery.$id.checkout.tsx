import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ExternalLink, Loader2 } from "lucide-react";
import { DemoButton, Field, PaymentStatusBadge, Panel, StepRow } from "@/components/demo/ui";
import { getCaseFn } from "@/lib/api/server-fns";
import { formatINRMinor } from "@/lib/domain/money";

const title = "Recovery checkout created — Recover";
const description =
  "A fresh recovery checkout was created after the deterministic Recovery Gate authorized the action.";

export const Route = createFileRoute("/demo/recovery/$id/checkout")({
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
  component: RecoveryCheckout,
});

function RecoveryCheckout() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [caseData, setCaseData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const loadCase = async () => {
    try {
      const data = await getCaseFn({ data: id });
      if (data) setCaseData(data);
      // Auto-navigate to verify if payment received
      if (data?.status === "VERIFYING" || data?.terminal_status === "RECOVERED_VERIFIED") {
        navigate({ to: "/demo/recovery/$id/verify", params: { id } });
      }
    } catch (err) {
      console.error("[Fetch Action Error]:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCase();
    const interval = setInterval(loadCase, 2000);
    return () => clearInterval(interval);
  }, [id]);

  if (loading && !caseData) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center px-6 py-24 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="mt-4 text-sm font-semibold text-foreground">
          Loading recovery checkout details...
        </p>
      </main>
    );
  }

  const action = caseData?.recovery_actions?.[0];

  if (!caseData || !action) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20 text-center">
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          Recovery action not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Waiting for Recovery Payment Link creation in backend...
        </p>
        <DemoButton className="mt-6" onClick={() => navigate({ to: "/demo" })}>
          Back to overview
        </DemoButton>
      </main>
    );
  }

  const stepper: { label: string; state: "done" | "active" | "pending" }[] = [
    { label: "Failed payment", state: "done" },
    { label: "AI diagnosis", state: "done" },
    { label: "Authorized", state: "done" },
    { label: "Recovery checkout", state: "done" },
    { label: "Customer payment", state: "active" },
    { label: "Verification", state: "pending" },
  ];

  const handleOpenHostedLink = () => {
    if (action.short_url) {
      window.open(action.short_url, "_blank");
      navigate({ to: "/demo/recovery/$id/verify", params: { id } });
    }
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12">
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Panel
          title="Fresh recovery checkout created."
          aside={
            <span className="rounded-full bg-brand-softer px-2 py-0.5 text-[10px] font-bold tracking-wide text-brand uppercase">
              Razorpay Payment Link
            </span>
          }
        >
          <div className="divide-y divide-border/70">
            <Field label="Amount" value={formatINRMinor(action.amount_minor)} />
            <Field label="Action" value="Fresh checkout" />
            <Field label="Reference" value={action.reference_id} />
            <Field label="Payment Link ID" value={action.payment_link_id || "Creating..."} />
            <Field
              label="Status"
              value={<PaymentStatusBadge status={action.status || "ACTIVE"} />}
            />
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            {action.short_url ? (
              <DemoButton className="w-full sm:w-auto" onClick={handleOpenHostedLink}>
                Open Hosted Recovery Checkout <ExternalLink className="h-4 w-4" />
              </DemoButton>
            ) : (
              <p className="text-xs text-danger">
                Canonical Razorpay hosted checkout URL unavailable.
              </p>
            )}
            <DemoButton
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => navigate({ to: "/demo/recovery/$id/verify", params: { id } })}
            >
              I Completed Payment → Verify <ArrowRight className="h-4 w-4" />
            </DemoButton>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Clicking opens the real Razorpay-hosted sandbox payment link in a new tab.
          </p>
        </Panel>

        <Panel title="Recovery progress">
          <ul>
            {stepper.map((s) => (
              <StepRow
                key={s.label}
                label={s.label}
                state={s.state}
                detail={
                  s.state === "pending" ? "WAITING" : s.state === "active" ? "WAITING" : undefined
                }
              />
            ))}
          </ul>
        </Panel>
      </div>
    </main>
  );
}
