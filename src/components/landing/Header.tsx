import { ArrowRight } from "lucide-react";
import { BrandLink } from "./primitives";
import { RecoverLogo } from "@/components/brand/RecoverLogo";

export function Header() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
      <div className="flex items-center gap-3">
        <RecoverLogo className="h-9 w-9" />
        <span className="text-xl font-bold tracking-tight text-foreground">Recover</span>
      </div>
      <BrandLink to="/demo">
        Try Live Demo <ArrowRight className="h-4 w-4" />
      </BrandLink>
    </header>
  );
}
