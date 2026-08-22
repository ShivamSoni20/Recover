import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PaymentStatusBadge, Panel, StepRow } from "./ui";
import { formatINR, type DemoCase, type VerificationCheck } from "@/lib/demo/types";

export function VerificationProgress({
  checks,
  completed,
}: {
  checks: VerificationCheck[];
  completed: number;
}) {
  return (
    <Panel title="Independent verification">
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

const RECEIPT_CHECKLIST = [
  "recovery checkout exists",
  "recovery amount matches",
  "payment completed",
  "payment amount exact",
  "no unresolved duplicate collection",
  "recovery receipt generated",
];

export function VerificationReceipt({ demoCase }: { demoCase: DemoCase }) {
  const rows: [string, string][] = [
    ["Original payment", demoCase.originalPaymentId],
    ["Original amount", formatINR(demoCase.amountMinor)],
    ["Original state", "FAILED"],
    ["Recovery action", "Fresh Checkout"],
    ["Recovery reference", demoCase.recoveryReference],
    ["Recovery payment", demoCase.recoveryPaymentId],
    ["Recovered amount", formatINR(demoCase.amountMinor)],
    ["Recovery status", "CAPTURED"],
    ["Verification", "PASSED"],
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="border-b border-dashed border-border bg-brand-softer px-6 py-5">
        <p className="text-base font-bold tracking-tight text-foreground">RECOVERED — VERIFIED</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Independent recovery receipt</p>
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
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {RECEIPT_CHECKLIST.map((c) => (
            <li key={c} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Check className="h-3.5 w-3.5 text-success" strokeWidth={3} /> {c}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-between border-t border-border px-6 py-4">
        <span className="text-[11px] text-muted-foreground">Demo receipt · {demoCase.caseId}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success-soft bg-success-soft px-3 py-1 text-[11px] font-bold tracking-wide text-success uppercase">
          <ShieldCheck className="h-3.5 w-3.5" /> Verified
        </span>
      </div>
    </div>
  );
}

export function ProofStrip({ className = "" }: { className?: string }) {
  const items: [string, string][] = [
    ["Original payment", "FAILED"],
    ["Recovery action", "FRESH CHECKOUT"],
    ["Recovery payment", "CAPTURED"],
    ["Independent verification", "VERIFIED"],
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
  demoCase,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  demoCase: DemoCase;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-base">Recovery timeline</SheetTitle>
        </SheetHeader>
        <ol className="mt-4 space-y-3 px-4 pb-8">
          {demoCase.events.map((e, i) => (
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

export function DemoCaseRow({ demoCase }: { demoCase: DemoCase }) {
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
          value={<span className="text-xs font-semibold">FRESH_CHECKOUT</span>}
        />
        <Cell
          label="Amount"
          value={
            <span className="text-xs font-semibold">{formatINR(demoCase.amountMinor)}</span>
          }
        />
        <Cell
          label="Status"
          value={
            <PaymentStatusBadge
              status={
                verified
                  ? "RECOVERED — VERIFIED"
                  : demoCase.state === "MANUAL_REVIEW"
                    ? "MANUAL REVIEW"
                    : "IN PROGRESS"
              }
            />
          }
        />
      </div>
      <Link
        to="/demo/payment/$id"
        params={{ id: demoCase.caseId }}
        className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
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
