import { useState } from "react";
import { CheckCircle2, CreditCard, Landmark, Loader2, Smartphone, XCircle } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { DemoButton } from "./ui";
import { formatINR } from "@/lib/demo/types";
import { cn } from "@/lib/utils";

const METHODS = [
  { id: "upi", label: "UPI", icon: Smartphone },
  { id: "card", label: "Card", icon: CreditCard },
  { id: "netbanking", label: "Netbanking", icon: Landmark },
];

function MethodPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {METHODS.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className={cn(
            "flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-[11px] font-semibold transition-colors",
            value === m.id
              ? "border-brand bg-brand-softer text-brand"
              : "border-border bg-card text-muted-foreground hover:bg-muted",
          )}
        >
          <m.icon className="h-4 w-4" />
          {m.label}
        </button>
      ))}
    </div>
  );
}

type Phase = "idle" | "processing" | "done";

export function RecoveryCheckoutModal({
  open,
  onOpenChange,
  mode,
  amountMinor,
  onOutcome,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: "initial" | "recovery";
  amountMinor: number;
  onOutcome: (outcome: "success" | "failed") => void;
}) {
  const [method, setMethod] = useState("upi");
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<"success" | "failed">("failed");

  const run = (result: "success" | "failed") => {
    setOutcome(result);
    setPhase("processing");
    window.setTimeout(() => {
      setPhase("done");
      window.setTimeout(() => onOutcome(result), 900);
    }, 1400);
  };

  const isInitial = mode === "initial";

  return (
    <Dialog open={open} onOpenChange={(o) => (phase === "idle" ? onOpenChange(o) : null)}>
      <DialogContent className="max-w-md rounded-2xl border-border p-0">
        <div className="border-b border-border px-6 py-4">
          <p className="text-[10px] font-bold tracking-wide text-brand uppercase">
            {isInitial ? "Demo Test Checkout" : "Recovery Checkout"}
          </p>
          <h2 className="mt-1 text-base font-bold tracking-tight text-foreground">
            {isInitial ? "Recover Demo Payment" : "Recover Payment"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isInitial
              ? "Merchant · Demo Merchant"
              : "This checkout represents the fresh recovery attempt."}
          </p>
        </div>

        <div className="px-6 py-5">
          <p className="text-3xl font-bold tracking-tight text-foreground">
            {formatINR(amountMinor)}
          </p>

          {phase === "idle" ? (
            <>
              <div className="mt-5">
                <MethodPicker value={method} onChange={setMethod} />
              </div>

              {isInitial ? (
                <>
                  <p className="mt-6 text-xs font-semibold text-foreground">
                    Choose the outcome for this interactive demo.
                  </p>
                  <div className="mt-3 space-y-2">
                    <DemoButton variant="danger" className="w-full" onClick={() => run("failed")}>
                      FAIL THIS PAYMENT
                    </DemoButton>
                    <DemoButton variant="outline" className="w-full" onClick={() => run("success")}>
                      Payment succeeds
                    </DemoButton>
                  </div>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    In the real product, this failure comes from Razorpay Test Checkout.
                  </p>
                </>
              ) : (
                <>
                  <DemoButton className="mt-6 w-full" onClick={() => run("success")}>
                    Complete Payment Successfully
                  </DemoButton>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    The production implementation opens the actual Razorpay-hosted checkout.
                  </p>
                </>
              )}
            </>
          ) : null}

          {phase === "processing" ? (
            <div className="mt-8 flex flex-col items-center gap-3 py-6">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
              <p className="text-sm font-semibold text-foreground">Processing payment...</p>
            </div>
          ) : null}

          {phase === "done" ? (
            <div className="mt-8 flex flex-col items-center gap-3 py-6">
              {outcome === "failed" ? (
                <>
                  <XCircle className="h-8 w-8 text-danger" />
                  <p className="text-sm font-bold tracking-wide text-danger">PAYMENT FAILED</p>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-8 w-8 text-success" />
                  <p className="text-sm font-bold tracking-wide text-success">PAYMENT SUCCESSFUL</p>
                </>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
