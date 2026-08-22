import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export function BrandLink({ children, to }: { children: ReactNode; to: "/demo" }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground shadow-[0_6px_16px_-6px_var(--brand)] transition-colors hover:bg-brand/90"
    >
      {children}
    </Link>
  );
}

export function Pill({ children, dot = false }: { children: ReactNode; dot?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-brand-soft bg-brand-softer px-4 py-1.5 text-xs font-semibold text-brand">
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-brand" /> : null}
      {children}
    </span>
  );
}

export function BrandButton({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={
        "inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground shadow-[0_6px_16px_-6px_var(--brand)] transition-colors hover:bg-brand/90 " +
        className
      }
    >
      {children}
    </button>
  );
}

const outlineClass =
  "inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted";

export function OutlineButton({
  children,
  href,
  onClick,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={outlineClass}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={outlineClass}>
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={
        "rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(16,24,40,0.04)] " + className
      }
    >
      {children}
    </div>
  );
}
