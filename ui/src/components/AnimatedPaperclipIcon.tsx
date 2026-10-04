import type { SVGProps } from "react";
import { cn } from "../lib/utils";
import { PrimbonLogo } from "./PrimbonLogo";

export function AnimatedPrimbonIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <PrimbonLogo
      variant="animated"
      className={cn("primbon-thinking-icon", className)}
      {...props}
    />
  );
}

/** Full-page loading state: a centered, animated Primbon logo. */
export function PrimbonLoading({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <AnimatedPrimbonIcon className="h-20 w-20" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

// Backward-compatible aliases for existing imports across the codebase
export const AnimatedPaperclipIcon = AnimatedPrimbonIcon;
export const PaperclipLoading = PrimbonLoading;
