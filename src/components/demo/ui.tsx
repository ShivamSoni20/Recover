import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "brand" | "outline" | "danger";
  loading?: boolean;
};

export function DemoButton({
  variant = "brand",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        variant === "brand" &&
          "bg-brand text-brand-foreground shadow-[0_6px_16px_-6px_var(--brand)] hover:bg-brand/90",
        variant === "outline" && "border border-border bg-card text-foreground hover:bg-muted",
        variant === "danger" &&
          "bg-danger text-brand-foreground shadow-[0_6px_16px_-6px_var(--danger)] hover:bg-danger/90",
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Panel({
  children,
  className,
  title,
  aside,
}: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]",
        className,
      )}
    >
      {title ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold tracking-tight text-foreground">{title}</h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function DemoModeBadge({ className }: { className?: string }) {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex cursor-help items-center gap-1.5 rounded-full border border-brand-soft bg-brand-softer px-3 py-1 text-[10px] font-bold tracking-wide text-brand uppercase",
              className,
            )}
          >
            <Info className="h-3 w-3" /> Demo mode
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          This interactive demo simulates the Recover workflow. The production build uses Razorpay
          Test Mode APIs and signed webhooks.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type Tone = "neutral" | "danger" | "success" | "warning" | "brand";

const toneClass: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  danger: "border-transparent bg-danger-soft text-danger",
  success: "border-transparent bg-success-soft text-success",
  warning: "border-transparent bg-warning-soft text-warning",
  brand: "border-transparent bg-brand-soft text-brand",
};

export function PaymentStatusBadge({
  status,
  tone,
  className,
}: {
  status: string;
  tone?: Tone;
  className?: string;
}) {
  const resolved: Tone =
    tone ??
    (/(FAILED|DECLINE)/i.test(status)
      ? "danger"
      : /(CAPTURED|VERIFIED|SUCCESS|AUTHORIZED|PASSED|ACTIVE)/i.test(status)
        ? "success"
        : /(WAITING|PENDING|REVIEW)/i.test(status)
          ? "warning"
          : "neutral");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide uppercase",
        toneClass[resolved],
        className,
      )}
    >
      {status}
    </span>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 py-2.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-xs font-semibold break-all text-foreground">
        {value}
      </span>
    </div>
  );
}

export function DemoMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "brand" | "success" | "danger";
}) {
  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-4">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-1.5 text-2xl font-bold tracking-tight",
          tone === "brand" && "text-brand",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
          tone === "neutral" && "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function StepDot({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done")
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  if (state === "active")
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  return <span className="h-5 w-5 shrink-0 rounded-full border border-dashed border-border" />;
}

export function StepRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: "done" | "active" | "pending";
  detail?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <StepDot state={state} />
      <span
        className={cn(
          "flex-1 text-xs",
          state === "pending" ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {label}
      </span>
      {detail ? <span className="text-[11px] text-muted-foreground">{detail}</span> : null}
    </li>
  );
}
