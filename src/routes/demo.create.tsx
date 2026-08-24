import { useState, useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { DemoButton, Field, PaymentStatusBadge, Panel, StepRow } from "@/components/demo/ui";
import {
  createTestPaymentFn,
  getSessionStatusFn,
  reconcileTestPaymentSessionFn,
} from "@/lib/api/server-fns";
import { formatINR } from "@/lib/demo/types";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (response: unknown) => void) => void;
    };
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

const title = "Create a test payment — Recover";
const description =
  "Define your own test payment. Recover carries the same amount through failure, diagnosis, authorization, recovery and independent verification.";

export const Route = createFileRoute("/demo/create")({
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
  component: CreatePayment,
});

const MIN_RUPEES = 100;
const MAX_RUPEES = 10000;

const stages = [
  {
    no: "01",
    label: "Create",
    copy: "You create the payment and define the amount.",
    accent: false,
  },
  {
    no: "02",
    label: "Fail",
    copy: "The next checkout deliberately enters a failed state.",
    accent: false,
  },
  {
    no: "03",
    label: "Recover",
    copy: "AI diagnoses the failure. Deterministic rules decide whether another payment attempt is safe.",
    accent: true,
  },
  {
    no: "04",
    label: "Verify",
    copy: "Recover does not trust the success callback. Provider state is independently verified first.",
    accent: true,
  },
];

const productionFlow = [
  "Razorpay event",
  "LangGraph",
  "AI diagnosis",
  "Recovery Gate",
  "Razorpay action",
  "Independent verification",
];

const purposes: string[] = [
  "Pro Plan — Annual",
  "Pro Plan — Monthly",
  "Team Seat Upgrade",
  "One-time Order",
];

function inputClass(invalid = false) {
  return [
    "w-full rounded-xl border bg-card px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors",
    "placeholder:text-muted-foreground focus:border-brand focus:ring-2 focus:ring-brand-soft",
    invalid ? "border-danger" : "border-border",
  ].join(" ");
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

export type CheckoutState =
  | "READY"
  | "CHECKOUT_OPEN"
  | "CLIENT_FAILURE_REPORTED"
  | "CONFIRMING_PROVIDER_FAILURE"
  | "FAILURE_CONFIRMED"
  | "CHECKOUT_DISMISSED"
  | "PROVIDER_CONFIRMATION_TIMEOUT"
  | "PAYMENT_SUCCEEDED"
  | "ERROR";

function CreatePayment() {
  const navigate = useNavigate();
  const [amount, setAmount] = useState("2999");
  const [name, setName] = useState("Amit Sharma");
  const [email, setEmail] = useState("amit@example.com");
  const [purpose, setPurpose] = useState<string>("Pro Plan — Annual");
  const [descriptionValue, setDescriptionValue] = useState("Recover Buildathon Test");
  const [loading, setLoading] = useState(false);
  const [manualChecking, setManualChecking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [checkoutState, setCheckoutState] = useState<CheckoutState>("READY");
  const [candidatePaymentId, setCandidatePaymentId] = useState<string | null>(null);
  const [isDirectReconciling, setIsDirectReconciling] = useState(false);

  const failureObservedRef = useRef<boolean>(false);
  const candidatePaymentIdRef = useRef<string | null>(null);
  const confirmStartTimeRef = useRef<number | null>(null);

  const [realOrder, setRealOrder] = useState<{
    sessionId: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    razorpayKeyId: string;
  } | null>(null);

  const parsed = Number(amount);
  const amountValid = Number.isFinite(parsed) && parsed >= MIN_RUPEES && parsed <= MAX_RUPEES;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameValid = name.trim().length > 0 && name.trim().length <= 60;
  const formValid = amountValid && emailValid && nameValid && descriptionValue.trim().length > 0;
  const amountMinor = amountValid ? Math.round(parsed * 100) : 299900;

  // Confirmation loop: fast poll webhook + fallback canonical API reconciliation + bounded timeout
  useEffect(() => {
    if (checkoutState !== "CONFIRMING_PROVIDER_FAILURE" || !realOrder?.sessionId) return;

    if (!confirmStartTimeRef.current) {
      confirmStartTimeRef.current = Date.now();
    }

    const interval = setInterval(async () => {
      const elapsed = Date.now() - (confirmStartTimeRef.current || Date.now());

      try {
        // 1. Cheap database check for webhook-created case
        const session = await getSessionStatusFn({ data: realOrder.sessionId });
        if (session?.caseId) {
          clearInterval(interval);
          setCheckoutState("FAILURE_CONFIRMED");
          navigate({ to: "/demo/payment/$id", params: { id: session.caseId } });
          return;
        }

        // 2. If webhook is delayed (> 6 seconds), perform active canonical API reconciliation
        if (elapsed >= 6000) {
          setIsDirectReconciling(true);
          const reconciliation = await reconcileTestPaymentSessionFn({
            data: {
              sessionId: realOrder.sessionId,
              candidatePaymentId: candidatePaymentIdRef.current || undefined,
            },
          });

          if (reconciliation.status === "FAILURE_CONFIRMED" && reconciliation.caseId) {
            clearInterval(interval);
            setCheckoutState("FAILURE_CONFIRMED");
            navigate({ to: "/demo/payment/$id", params: { id: reconciliation.caseId } });
            return;
          }

          if (reconciliation.status === "PAYMENT_SUCCEEDED") {
            clearInterval(interval);
            setCheckoutState("PAYMENT_SUCCEEDED");
            return;
          }
        }

        // 3. Bounded timeout: after 12 seconds without confirmed failure, stop polling
        if (elapsed >= 12000) {
          clearInterval(interval);
          setCheckoutState("PROVIDER_CONFIRMATION_TIMEOUT");
        }
      } catch (err) {
        console.error("Confirmation loop error:", err);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [checkoutState, realOrder?.sessionId, navigate]);

  const handleCreate = async () => {
    if (!formValid) return;
    setLoading(true);
    setErrorMessage(null);
    setCheckoutState("READY");
    failureObservedRef.current = false;
    candidatePaymentIdRef.current = null;
    setCandidatePaymentId(null);
    setIsDirectReconciling(false);
    confirmStartTimeRef.current = null;

    try {
      const res = await createTestPaymentFn({
        data: {
          amountMinor,
          description: descriptionValue.trim().slice(0, 80),
          customer: {
            name: name.trim().slice(0, 60),
            email: email.trim().slice(0, 120),
            purpose,
          },
        },
      });

      setRealOrder(res);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to connect to Razorpay Test API. Ensure valid credentials in .env"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleOpenStandardCheckout = async () => {
    if (!realOrder) return;
    setErrorMessage(null);
    failureObservedRef.current = false;
    candidatePaymentIdRef.current = null;
    setCandidatePaymentId(null);
    setIsDirectReconciling(false);
    confirmStartTimeRef.current = null;

    const loaded = await loadRazorpayScript();
    if (!loaded || !window.Razorpay) {
      setErrorMessage("Could not load Razorpay Checkout SDK. Please check your internet connection.");
      return;
    }

    if (!realOrder.razorpayKeyId) {
      setErrorMessage("RAZORPAY_KEY_ID is missing from environment. Please configure your Test Mode key.");
      return;
    }

    setCheckoutState("CHECKOUT_OPEN");

    const rzp = new window.Razorpay({
      key: realOrder.razorpayKeyId,
      amount: realOrder.amountMinor,
      currency: realOrder.currency,
      name: "Recover Test Merchant",
      description: descriptionValue,
      order_id: realOrder.orderId,
      prefill: {
        name,
        email,
      },
      theme: {
        color: "#5b21f0",
      },
      retry: {
        enabled: false, // Critical: Disable Razorpay's built-in retry modal loop for initial Recover demo
      },
      handler: function () {
        setCheckoutState("PAYMENT_SUCCEEDED");
      },
      modal: {
        ondismiss: function () {
          if (failureObservedRef.current) {
            // Failure was observed in checkout before dismiss; continue provider confirmation
            setCheckoutState("CONFIRMING_PROVIDER_FAILURE");
          } else {
            // Dismissed without any failed payment attempt
            setCheckoutState("CHECKOUT_DISMISSED");
          }
        },
      },
    });

    rzp.on("payment.failed", function (response: unknown) {
      failureObservedRef.current = true;
      setCheckoutState("CLIENT_FAILURE_REPORTED");

      const errorPayload = (response as {
        error?: {
          code?: string;
          description?: string;
          source?: string;
          step?: string;
          reason?: string;
          metadata?: { payment_id?: string; paymentId?: string; order_id?: string };
        };
      })?.error;

      const candidateId = errorPayload?.metadata?.payment_id || errorPayload?.metadata?.paymentId || null;
      if (candidateId) {
        candidatePaymentIdRef.current = candidateId;
        setCandidatePaymentId(candidateId);
      }

      confirmStartTimeRef.current = Date.now();
      setCheckoutState("CONFIRMING_PROVIDER_FAILURE");
    });

    rzp.open();
  };

  const handleManualReconciliation = async () => {
    if (!realOrder?.sessionId) return;
    setManualChecking(true);
    setErrorMessage(null);

    try {
      const res = await reconcileTestPaymentSessionFn({
        data: {
          sessionId: realOrder.sessionId,
          candidatePaymentId: candidatePaymentIdRef.current || undefined,
        },
      });

      if (res.status === "FAILURE_CONFIRMED" && res.caseId) {
        setCheckoutState("FAILURE_CONFIRMED");
        navigate({ to: "/demo/payment/$id", params: { id: res.caseId } });
        return;
      }

      if (res.status === "PAYMENT_SUCCEEDED") {
        setCheckoutState("PAYMENT_SUCCEEDED");
        return;
      }

      if (res.status === "SESSION_NOT_FOUND") {
        setErrorMessage("Recover could not find the durable test session for this payment.");
        setCheckoutState("ERROR");
      } else if (res.status === "NO_PAYMENT_ATTEMPT_FOUND") {
        setErrorMessage("Razorpay reports no payment attempts on this order yet. Try completing or failing a payment in Checkout.");
      } else {
        setErrorMessage(`Provider status: ${res.status}. Payment is not in failed state.`);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to reconcile with Razorpay API.");
    } finally {
      setManualChecking(false);
    }
  };

  const handleReset = () => {
    setRealOrder(null);
    setCheckoutState("READY");
    failureObservedRef.current = false;
    candidatePaymentIdRef.current = null;
    setCandidatePaymentId(null);
    setIsDirectReconciling(false);
    confirmStartTimeRef.current = null;
    setErrorMessage(null);
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
        Create a test payment
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose the payment Recover will later try to recover.
      </p>

      {errorMessage ? (
        <div className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-4 text-xs text-danger">
          <strong>Notice:</strong> {errorMessage}
        </div>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Panel title="Payment details">
            {checkoutState === "CONFIRMING_PROVIDER_FAILURE" || checkoutState === "CLIENT_FAILURE_REPORTED" ? (
              <div className="space-y-6 py-4">
                <div className="flex flex-col items-center gap-2 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                  <h3 className="text-base font-bold text-foreground">
                    Payment failed in Checkout
                  </h3>
                  <p className="max-w-md text-xs leading-5 text-muted-foreground">
                    {isDirectReconciling
                      ? "Webhook delayed — checking Razorpay directly..."
                      : "Confirming canonical Razorpay provider state..."}
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-muted/40 p-4">
                  <ul className="divide-y divide-border/60">
                    <StepRow
                      label="Payment failed in Checkout"
                      state="done"
                      detail="Client signal received"
                    />
                    <StepRow
                      label={
                        isDirectReconciling
                          ? "Reconciling canonical Razorpay API"
                          : "Awaiting signed Razorpay webhook"
                      }
                      state="active"
                      detail={isDirectReconciling ? "Checking directly" : "Verifying HMAC"}
                    />
                    <StepRow label="Verified failure recorded" state="pending" />
                    <StepRow label="Starting Recover agent workflow" state="pending" />
                  </ul>
                </div>

                {candidatePaymentId ? (
                  <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-xs">
                    <div>
                      <p className="font-mono font-medium text-foreground">{candidatePaymentId}</p>
                      <p className="text-[11px] text-muted-foreground">Candidate payment hint</p>
                    </div>
                    <PaymentStatusBadge status="AWAITING VERIFICATION" tone="warning" />
                  </div>
                ) : null}
              </div>
            ) : checkoutState === "CHECKOUT_DISMISSED" ? (
              <div className="flex flex-col items-center gap-4 py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <XCircle className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">Checkout closed</h3>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                    No failed payment has been confirmed yet. You closed the checkout without a verified failure.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <DemoButton onClick={handleOpenStandardCheckout}>
                    Reopen Test Checkout <ArrowRight className="h-4 w-4" />
                  </DemoButton>
                  <DemoButton
                    variant="outline"
                    loading={manualChecking}
                    onClick={handleManualReconciliation}
                  >
                    <RefreshCw className="h-4 w-4" /> Check Razorpay State
                  </DemoButton>
                </div>
              </div>
            ) : checkoutState === "PROVIDER_CONFIRMATION_TIMEOUT" ? (
              <div className="flex flex-col items-center gap-4 py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warning-soft text-warning">
                  <Clock className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">
                    Razorpay confirmation is taking longer than expected
                  </h3>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                    We haven't received a confirmed failed payment from Razorpay yet. You can manually check provider state or reopen checkout.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <DemoButton loading={manualChecking} onClick={handleManualReconciliation}>
                    <RefreshCw className="h-4 w-4" /> Check Provider State
                  </DemoButton>
                  <DemoButton variant="outline" onClick={handleOpenStandardCheckout}>
                    Reopen Checkout
                  </DemoButton>
                  <DemoButton variant="outline" onClick={handleReset}>
                    Back to Test Payment
                  </DemoButton>
                </div>
              </div>
            ) : checkoutState === "PAYMENT_SUCCEEDED" ? (
              <div className="flex flex-col items-center gap-4 py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">Payment succeeded</h3>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                    No recovery was required because the initial payment completed successfully.
                    <br />
                    Run another test and choose <strong>Failure</strong> to see Recover in action.
                  </p>
                </div>
                <DemoButton onClick={handleReset}>Create Another Test Payment</DemoButton>
              </div>
            ) : realOrder ? (
              <>
                <div className="divide-y divide-border/70">
                  <Field label="Razorpay Order" value={realOrder.orderId} />
                  <Field label="Amount" value={formatINR(realOrder.amountMinor)} />
                  <Field label="Currency" value={realOrder.currency} />
                  <Field label="Customer" value={name} />
                  <Field label="Email" value={email} />
                  <Field label="Payment purpose" value={purpose} />
                  <Field label="Description" value={descriptionValue} />
                  <Field
                    label="Status"
                    value={<PaymentStatusBadge status="READY FOR CHECKOUT" tone="brand" />}
                  />
                </div>

                <div className="mt-4 rounded-xl border border-brand-soft bg-brand-softer/60 px-3.5 py-2.5 text-xs text-brand">
                  💡 <strong>Demo note:</strong> Checkout retry is disabled so Recover can take over after the first failed attempt.
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <DemoButton onClick={handleOpenStandardCheckout}>
                    Open Test Checkout <ArrowRight className="h-4 w-4" />
                  </DemoButton>
                  <DemoButton variant="outline" onClick={handleReset}>
                    Change Details
                  </DemoButton>
                </div>
              </>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreate();
                }}
              >
                <div>
                  <Label>Amount (INR)</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
                      ₹
                    </span>
                    <input
                      className={inputClass(!amountValid) + " pl-7 font-mono"}
                      inputMode="numeric"
                      value={amount}
                      min={MIN_RUPEES}
                      max={MAX_RUPEES}
                      type="number"
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>
                  <p
                    className={
                      "mt-1.5 text-[11px] " +
                      (amountValid ? "text-muted-foreground" : "text-danger")
                    }
                  >
                    Demo range ₹{MIN_RUPEES.toLocaleString("en-IN")} — ₹
                    {MAX_RUPEES.toLocaleString("en-IN")} · currency fixed to INR
                  </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <Label>Customer name</Label>
                    <input
                      className={inputClass(!nameValid)}
                      value={name}
                      maxLength={60}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <Label>Customer email</Label>
                    <input
                      className={inputClass(!emailValid)}
                      value={email}
                      type="email"
                      maxLength={120}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                </div>

                <label className="block">
                  <Label>Payment purpose</Label>
                  <select
                    className={inputClass()}
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                  >
                    {purposes.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <Label>Description</Label>
                  <input
                    className={inputClass(descriptionValue.trim().length === 0)}
                    value={descriptionValue}
                    maxLength={80}
                    onChange={(e) => setDescriptionValue(e.target.value)}
                  />
                </label>

                <DemoButton
                  type="submit"
                  className="w-full sm:w-auto"
                  loading={loading}
                  disabled={!formValid}
                >
                  {loading ? "Creating payment..." : `Create ${formatINR(amountMinor)} Test Payment`}
                </DemoButton>

                <p className="text-[11px] leading-5 text-muted-foreground">
                  This amount will follow the case through failure, recovery and verification.
                  <br />
                  Try changing the amount — Recover will carry the same value through every decision
                  and verification step.
                </p>
              </form>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="What you're about to prove">
            <ol className="space-y-4">
              {stages.map((s) => (
                <li key={s.no} className="flex gap-3">
                  <span
                    className={
                      "mt-0.5 font-mono text-[11px] font-bold " +
                      (s.accent ? "text-brand" : "text-muted-foreground")
                    }
                  >
                    {s.no}
                  </span>
                  <div>
                    <p
                      className={
                        "text-[11px] font-bold tracking-wide uppercase " +
                        (s.accent ? "text-brand" : "text-foreground")
                      }
                    >
                      {s.label}
                    </p>
                    <p
                      className={
                        "mt-1 text-[11px] leading-5 " +
                        (s.accent ? "text-foreground" : "text-muted-foreground")
                      }
                    >
                      {s.copy}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <div className="rounded-2xl border border-brand-soft bg-brand-softer px-4 py-3">
            <p className="text-[10px] font-bold tracking-wide text-brand uppercase">Razorpay Test Mode</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              This creates real Razorpay sandbox objects (Orders, Payments, Payment Links). No real money moves.
            </p>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              Trigger a deliberate failure in Razorpay Checkout to test AI failure diagnosis, deterministic gating, and recovery.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
              Production flow
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
              {productionFlow.map((step, i) => (
                <span key={step} className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] font-semibold text-foreground">
                    {step}
                  </span>
                  {i < productionFlow.length - 1 ? (
                    <span className="text-[10px] text-brand">→</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
