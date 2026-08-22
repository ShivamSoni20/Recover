import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { DemoButton } from "@/components/demo/ui";
import { ProofStrip, RecoveryTimelineDrawer, VerificationReceipt } from "@/components/demo/proof";
import { useDemoCase } from "@/lib/demo/store";
import { formatINR } from "@/lib/demo/types";

const title = "Revenue recovered — verified | Recover Demo";
const description =
  "The failed payment was recovered through a fresh checkout and independently verified against canonical payment state.";

export const Route = createFileRoute("/demo/recovery/$id/result")({
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
  component: RecoveryResult,
});

function RecoveryResult() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const demoCase = useDemoCase(id);
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          {formatINR(demoCase.amountMinor)} recovered.
        </h1>
        <p className="mt-2 text-sm font-semibold text-success">Revenue recovered — VERIFIED</p>
      </div>

      <ProofStrip className="mt-8" />

      <div className="mt-8">
        <VerificationReceipt demoCase={demoCase} />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <DemoButton onClick={() => navigate({ to: "/demo/create" })}>
          Run another demo <ArrowRight className="h-4 w-4" />
        </DemoButton>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Return to landing page
        </Link>
        <DemoButton variant="outline" onClick={() => setDrawerOpen(true)}>
          View recovery timeline
        </DemoButton>
      </div>

      <RecoveryTimelineDrawer open={drawerOpen} onOpenChange={setDrawerOpen} demoCase={demoCase} />
    </main>
  );
}
