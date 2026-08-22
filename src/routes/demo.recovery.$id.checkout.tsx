import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { DemoButton, Field, PaymentStatusBadge, Panel, StepRow } from "@/components/demo/ui";
import { RecoveryCheckoutModal } from "@/components/demo/modals";
import { updateCase, useDemoCase } from "@/lib/demo/store";
import { formatINR } from "@/lib/demo/types";

const title = "Recovery checkout created — Recover Demo";
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
  const demoCase = useDemoCase(id);
  const [open, setOpen] = useState(false);

  if (!demoCase) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20 text-center">
        <h1 className="text-xl font-bold tracking-tight text-foreground">Demo case not found</h1>
        <DemoButton className="mt-6" onClick={() => navigate({ to: "/demo" })}>
          Back to demo
        </DemoButton>
      </main>
    );
  }

  const handleSuccess = () => {
    updateCase(demoCase.caseId, { state: "WAITING_RECOVERY_PAYMENT" });
    updateCase(demoCase.caseId, { state: "PAYMENT_SUBMITTED" }, "Recovery payment submitted");
    setOpen(false);
    navigate({ to: "/demo/recovery/$id/verify", params: { id: demoCase.caseId } });
  };

  const stepper: { label: string; state: "done" | "active" | "pending" }[] = [
    { label: "Failed payment", state: "done" },
    { label: "AI diagnosis", state: "done" },
    { label: "Authorized", state: "done" },
    { label: "Recovery checkout", state: "done" },
    { label: "Customer payment", state: "active" },
    { label: "Verification", state: "pending" },
  ];

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
            <Field label="Amount" value={formatINR(demoCase.amountMinor)} />
            <Field label="Action" value="Fresh checkout" />
            <Field label="Reference" value={demoCase.recoveryReference} />
            <Field label="Payment Link" value={demoCase.recoveryLinkId} />
            <Field label="Status" value={<PaymentStatusBadge status="ACTIVE" />} />
          </div>
          <DemoButton
            className="mt-6 w-full sm:w-auto"
            onClick={() => {
              if (demoCase.recoveryLinkId && !demoCase.recoveryLinkId.startsWith("plink_demo_")) {
                window.open(`https://rzp.io/i/${demoCase.recoveryLinkId}`, "_blank");
              }
              setOpen(true);
            }}
          >
            Open Recovery Checkout <ArrowRight className="h-4 w-4" />
          </DemoButton>
        </Panel>

        <Panel title="Recovery progress">
          <ul>
            {stepper.map((s) => (
              <StepRow
                key={s.label}
                label={s.label}
                state={s.state}
                detail={s.state === "pending" ? "WAITING" : s.state === "active" ? "WAITING" : undefined}
              />
            ))}
          </ul>
        </Panel>
      </div>

      <RecoveryCheckoutModal
        open={open}
        onOpenChange={setOpen}
        mode="recovery"
        amountMinor={demoCase.amountMinor}
        onOutcome={handleSuccess}
      />
    </main>
  );
}
