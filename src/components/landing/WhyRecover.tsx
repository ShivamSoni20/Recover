import { Brain, Lock, ShieldCheck, Zap } from "lucide-react";
import { Card, Pill } from "./primitives";

const items = [
  {
    icon: Brain,
    title: ["AI-Powered", "Diagnosis"],
    body: "Understands why payment failed and finds the recovery events.",
  },
  {
    icon: ShieldCheck,
    title: ["Deterministic", "Safety Gates"],
    body: "Every recovery action is validated by strict policy and business rules.",
  },
  {
    icon: Zap,
    title: ["Smart Recovery", "Actions"],
    body: "Suggests the best next step—retry, new link, alternate method & more.",
  },
  {
    icon: Lock,
    title: ["Secure &", "Merchant-First"],
    body: "Designed to be safe, respectful users & built merchant scale.",
  },
];

export function WhyRecover() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-16 text-center">
      <Pill>Why Recover</Pill>
      <h2 className="mt-8 text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl">
        AI intelligence. Deterministic safety.
        <br />
        Real revenue recovery.
      </h2>
      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(({ icon: Icon, title, body }) => (
          <Card key={title.join(" ")} className="flex flex-col items-center px-6 py-8">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft">
              <Icon className="h-7 w-7 text-brand" />
            </span>
            <h3 className="mt-6 text-sm font-bold leading-6 text-foreground">
              {title[0]}
              <br />
              {title[1]}
            </h3>
            <p className="mt-4 text-xs leading-6 text-muted-foreground">{body}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
