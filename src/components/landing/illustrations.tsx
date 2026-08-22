export function SkeletonWindow({ tone = "error" }: { tone?: "error" | "success" }) {
  return (
    <div className="relative w-full">
      <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="mb-3 flex gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-border" />
          <span className="h-1.5 w-1.5 rounded-full bg-border" />
          <span className="h-1.5 w-1.5 rounded-full bg-border" />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-2 w-1/2 rounded-full bg-muted" />
            <div
              className={
                "h-2 w-8 rounded-full " + (tone === "error" ? "bg-danger/70" : "bg-success/70")
              }
            />
          </div>
          <div className="h-2 w-4/5 rounded-full bg-muted" />
          <div className="h-2 w-2/3 rounded-full bg-muted" />
          <div className="h-2 w-3/5 rounded-full bg-muted" />
        </div>
      </div>
      <div
        className={
          "absolute -bottom-4 -right-2 flex h-11 w-11 items-center justify-center rounded-full text-2xl font-bold text-brand-foreground shadow-lg " +
          (tone === "error" ? "bg-danger" : "bg-success")
        }
        aria-hidden
      >
        {tone === "error" ? (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M12 6v8" />
            <circle cx="12" cy="18" r="0.5" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5 10 17.5 19 7.5" />
          </svg>
        )}
      </div>
    </div>
  );
}

export function RobotWaveform() {
  return (
    <div className="flex w-full items-center justify-center gap-2">
      <svg viewBox="0 0 40 40" className="h-10 w-10 text-brand/40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M2 20h4M10 12v16M18 6v28M26 12v16M34 16v8M38 20h0.5" />
      </svg>
      <svg viewBox="0 0 72 76" className="h-24 w-24" fill="none" aria-hidden>
        <path d="M36 6v10" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="36" cy="5" r="4" fill="var(--brand)" />
        <rect x="12" y="16" width="48" height="36" rx="12" fill="var(--brand)" />
        <circle cx="27" cy="34" r="6" fill="white" />
        <circle cx="45" cy="34" r="6" fill="white" />
        <path d="M20 56v8M52 56v8M14 40H8M58 40h6" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round" />
        <path d="M12 68h48" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round" opacity="0.35" />
      </svg>
      <svg viewBox="0 0 40 40" className="h-10 w-10 text-brand/40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M38 20h-4M30 12v16M22 6v28M14 12v16M6 16v8M2 20h-0.5" />
      </svg>
    </div>
  );
}

export function GrowthChart({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 160" className={className} fill="none" aria-hidden>
      <path
        d="M20 120 L70 70 L110 95 L170 25"
        stroke="var(--brand)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <path d="M150 25h22v22" stroke="var(--brand)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <rect x="24" y="112" width="26" height="36" rx="6" fill="var(--brand)" opacity="0.25" />
      <rect x="62" y="86" width="26" height="62" rx="6" fill="var(--brand)" opacity="0.45" />
      <rect x="100" y="100" width="26" height="48" rx="6" fill="var(--brand)" opacity="0.6" />
      <rect x="138" y="60" width="26" height="88" rx="6" fill="var(--brand)" opacity="0.85" />
    </svg>
  );
}
