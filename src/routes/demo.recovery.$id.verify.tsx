import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { DemoButton, Panel } from "@/components/demo/ui";
import { VerificationProgress } from "@/components/demo/proof";
import { buildVerificationChecks } from "@/lib/demo/data";
import { updateCase, useDemoCase } from "@/lib/demo/store";

const title = "Verifying recovery — Recover Demo";
const description =
  "A payment success callback is not a verified recovery. Recover independently confirms canonical payment state before declaring success.";

export const Route = createFileRoute("/demo/recovery/$id/verify")({
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
  component: VerifyRecovery,
});

function VerifyRecovery() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const demoCase = useDemoCase(id);
  const [completed, setCompleted] = useState(0);

  const amount = demoCase?.amountMinor ?? 299900;
  const checks = useMemo(() => buildVerificationChecks(amount), [amount]);
  const finalized = useRef(false);
  const [goResult, setGoResult] = useState(false);

  useEffect(() => {
    if (!demoCase) return;
    if (demoCase.state === "PAYMENT_SUBMITTED") {
      updateCase(demoCase.caseId, { state: "VERIFYING" }, "Payment confirmation received");
    }
  }, [demoCase]);

  useEffect(() => {
    if (!demoCase) return;
    if (completed >= checks.length) return;
    const t = window.setTimeout(() => setCompleted((n) => n + 1), 750);
    return () => window.clearTimeout(t);
  }, [completed, checks.length, demoCase]);

  useEffect(() => {
    if (!demoCase) return;
    if (completed < checks.length) return;
    if (finalized.current) return;
    finalized.current = true;
    updateCase(
      demoCase.caseId,
      { state: "RECOVERED_VERIFIED", verificationChecks: checks, paymentStatus: "CAPTURED" },
      "RECOVERED — VERIFIED",
    );
    window.setTimeout(() => setGoResult(true), 700);
  }, [completed, checks, demoCase, id]);

  if (goResult && demoCase) {
    return <Navigate to="/demo/recovery/$id/result" params={{ id }} replace />;
  }

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

  const done = completed >= checks.length;

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-14">
      <div className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-warning-soft bg-warning-soft px-4 py-1.5 text-xs font-bold tracking-wide text-warning uppercase">
          {done ? "Verification complete" : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {done ? null : "Verifying"}
        </span>
        <h1 className="mt-5 text-2xl font-bold tracking-tight text-foreground">Payment submitted</h1>
        <p className="mt-2 text-sm text-muted-foreground">Waiting for provider confirmation...</p>
      </div>

      <VerificationProgress checks={checks} completed={completed} />

      <Panel className="mt-4 bg-brand-softer">
        <p className="text-xs leading-6 text-foreground">
          A payment success callback is not a verified recovery. Recover reloads canonical payment
          state and re-checks amount, relationship and duplicate collection before declaring the
          revenue recovered.
        </p>
      </Panel>
    </main>
  );
}
