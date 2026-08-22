export function RecoverLogo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" role="img" aria-label="Recover logo" className={className}>
      <rect width="40" height="40" rx="12" fill="var(--brand)" />
      <path
        d="M20 9.5a10.5 10.5 0 1 1-9.4 5.8"
        fill="none"
        stroke="var(--brand-foreground)"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M9.3 9.4v6.4h6.4"
        fill="none"
        stroke="var(--brand-foreground)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path
        d="M16.4 15h7.4M16.4 19h7.4M22 15c0 4-2.4 4-5.6 4l7.4 7"
        fill="none"
        stroke="var(--brand-foreground)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
