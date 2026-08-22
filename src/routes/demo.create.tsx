import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { DemoButton, Field, PaymentStatusBadge, Panel } from "@/components/demo/ui";
import { RecoveryCheckoutModal } from "@/components/demo/modals";
import { createCase, DEMO_AMOUNT_MINOR, nowClock, updateCase } from "@/lib/demo/store";
import { formatINR, type DemoCase } from "@/lib/demo/types";

const title = "Create a test payment — Recover Demo";
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

function CreatePayment() {
  const navigate = useNavigate();
  const [amount, setAmount] = useState(String(DEMO_AMOUNT_MINOR / 100));
  const [name, setName] = useState("Amit Sharma");
  const [email, setEmail] = useState("amit@example.com");
  const [purpose, setPurpose] = useState<string>("Pro Plan — Annual");
  const [descriptionValue, setDescriptionValue] = useState("Recover Buildathon Test");
  const [loading, setLoading] = useState(false);
  const [order, setOrder] = useState<DemoCase | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const parsed = Number(amount);
  const amountValid = Number.isFinite(parsed) && parsed >= MIN_RUPEES && parsed <= MAX_RUPEES;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameValid = name.trim().length > 0 && name.trim().length <= 60;
  const formValid = amountValid && emailValid && nameValid && descriptionValue.trim().length > 0;
  const amountMinor = amountValid ? Math.round(parsed * 100) : DEMO_AMOUNT_MINOR;

  const handleCreate = () => {
    if (!formValid) return;
    setLoading(true);
    window.setTimeout(() => {
      const created = createCase({
        amountMinor,
        description: descriptionValue.trim().slice(0, 80),
        customer: {
          name: name.trim().slice(0, 60),
          email: email.trim().slice(0, 120),
          purpose,
        },
      });
      setOrder(created);
      setLoading(false);
    }, 850);
  };

  const handleOutcome = (outcome: "success" | "failed") => {
    if (!order) return;
    updateCase(order.caseId, { state: "WAITING_INITIAL_PAYMENT" });
    if (outcome === "failed") {
      updateCase(
        order.caseId,
        { state: "PAYMENT_FAILED", paymentStatus: "FAILED", failedAt: nowClock() },
        "Payment failed",
      );
      setCheckoutOpen(false);
      navigate({ to: "/demo/payment/$id", params: { id: order.caseId } });
    } else {
      setCheckoutOpen(false);
      navigate({ to: "/demo" });
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
        Create a test payment
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose the payment Recover will later try to recover.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Panel title="Payment details">
            {order ? (
              <>
                <div className="divide-y divide-border/70">
                  <Field label="Demo order" value={order.orderId} />
                  <Field label="Amount" value={formatINR(order.amountMinor)} />
                  <Field label="Currency" value="INR" />
                  <Field label="Customer" value={order.customer.name} />
                  <Field label="Email" value={order.customer.email} />
                  <Field label="Payment purpose" value={order.customer.purpose} />
                  <Field label="Description" value={order.description} />
                  <Field
                    label="Status"
                    value={<PaymentStatusBadge status="READY FOR CHECKOUT" tone="brand" />}
                  />
                </div>
                <p className="mt-4 text-xs font-semibold text-success">Payment created</p>
                <DemoButton className="mt-3 w-full sm:w-auto" onClick={() => setCheckoutOpen(true)}>
                  Open Test Checkout <ArrowRight className="h-4 w-4" />
                </DemoButton>
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
                    Demo range ₹{MIN_RUPEES.toLocaleString("en-IN")} – ₹
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
                  onClick={handleCreate}
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
            <p className="text-[10px] font-bold tracking-wide text-brand uppercase">Demo mode</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              This interactive walkthrough simulates the same state machine used by Recover. No real
              money moves here.
            </p>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              The production implementation replaces these demo transitions with Razorpay Test Mode
              Orders, Payments, signed webhooks and Payment Links.
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

      {order ? (
        <RecoveryCheckoutModal
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          mode="initial"
          amountMinor={order.amountMinor}
          onOutcome={handleOutcome}
        />
      ) : null}
    </main>
  );
}
