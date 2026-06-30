/**
 * OnboardingCard / OnboardingHeader — shared first-boot scaffold.
 *
 * The four onboarding screens (ScenarioShowcase, PersonalizedWelcome,
 * PluginShowcase, MemorySeedDialog) all open with the same brand header:
 * a gradient ✦ avatar followed by a DialogTitle + DialogDescription. Before
 * this component each screen pasted that scaffold inline, which let the
 * avatar size, gradient literal, and spacing drift between screens.
 *
 * OnboardingHeader centralises that scaffold. The brand gradient resolves
 * from the single --gradient-brand token (styles.css) so it adapts with the
 * active theme bundle and there is one source for the fill.
 *
 * OnboardingCard wraps the standard token-bordered body card the screens
 * repeat for their primary content block.
 */
import type { ReactNode } from "react";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { cn } from "../../../lib/utils.js";

export interface OnboardingHeaderProps {
  /** Brand avatar glyph (defaults to the LVIS ✦ mark). */
  glyph?: ReactNode;
  /** DialogTitle content. */
  title: ReactNode;
  /** DialogDescription content. */
  description?: ReactNode;
  /** test id forwarded to the DialogTitle for screen-specific assertions. */
  titleTestId?: string;
  /** Avatar size variant. The 2×2 grid intro uses the larger `lg` avatar. */
  size?: "sm" | "lg";
  /** Extra classes on the DialogHeader wrapper. */
  className?: string;
}

/**
 * Brand header — gradient avatar + title + description. Composed inside a
 * Dialog by every onboarding screen so the scaffold lives in one place.
 */
export function OnboardingHeader({
  glyph = "✦",
  title,
  description,
  titleTestId,
  size = "sm",
  className,
}: OnboardingHeaderProps) {
  const avatarSize =
    size === "lg" ? "h-10 w-10 text-base" : "h-7 w-7 text-[11px]";
  const titleClass =
    size === "lg" ? "text-sm font-semibold tracking-normal" : "text-sm font-medium";
  return (
    <DialogHeader className={cn("px-6 pt-6 pb-3 space-y-0", className)}>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          data-testid="onboarding-header:avatar"
          className={cn(
            "grid place-items-center rounded-md text-primary-foreground",
            size === "lg" ? "rounded-lg" : "rounded-md",
            avatarSize,
          )}
          style={{ background: "var(--gradient-brand)" }}
        >
          {glyph}
        </span>
        <div className="min-w-0">
          <DialogTitle className={titleClass} data-testid={titleTestId}>
            {title}
          </DialogTitle>
          {description !== undefined ? (
            <DialogDescription className="text-[11px]">
              {description}
            </DialogDescription>
          ) : null}
        </div>
      </div>
    </DialogHeader>
  );
}

export interface OnboardingCardProps {
  children: ReactNode;
  className?: string;
  /** Forwarded to the wrapper for screen-specific assertions. */
  testId?: string;
}

/**
 * Token-bordered body card — the muted-surface block the screens repeat for
 * their main content. Border + surface resolve from theme tokens.
 */
export function OnboardingCard({ children, className, testId }: OnboardingCardProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "rounded-lg border border-border/(--opacity-stronger) bg-[hsl(var(--muted))] px-3 py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
