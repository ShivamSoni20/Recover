import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, X, ShieldCheck } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PaymentStatusBadge, Panel, StepRow } from "./ui";
import { formatINR } from "@/lib/demo/types";

export type VerificationCheckItem = {
  key: string;
  expected: unknown;
  observed: unknown;
  passed: boolean;
};

export type VerificationReceiptView = {
  receiptId?: string;
  originalOrderId?: string;
  originalPaymentId?: string;
  recoveryLinkId?: string;
  recoveryReferenceId?: string;
  recoveryPaymentId?: string;
  amountMinor?: number;
  currency?: string;
  status?: string;
  verifiedAt?: string;
  checks?: VerificationCheckItem[];
};

export function VerificationProgress({
  checks,
  completed,
}: {
  checks: Array<{ id: string; label: string; result: string }>;
  completed: number;
}) {
  return (
    <Panel title="Independent Canonical Verification">
      <ul>
        {checks.map((c, i) => (
          <StepRow
            key={c.id}
            label={c.label}
            state={i < completed ? "done" : i === completed ? "active" : "pending"}
            detail={i < completed ? c.result : undefined}
          />
        ))}
      </ul>
    </Panel>
  );
}

export function VerificationReceipt({
  receipt,
  amountMinor = 0,
}: {
  receipt?: VerificationReceiptView | null;
  amountMinor?: number;
}) {
  if (!receipt || !receipt.checks || receipt.checks.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center">
        <p className="text-sm font-semibold text-foreground">Verification data unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Canonical provider verification is still processing or incomplete.
        </p>
      </div>
    );
  }

  const rows: [string, string][] = [
    ["Original payment", receipt.originalPaymentId || "—"],
    ["Original order", receipt.originalOrderId || "—"],
    ["Recovery reference", receipt.recoveryReferenceId || "—"],
    ["Recovery Payment Link", receipt.recoveryLinkId || "—"],
    ["Recovery payment", receipt.recoveryPaymentId || "—"],
    ["Recovered amount", formatINR(receipt.amountMinor || amountMinor)],
    ["Currency", receipt.currency || "INR"],
    ["Verification outcome", receipt.status || "VERIFIED"],
    ["Verified at", receipt.verifiedAt ? new Date(receipt.verifiedAt).toLocaleTimeString() : "—"],
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="border-b border-dashed border-border bg-brand-softer px-6 py-5">
        <p className="text-base font-bold tracking-tight text-foreground">
          {receipt.status === "VERIFIED" ? "RECOVERED — VERIFIED" : "VERIFICATION OUTCOME"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Canonical Provider Receipt (Razorpay Test Mode)
        </p>
      </div>
      <div className="px-6 py-2">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-4 border-b border-border/60 py-2.5 last:border-0"
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="font-mono text-xs font-semibold break-all text-foreground">
              {value}
            </span>
          </div>
        ))}
      </div>
      <div className="border-t border-dashed border-border px-6 py-4">
        <p className="mb-2 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
          Canonical Verification Checks
        </p>
        <ul className="space-y-2">
          {receipt.checks.map((c) => (
            <li
              key={c.key}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2">
                {c.passed ? (
                  <Check className="h-4 w-4 text-success" strokeWidth={3} />
                ) : (
                  <X className="h-4 w-4 text-danger" strokeWidth={3} />
                )}
                <span className="font-medium text-foreground">{c.key.replace(/_/g, " ")}</span>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                Observed:{" "}
                <span className="font-semibold text-foreground">{String(c.observed)}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-between border-t border-border px-6 py-4">
        <span className="text-[11px] text-muted-foreground">
          Audit receipt · {receipt.receiptId || "—"}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold tracking-wide uppercase ${
            receipt.status === "VERIFIED"
              ? "border-success-soft bg-success-soft text-success"
              : "border-warning-soft bg-warning-soft text-warning"
          }`}
        >
          <ShieldCheck className="h-3.5 w-3.5" /> {receipt.status || "Verified"}
        </span>
      </div>
    </div>
  );
}

export function ProofStrip({
  originalStatus = "FAILED",
  recoveryStrategy,
  recoveryPaymentStatus = "CAPTURED",
  verificationStatus = "VERIFIED",
  className = "",
}: {
  originalStatus?: string;
  recoveryStrategy?: string;
  recoveryPaymentStatus?: string;
  verificationStatus?: string;
  className?: string;
}) {
  const items: [string, string][] = [
    ["Original payment", originalStatus],
    ["Recovery action", recoveryStrategy || "—"],
    ["Recovery payment", recoveryPaymentStatus],
    ["Independent verification", verificationStatus],
  ];
  return (
    <div className={"flex flex-col gap-3 sm:flex-row sm:items-stretch " + className}>
      {items.map(([label, value], i) => (
        <div key={label} className="flex flex-1 items-center gap-3">
          <div className="flex-1 rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
            <PaymentStatusBadge status={value} className="mt-1.5" />
          </div>
          {i < items.length - 1 ? (
            <ArrowRight className="hidden h-4 w-4 shrink-0 text-brand sm:block" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function RecoveryTimelineDrawer({
  open,
  onOpenChange,
  events = [],
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  events?: Array<{ time: string; label: string }>;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-base">Recovery Audit Timeline</SheetTitle>
        </SheetHeader>
        <ol className="mt-4 space-y-3 px-4 pb-8">
          {events.map((e, i) => (
            <li key={i} className="flex gap-3">
              <span className="font-mono text-[11px] text-muted-foreground">{e.time}</span>
              <span className="text-xs font-medium text-foreground">{e.label}</span>
            </li>
          ))}
        </ol>
      </SheetContent>
    </Sheet>
  );
}

export function DemoCaseRow({ demoCase }: { demoCase: any }) {
  const verified = demoCase.state === "RECOVERED_VERIFIED";
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center">
      <div className="min-w-32">
        <p className="text-sm font-bold text-foreground">{demoCase.caseId}</p>
        <p className="text-[11px] text-muted-foreground">{demoCase.description}</p>
      </div>
      <div className="grid flex-1 grid-cols-2 gap-4 sm:grid-cols-5">
        <Cell label="Original payment" value={<PaymentStatusBadge status="FAILED" />} />
        <Cell
          label="Failure class"
          value={<span className="text-xs font-semibold">{demoCase.failureClass}</span>}
        />
        <Cell
          label="Strategy"
          value={
            <span className="text-xs font-semibold">
              {demoCase.recoveryStrategy || demoCase.strategy || "—"}
            </span>
          }
        />
        <Cell
          label="Outcome"
          value={
            <span
              className={
                "text-xs font-bold " + (verified ? "text-success" : "text-muted-foreground")
              }
            >
              {demoCase.state}
            </span>
          }
        />
        <Cell
          label="Amount"
          value={<span className="text-xs font-bold">{formatINR(demoCase.amountMinor)}</span>}
        />
      </div>
      <Link
        to="/demo/payment/$id"
        params={{ id: demoCase.caseId }}
        className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
      >
        View Case <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <div className="mt-1">{value}</div>
    </div>
  );
}
