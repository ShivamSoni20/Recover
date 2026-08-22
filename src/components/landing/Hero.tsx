import { CircleCheck } from "lucide-react";
import { Pill } from "./primitives";

const features = [
  "Full Revenue Recapture",
  "AI-Powered Failure Diagnosis",
  "Deterministic Recovery Rules",
  "Secure, Merchant-First System",
];

export function Hero() {
  return (
    <section className="mx-auto w-full max-w-5xl px-6 pb-16 pt-8 text-center">
      <Pill dot>Built for Recovery &amp; B2B SaaS</Pill>
      <h1 className="mx-auto mt-8 max-w-3xl text-4xl font-bold leading-[1.12] tracking-tight text-foreground sm:text-5xl md:text-6xl">
        Failed payments
        <br />
        deserve a <span className="text-brand">second chance.</span>
      </h1>
      <p className="mx-auto mt-6 max-w-xl text-base leading-8 text-muted-foreground">
        Recover is an AI agent that diagnoses why payments fail and recommends the safest way to
        recover them.
      </p>
      <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2 text-xs font-medium text-foreground">
            <CircleCheck className="h-4 w-4 text-brand" fill="currentColor" stroke="var(--card)" />
            {f}
          </li>
        ))}
      </ul>
    </section>
  );
}
