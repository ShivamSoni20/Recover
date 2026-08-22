import { createFileRoute } from "@tanstack/react-router";
import { Header } from "@/components/landing/Header";
import { Hero } from "@/components/landing/Hero";
import { WhyRecover } from "@/components/landing/WhyRecover";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { SeeItLive } from "@/components/landing/SeeItLive";
import { ClosingCta } from "@/components/landing/ClosingCta";

const title = "Recover — AI revenue recovery for failed payments";
const description =
  "Recover is an AI agent that diagnoses why payments fail and recommends the safest way to recover them, with deterministic safety gates and verified results.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "/" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="min-h-screen bg-background">
      <Header />
      <Hero />
      <WhyRecover />
      <HowItWorks />
      <SeeItLive />
      <ClosingCta />
    </main>
  );
}
