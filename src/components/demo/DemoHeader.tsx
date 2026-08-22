import { Link, useNavigate } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { RecoverLogo } from "@/components/brand/RecoverLogo";
import { DemoModeBadge } from "./ui";
import { resetDemo } from "@/lib/demo/store";

export function DemoHeader() {
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-3.5">
        <Link to="/demo" className="flex items-center gap-2.5">
          <RecoverLogo className="h-8 w-8" />
          <span className="text-lg font-bold tracking-tight text-foreground">Recover</span>
        </Link>

        <nav className="hidden items-center gap-6 text-xs font-semibold text-muted-foreground md:flex">
          <Link to="/demo" activeProps={{ className: "text-foreground" }} activeOptions={{ exact: true }}>
            Demo
          </Link>
          <Link to="/demo/create" activeProps={{ className: "text-foreground" }}>
            Flow
          </Link>
          <Link to="/demo/history" activeProps={{ className: "text-foreground" }}>
            Proof
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <DemoModeBadge className="hidden sm:inline-flex" />
          <button
            type="button"
            onClick={() => {
              resetDemo();
              navigate({ to: "/demo" });
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset Demo
          </button>
          <Link
            to="/"
            className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
          >
            Exit Demo
          </Link>
        </div>
      </div>
    </header>
  );
}
