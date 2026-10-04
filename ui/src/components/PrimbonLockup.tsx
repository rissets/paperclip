import type { SVGProps } from "react";
import { cn } from "../lib/utils";

interface PrimbonLockupProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  decorative?: boolean;
  title?: string;
}

export function PrimbonLockup({
  decorative = false,
  title = "Primbon",
  className,
  ...rest
}: PrimbonLockupProps) {
  return (
    <svg
      {...rest}
      className={cn("h-7 w-auto", className)}
      viewBox="0 0 170 36"
      fill="currentColor"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <defs>
        <linearGradient id="lockup-orange" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFB300" />
          <stop offset="100%" stopColor="#FF5722" />
        </linearGradient>
        <linearGradient id="lockup-blue" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
      </defs>

      {/* Primbon Icon */}
      <g transform="translate(2, 2) scale(0.32)">
        <rect x="80" y="0" width="20" height="20" rx="3.5" fill="url(#lockup-blue)" />
        <rect x="0" y="80" width="20" height="20" rx="3.5" fill="url(#lockup-blue)" />
        <path d="M 9.5 0 L 57.5 0 Q 60 0 61.8 1.8 L 78.2 18.2 Q 80 20 77.5 20 L 29.5 20 Q 27 20 25.2 18.2 L 8.8 1.8 Q 7 0 9.5 0 Z" fill="url(#lockup-orange)" />
        <path d="M 90.5 100 L 42.5 100 Q 40 100 38.2 98.2 L 21.8 81.8 Q 20 80 22.5 80 L 70.5 80 Q 73 80 74.8 81.8 L 91.2 98.2 Q 93 100 90.5 100 Z" fill="url(#lockup-orange)" />
        <path d="M 0 60 L 0 9.5 Q 0 7 1.8 5.2 L 18.2 21.8 Q 20 23.5 20 26 L 20 40 L 80 40 L 80 22.5 Q 80 20 81.8 18.2 L 98.2 34.8 Q 100 36.5 100 39 L 100 90.5 Q 100 93 98.2 94.8 L 81.8 78.2 Q 80 76.5 80 74 L 80 60 L 20 60 L 20 77.5 Q 20 80 18.2 81.8 L 1.8 65.2 Q 0 63.5 0 60 Z" fill="url(#lockup-blue)" />
      </g>

      {/* "Primbon" Text */}
      <text
        x="42"
        y="21"
        fontFamily="Inter, system-ui, -apple-system, sans-serif"
        fontSize="18"
        fontWeight="700"
        fill="currentColor"
        letterSpacing="-0.03em"
      >
        Primbon
      </text>

      {/* "by hellodigi" Tagline */}
      <text
        x="43"
        y="31"
        fontFamily="Inter, system-ui, -apple-system, sans-serif"
        fontSize="8.5"
        fontWeight="500"
        fill="currentColor"
        opacity="0.6"
        letterSpacing="0.01em"
      >
        by hellodigi
      </text>
    </svg>
  );
}

export const PaperclipLockup = PrimbonLockup;
