import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { DemoButton, Panel } from "@/components/demo/ui";
import { VerificationProgress } from "@/components/demo/proof";
import { getCaseFn } from "@/lib/api/server-fns";
import { formatINRMinor } from "@/lib/domain/money";

const title = "Verifying recovery — Recover";
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
  const [caseData, setCaseData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const loadCase = async () => {
    try {
      const data = await getCaseFn({ data: id });
      if (data) {
        setCaseData(data);
        if (data.terminal_status === "RECOVERED_VERIFIED") {
          setTimeout(() => {
            navigate({ to: "/demo/recovery/$id/result", params: { id } });
          }, 1200);
        }
      }
    } catch (err) {
      console.error("[Verify Load Error]:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCase();
    const interval = setInterval(loadCase, 2000);
    return () => clearInterval(interval);
  }, [id]);

  if (loading && !caseData) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center px-6 py-24 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="mt-4 text-sm font-semibold text-foreground">Loading verification state...</p>
      </main>
    );
  }

  if (!caseData) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20 text-center">
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          Recovery case not found
        </h1>
        <DemoButton className="mt-6" onClick={() => navigate({ to: "/demo" })}>
          Back to overview
        </DemoButton>
      </main>
    );
  }

  const receipt = caseData.verification_receipts?.[0];
  const checksPassed: Array<{ key: string; expected: any; observed: any; passed: boolean }> =
    receipt?.checks_passed || [];

  const displayChecks =
    checksPassed.length > 0
      ? checksPassed.map((c) => ({
          id: c.key,
          label: c.key.replace(/_/g, " "),
          result: String(c.observed),
        }))
      : [
          {
            id: "event",
            label: "Payment event received",
            result: caseData.status === "VERIFYING" ? "Received" : "Waiting",
          },
          {
            id: "canonical",
            label: "Fetching canonical payment state",
            result: receipt ? "Fetched" : "Pending",
          },
          {
            id: "amount",
            label: "Checking exact amount",
            result: formatINRMinor(caseData.amount_minor),
          },
          {
            id: "link",
            label: "Checking Payment Link status",
            result: receipt ? "Verified" : "Pending",
          },
          {
            id: "receipt",
            label: "Generating verification receipt",
            result: receipt ? "Generated" : "Pending",
          },
        ];

  const done = Boolean(receipt) && caseData.terminal_status === "RECOVERED_VERIFIED";

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-14">
      <div className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-warning-soft bg-warning-soft px-4 py-1.5 text-xs font-bold tracking-wide text-warning uppercase">
          {done ? "Verification complete" : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {done ? "Verified" : "Verifying"}
        </span>
        <h1 className="mt-5 text-2xl font-bold tracking-tight text-foreground">
          {done ? "Payment verified" : "Payment submitted"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {done
            ? "Canonical provider checks passed."
            : "Waiting for signed webhook and canonical provider confirmation..."}
        </p>
      </div>

      <VerificationProgress checks={displayChecks} completed={done ? displayChecks.length : 2} />

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
