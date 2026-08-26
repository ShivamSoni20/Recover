import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ShieldAlert, Loader2 } from "lucide-react";
import { DemoButton, PaymentStatusBadge, Panel } from "@/components/demo/ui";
import {
  AIDiagnosisCard,
  ProviderTruthPanel,
  RecoveryGate,
  RecoveryMachineTimeline,
  RecoveryProofPanel,
} from "@/components/demo/panels";
import { getCaseFn, submitDecisionFn } from "@/lib/api/server-fns";
import { formatINRMinor } from "@/lib/domain/money";
import type { GateCheckResult } from "@/lib/domain/recovery-gate";

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

const MACHINE_STEPS = [
  "Failure received",
  "Canonical state loaded",
  "AI diagnosis running",
  "Recovery strategy selected",
  "Recovery Gate evaluating",
];

function PaymentCase() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  const [caseData, setCaseData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [approvalPhase, setApprovalPhase] = useState<"idle" | "recheck" | "unpaid" | "creating">(
    "idle",
  );

  const loadCase = async () => {
    try {
      const data = await getCaseFn({ data: id });
      if (data) setCaseData(data);
    } catch (err) {
      console.error("[Fetch Case Error]:", err);
    } finally {
      setLoading(false);
    }
  };

  // Poll real case state and events
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
          Loading canonical case from database...
        </p>
      </main>
    );
  }

  if (!caseData) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20 text-center">
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          Recovery case not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No case matches <code className="font-mono text-xs">{id}</code> in Supabase.
        </p>
        <DemoButton className="mt-6" onClick={() => navigate({ to: "/demo/create" })}>
          Create Test Payment
        </DemoButton>
      </main>
    );
  }

  const diagnosis = caseData.recovery_diagnoses?.[0];
  const authorization = caseData.action_authorizations?.[0];
  const events = caseData.case_events || [];

  const gateChecks: GateCheckResult[] = (authorization?.gate_checks as GateCheckResult[]) || [];
  const authorized = Boolean(authorization?.authorized);
  const diagnosisReady = Boolean(diagnosis);
  const gateStarted = Boolean(authorization);

  if (caseData.terminal_status === "MANUAL_REVIEW" || caseData.status === "MANUAL_REVIEW") {
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
          <p className="mt-1 text-xs text-muted-foreground">
            Reason: Escalated for operator financial review.
          </p>
          <DemoButton className="mt-6" variant="outline" onClick={() => navigate({ to: "/demo" })}>
            Back to overview
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
          caseId: caseData.id,
          decision: "APPROVE_RECOVERY",
        },
      });
      setApprovalPhase("creating");

      // Poll until recovery action is created with real payment_link_id
      let attempts = 0;
      const checkInterval = setInterval(async () => {
        attempts++;
        try {
          const freshData = await getCaseFn({ data: caseData.id });
          const action = freshData?.recovery_actions?.[0];
          if (action?.payment_link_id && action?.status === "CREATED") {
            clearInterval(checkInterval);
            navigate({ to: "/demo/recovery/$id/checkout", params: { id: caseData.id } });
          } else if (freshData?.terminal_status === "STOPPED_ALREADY_PAID") {
            clearInterval(checkInterval);
            setApprovalPhase("idle");
            loadCase();
          }
        } catch {
          // Continue polling
        }
        if (attempts > 15) {
          clearInterval(checkInterval);
          setApprovalPhase("idle");
        }
      }, 1000);
    } catch (err) {
      console.error("[Decision Error]:", err);
      setApprovalPhase("idle");
    }
  };

  const handleEscalate = async () => {
    try {
      await submitDecisionFn({
        data: {
          caseId: caseData.id,
          decision: "ESCALATE",
        },
      });
      loadCase();
    } catch (err) {
      console.error("[Escalate Error]:", err);
    }
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

  const demoCaseAdapter = {
    caseId: caseData.case_number,
    orderId: caseData.original_order_id,
    originalPaymentId: caseData.original_payment_id,
    amountMinor: Number(caseData.amount_minor),
    currency: caseData.currency,
    paymentStatus: caseData.status,
    failureReason: caseData.failure_reason,
    failureDetail: caseData.failure_detail,
    method: caseData.method || "Card / UPI",
    failedAt: caseData.failed_at ? new Date(caseData.failed_at).toLocaleTimeString() : null,
    confidence: diagnosis ? Math.round(Number(diagnosis.confidence) * 100) : 0,
    failureClass: diagnosis?.failure_class || "ANALYZING",
    diagnosis: diagnosis?.summary || "Analyzing payment failure telemetry with OpenRouter AI...",
    recoveryStrategy: authorization?.strategy || "FRESH_CHECKOUT",
    gateChecks,
    recoveryReference: "",
    recoveryLinkId: "",
    recoveryPaymentId: "",
    verificationChecks: [],
    state: caseData.status,
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
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-center gap-4">
        <PaymentStatusBadge status="Payment failed" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {formatINRMinor(caseData.amount_minor)}
        </h1>
        <span className="font-mono text-xs text-muted-foreground">{caseData.case_number}</span>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <ProviderTruthPanel demoCase={demoCaseAdapter} />

        <div className="space-y-6">
          <RecoveryMachineTimeline
            steps={MACHINE_STEPS}
            completed={authorized ? 5 : diagnosisReady ? 3 : 1}
          />
          {diagnosisReady ? (
            <AIDiagnosisCard
              demoCase={demoCaseAdapter}
              evidenceFields={diagnosis?.evidence_fields as string[] | undefined}
            />
          ) : null}
          {gateStarted ? (
            <RecoveryGate
              checks={gateChecks}
              revealed={gateChecks.length}
              authorized={authorized}
            />
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
                    {formatINRMinor(caseData.amount_minor)}
                  </span>
                </div>
              </div>

              {approvalPhase === "idle" ? (
                <div className="mt-4 flex flex-wrap gap-3">
                  <DemoButton onClick={handleRecover}>
                    Recover {formatINRMinor(caseData.amount_minor)}{" "}
                    <ArrowRight className="h-4 w-4" />
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

        <RecoveryProofPanel status={authorized ? "AUTHORIZED" : "PENDING"} steps={proofSteps} />
      </div>
    </main>
  );
}
