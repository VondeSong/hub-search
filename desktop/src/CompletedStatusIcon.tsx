export type CompletedStatusIconProps = {
  size?: number;
  className?: string;
  variant?: "filled" | "outline";
};

export function CompletedStatusIcon({ size = 18, className, variant = "filled" }: CompletedStatusIconProps) {
  return (
    <svg
      className={className}
      data-variant={variant}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="16" cy="16" r={variant === "filled" ? 15 : 14} fill={variant === "filled" ? "currentColor" : "none"}
        stroke={variant === "outline" ? "currentColor" : undefined} strokeWidth={variant === "outline" ? 2.2 : undefined}/>
      <path
        d="m9.25 16.2 4.35 4.35 9.15-9.3"
        stroke={variant === "filled" ? "#fff" : "currentColor"}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
