import { ArrowRight, Bot, CircleAlert, ListChecks, ShieldCheck, Zap } from "lucide-react";
import { BrandLink, Card, Pill } from "./primitives";

const flow = [
  { icon: ListChecks, label: "Real Payment", tone: "text-brand bg-brand-soft" },
  { icon: CircleAlert, label: "Real Failure", tone: "text-danger bg-danger-soft" },
  { icon: Bot, label: "AI Diagnosis", tone: "text-brand bg-brand-soft" },
  { icon: Zap, label: "Recovery Action", tone: "text-brand bg-brand-soft" },
  { icon: ShieldCheck, label: "Payment Success", tone: "text-success bg-success-soft" },
];

export function SeeItLive() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-8 text-center">
      <span className="inline-flex items-center rounded-full border border-border bg-card px-5 py-2 text-base font-semibold text-foreground">
        See It Live
      </span>
      <Card className="mt-8 px-6 py-8">
        <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
          {flow.map(({ icon: Icon, label, tone }, i) => (
            <div key={label} className="flex items-center gap-4 sm:gap-6">
              <div className="flex w-24 flex-col items-center gap-3">
                <span className={"flex h-12 w-12 items-center justify-center rounded-2xl " + tone}>
                  <Icon className="h-6 w-6" />
                </span>
                <span className="text-[11px] font-medium text-foreground">{label}</span>
              </div>
              {i < flow.length - 1 ? <ArrowRight className="h-4 w-4 text-brand" /> : null}
            </div>
          ))}
        </div>
      </Card>
      <div className="mt-10 flex flex-col items-center gap-3">
        <BrandLink to="/demo">
          Launch Live Demo <ArrowRight className="h-4 w-4" />
        </BrandLink>
        <p className="text-[11px] text-muted-foreground">No signup required. Just click and go.</p>
      </div>
      <div className="sr-only">
        <Pill>Live demo flow</Pill>
      </div>
    </section>
  );
}
