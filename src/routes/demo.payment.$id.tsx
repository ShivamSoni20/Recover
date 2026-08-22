import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ShieldAlert } from "lucide-react";
import { DemoButton, PaymentStatusBadge, Panel } from "@/components/demo/ui";
import {
  AIDiagnosisCard,
  ProviderTruthPanel,
  RecoveryGate,
  RecoveryMachineTimeline,
  RecoveryProofPanel,
} from "@/components/demo/panels";
import { buildGateChecks, MACHINE_STEPS } from "@/lib/demo/data";
import { updateCase, useDemoCase } from "@/lib/demo/store";
import { formatINR } from "@/lib/demo/types";
import { submitDecisionFn } from "@/lib/api/server-fns";

const title = "Failed payment case — Recover";
const description =
  "Provider truth, AI diagnosis and the deterministic Recovery Gate for a failed payment.";

export const Route = createFileRoute("/demo/payment/$id")({
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
  component: PaymentCase,
});

function PaymentCase() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const demoCase = useDemoCase(id);

  const [machineStep, setMachineStep] = useState(0);
  const [gateRevealed, setGateRevealed] = useState(0);
  const [approvalPhase, setApprovalPhase] = useState<"idle" | "recheck" | "unpaid" | "creating">(
    "idle",
  );

  const amount = demoCase?.amountMinor ?? 299900;
  const gateChecks = useMemo(() => buildGateChecks(amount), [amount]);
  const diagnosisReady = machineStep >= 3;
  const gateStarted = machineStep >= 5;
  const authorized = gateRevealed >= gateChecks.length;

  // Sequential operational timeline
  useEffect(() => {
    if (!demoCase) return;
    if (machineStep >= MACHINE_STEPS.length) return;
    const t = window.setTimeout(() => setMachineStep((s) => s + 1), 600);
    return () => window.clearTimeout(t);
  }, [machineStep, demoCase]);

  useEffect(() => {
    if (!gateStarted) return;
    if (gateRevealed >= gateChecks.length) return;
    const t = window.setTimeout(() => setGateRevealed((n) => n + 1), 380);
    return () => window.clearTimeout(t);
  }, [gateStarted, gateRevealed, gateChecks.length]);

  useEffect(() => {
    if (!demoCase) return;
    if (machineStep === 3 && demoCase.state === "PAYMENT_FAILED") {
      updateCase(demoCase.caseId, { state: "DIAGNOSING" }, "Failure event received");
    }
    if (diagnosisReady && demoCase.state === "DIAGNOSING") {
      updateCase(demoCase.caseId, { state: "RECOVERY_PROPOSED" }, "AI diagnosis completed");
    }
    if (authorized && demoCase.state === "RECOVERY_PROPOSED") {
      updateCase(
        demoCase.caseId,
        { state: "RECOVERY_AUTHORIZED", gateChecks },
        "Recovery Gate authorized action",
      );
    }
  }, [machineStep, diagnosisReady, authorized, demoCase, gateChecks]);

  if (!demoCase) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20 text-center">
        <h1 className="text-xl font-bold tracking-tight text-foreground">Demo case not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This demo case is no longer in your local demo state.
        </p>
        <DemoButton className="mt-6" onClick={() => navigate({ to: "/demo" })}>
          Back to demo
        </DemoButton>
      </main>
    );
  }

  if (demoCase.state === "MANUAL_REVIEW") {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20">
        <Panel className="px-6 py-10 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-soft text-warning">
            <ShieldAlert className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-foreground">MANUAL REVIEW</h1>
          <p className="mt-2 text-sm font-semibold text-foreground">
            No financial action executed.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Reason: Operator chose manual review.</p>
          <DemoButton className="mt-6" variant="outline" onClick={() => navigate({ to: "/demo" })}>
            Back to demo
          </DemoButton>
        </Panel>
      </main>
    );
  }

  const handleRecover = async () => {
    setApprovalPhase("recheck");
    try {
      await submitDecisionFn({
        data: {
          caseId: demoCase.caseId,
          decision: "APPROVE_RECOVERY",
        },
      });
    } catch {
      // Proceed with local workflow view
    }
    setApprovalPhase("unpaid");
    window.setTimeout(() => {
      setApprovalPhase("creating");
      updateCase(demoCase.caseId, { state: "WAITING_APPROVAL" });
      updateCase(demoCase.caseId, { state: "CREATING_RECOVERY_CHECKOUT" }, "Recovery approved");
    }, 600);
    window.setTimeout(() => {
      updateCase(
        demoCase.caseId,
        { state: "RECOVERY_CHECKOUT_READY" },
        "Recovery checkout created",
      );
      navigate({ to: "/demo/recovery/$id/checkout", params: { id: demoCase.caseId } });
    }, 1200);
  };

  const handleEscalate = async () => {
    try {
      await submitDecisionFn({
        data: {
          caseId: demoCase.caseId,
          decision: "ESCALATE",
        },
      });
    } catch {
      // Ignore
    }
    updateCase(demoCase.caseId, { state: "MANUAL_REVIEW" }, "Escalated to manual review");
  };

  const proofSteps: { label: string; state: "done" | "active" | "pending" }[] = [
    { label: "Payment failed", state: "done" },
    { label: "Diagnosis complete", state: diagnosisReady ? "done" : "active" },
    {
      label: "Recovery authorized",
      state: authorized ? "done" : gateStarted ? "active" : "pending",
    },
    { label: "Recovery checkout", state: approvalPhase === "creating" ? "active" : "pending" },
    { label: "Payment received", state: "pending" },
    { label: "Independent verification", state: "pending" },
  ];

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-4">
        <PaymentStatusBadge status="Payment failed" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {formatINR(demoCase.amountMinor)}
        </h1>
        <span className="font-mono text-xs text-muted-foreground">{demoCase.caseId}</span>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <ProviderTruthPanel demoCase={demoCase} />

        <div className="space-y-6">
          <RecoveryMachineTimeline steps={MACHINE_STEPS} completed={machineStep} />
          {diagnosisReady ? <AIDiagnosisCard demoCase={demoCase} /> : null}
          {gateStarted ? (
            <RecoveryGate checks={gateChecks} revealed={gateRevealed} authorized={authorized} />
          ) : null}

          {authorized ? (
            <Panel title="Recovery ready">
              <div className="divide-y divide-border/70">
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-xs text-muted-foreground">Recommended action</span>
                  <span className="text-xs font-bold text-brand">Create a fresh checkout</span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-xs text-muted-foreground">Amount</span>
                  <span className="text-xs font-bold text-foreground">
                    {formatINR(demoCase.amountMinor)}
                  </span>
                </div>
              </div>

              {approvalPhase === "idle" ? (
                <div className="mt-4 flex flex-wrap gap-3">
                  <DemoButton onClick={handleRecover}>
                    Recover {formatINR(demoCase.amountMinor)} <ArrowRight className="h-4 w-4" />
                  </DemoButton>
                  <DemoButton variant="outline" onClick={handleEscalate}>
                    Escalate instead
                  </DemoButton>
                </div>
              ) : (
                <div className="mt-4 space-y-2 rounded-xl bg-muted px-4 py-3 text-xs">
                  <p className="font-medium text-foreground">Rechecking provider state...</p>
                  {approvalPhase !== "recheck" ? (
                    <p className="font-semibold text-success">Still unpaid ✓</p>
                  ) : null}
                  {approvalPhase === "creating" ? (
                    <p className="font-medium text-foreground">Creating recovery checkout...</p>
                  ) : null}
                </div>
              )}

              <p className="mt-3 text-[11px] text-muted-foreground">
                Before execution, Recover rechecks that the original payment is still unpaid.
              </p>
            </Panel>
          ) : null}
        </div>

        <RecoveryProofPanel
          status={authorized ? "AUTHORIZED" : "PENDING"}
          steps={proofSteps}
        />
      </div>
    </main>
  );
}
