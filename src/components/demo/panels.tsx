import { Bot, CheckCircle2, ShieldCheck } from "lucide-react";
import { Field, PaymentStatusBadge, Panel, StepRow } from "./ui";
import { formatINR, type DemoCase, type GateCheck } from "@/lib/demo/types";

export function ProviderTruthPanel({ demoCase }: { demoCase: DemoCase }) {
  return (
    <Panel
      title="Razorpay Provider Truth"
      aside={
        <span className="rounded-full bg-brand-softer px-2 py-0.5 text-[10px] font-semibold text-brand">
          Razorpay Test Mode
        </span>
      }
    >
      <div className="divide-y divide-border/70">
        <Field label="Payment" value={demoCase.originalPaymentId} />
        <Field label="Order" value={demoCase.orderId} />
        <Field label="Amount" value={formatINR(demoCase.amountMinor)} />
        <Field label="Currency" value={demoCase.currency} />
        <Field
          label="Status"
          value={<PaymentStatusBadge status={demoCase.paymentStatus || "UNKNOWN"} />}
        />
        <Field label="Method" value={demoCase.method} />
        <Field label="Failure reason" value={demoCase.failureReason} />
        <Field label="Timestamp" value={demoCase.failedAt ?? "—"} />
      </div>
      <p className="mt-4 rounded-xl bg-danger-soft px-3 py-2.5 text-xs text-danger">
        {demoCase.failureDetail}
      </p>
    </Panel>
  );
}

export function RecoveryMachineTimeline({
  steps,
  completed,
}: {
  steps: string[];
  completed: number;
}) {
  return (
    <Panel title="Recovery Machine">
      <ul>
        {steps.map((label, i) => (
          <StepRow
            key={label}
            label={label}
            state={i < completed ? "done" : i === completed ? "active" : "pending"}
          />
        ))}
      </ul>
    </Panel>
  );
}

export function AIDiagnosisCard({
  demoCase,
  evidenceFields = [],
}: {
  demoCase: DemoCase;
  evidenceFields?: string[];
}) {
  const displayEvidence =
    evidenceFields.length > 0
      ? evidenceFields
      : [
          `Payment method: ${demoCase.method}`,
          `Error reason: ${demoCase.failureReason}`,
          `Error detail: ${demoCase.failureDetail}`,
        ];

  return (
    <section className="rounded-2xl border border-brand-soft bg-brand-softer p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <Bot className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-bold text-foreground">AI Diagnosis</h2>
        <span className="ml-auto text-[11px] font-semibold text-brand">
          {demoCase.confidence}% confidence
        </span>
      </div>
      <p className="mt-3 text-[10px] font-bold tracking-wide text-brand uppercase">
        Failure class · {demoCase.failureClass}
      </p>
      <p className="mt-2 text-xs leading-6 text-foreground">{demoCase.diagnosis}</p>
      <p className="mt-4 text-[11px] font-semibold text-muted-foreground">Provider Evidence</p>
      <ul className="mt-1.5 space-y-1">
        {displayEvidence.map((e, idx) => (
          <li key={idx} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-1 w-1 rounded-full bg-brand" /> {e}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-between rounded-xl border border-brand-soft bg-card px-3 py-2.5">
        <span className="text-[11px] text-muted-foreground">Recovery strategy</span>
        <span className="text-xs font-bold text-brand">{demoCase.recoveryStrategy}</span>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        AI recommends strategy. Deterministic code authorizes financial execution.
      </p>
    </section>
  );
}

export function RecoveryGateCheck({ check, revealed }: { check: GateCheck; revealed: boolean }) {
  return (
    <li
      className={
        "flex items-center gap-3 border-b border-border/70 py-2.5 last:border-0 transition-opacity duration-200 " +
        (revealed ? "opacity-100" : "opacity-30")
      }
    >
      <span className="flex-1 text-xs text-foreground">{check.label}</span>
      {check.detail ? (
        <span className="font-mono text-[11px] text-muted-foreground">{check.detail}</span>
      ) : null}
      <span className="text-[11px] font-bold text-foreground">{check.answer}</span>
      <CheckCircle2
        className={"h-4 w-4 " + (revealed ? "text-success" : "text-border")}
        strokeWidth={2.5}
      />
    </li>
  );
}

export function RecoveryGate({
  checks,
  revealed,
  authorized,
}: {
  checks: GateCheck[];
  revealed: number;
  authorized: boolean;
}) {
  return (
    <Panel
      title="Recovery Gate"
      aside={
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Deterministic
        </span>
      }
    >
      <ul>
        {checks.map((c, i) => (
          <RecoveryGateCheck key={c.id} check={c} revealed={i < revealed} />
        ))}
      </ul>
      {authorized ? (
        <div className="mt-4 rounded-2xl border border-success-soft bg-success-soft/60 p-4 text-center">
          <p className="inline-flex items-center gap-2 text-lg font-bold tracking-tight text-success">
            <ShieldCheck className="h-5 w-5" /> AUTHORIZED
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            All deterministic recovery checks passed.
          </p>
          <p className="mt-3 text-xs font-semibold text-brand">
            AI proposed the action. Code authorized it.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

export function RecoveryProofPanel({
  status,
  steps,
}: {
  status: string;
  steps: { label: string; state: "done" | "active" | "pending" }[];
}) {
  return (
    <Panel title="Recovery Proof" aside={<PaymentStatusBadge status={status} />}>
      {status === "PENDING" ? (
        <p className="mb-2 text-xs text-muted-foreground">No recovery action has been executed.</p>
      ) : null}
      <ul>
        {steps.map((s) => (
          <StepRow key={s.label} label={s.label} state={s.state} />
        ))}
      </ul>
    </Panel>
  );
}
