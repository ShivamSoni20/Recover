import { ArrowRight } from "lucide-react";
import { Card, Pill } from "./primitives";
import { RobotWaveform, SkeletonWindow } from "./illustrations";

const steps = [
  {
    n: 1,
    art: <SkeletonWindow tone="error" />,
    title: "Payment Fails",
    body: "Customer attempts a payment but it fails due to UI errors, bank declines, network issues, etc.",
  },
  {
    n: 2,
    art: <RobotWaveform />,
    title: "AI Diagnoses",
    body: "Recover analyzes the failure using historical patterns and recommends the safest action.",
  },
  {
    n: 3,
    art: <SkeletonWindow tone="success" />,
    title: "Recovered & Succeed",
    body: "A new checkout link is created and the customer completes the payment successfully.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-16 text-center">
      <Pill>How It Works</Pill>
      <h2 className="mt-8 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        From Failure to Success in 3 Steps
      </h2>
      <div className="mt-10 flex flex-col items-stretch gap-4 lg:flex-row lg:items-center">
        {steps.map((s, i) => (
          <div key={s.n} className="flex flex-1 items-center gap-4">
            <Card className="relative flex-1 px-6 pb-6 pt-12 text-left">
              <span className="absolute left-4 top-4 flex h-6 w-6 items-center justify-center rounded-lg bg-brand text-[11px] font-bold text-brand-foreground">
                {s.n}
              </span>
              <div className="flex h-32 items-center justify-center">{s.art}</div>
              <h3 className="mt-8 text-sm font-bold text-foreground">{s.title}</h3>
              <p className="mt-3 text-xs leading-6 text-muted-foreground">{s.body}</p>
            </Card>
            {i < steps.length - 1 ? (
              <ArrowRight className="hidden h-5 w-5 shrink-0 text-brand lg:block" />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
