import { ArrowRight, Github } from "lucide-react";
import { BrandLink, Card, OutlineButton } from "./primitives";
import { GrowthChart } from "./illustrations";

export function ClosingCta() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pb-20 pt-8">
      <Card className="flex flex-col items-center gap-8 px-8 py-10 md:flex-row md:gap-12">
        <GrowthChart className="h-32 w-40 shrink-0" />
        <div className="flex-1">
          <h2 className="text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl">
            Recover More <span className="text-brand">Revenue.</span>
            <br />
            Delight More <span className="text-brand">Customers.</span>
          </h2>
          <p className="mt-4 text-xs leading-6 text-muted-foreground">
            One failed payment is revenue.
            <br />
            Let AI recover what&apos;s rightfully yours.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <BrandLink to="/demo">
            Try Live Demo <ArrowRight className="h-4 w-4" />
          </BrandLink>
          <OutlineButton href="https://github.com">
            View on GitHub <Github className="h-4 w-4" />
          </OutlineButton>
        </div>
      </Card>
    </section>
  );
}
