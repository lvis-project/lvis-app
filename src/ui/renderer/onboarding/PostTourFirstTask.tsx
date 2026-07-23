import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { cn } from "../../../lib/utils.js";
import type { PluginCardSummary } from "../types.js";
import {
  pickFirstTaskProposal,
  type FirstTaskProposal,
} from "./first-task-proposals.js";

export interface PostTourFirstTaskProps {
  /** Local renderer callback only; this never submits chat or invokes a tool. */
  onPrefillComposer: (text: string) => void;
  /** Manifest-derived cards, including runtime eligibility. */
  pluginCards: readonly PluginCardSummary[];
  /**
   * Set to `true` after the SpotlightTour completes. The card is
   * suppressed when false so the user is never offered a "first task"
   * before they have even completed the tour.
   */
  tourCompleted: boolean;
  /** Disable the entire card in non-onboarding contexts (e.g. tests). */
  disabled?: boolean;
}

export function PostTourFirstTask({
  onPrefillComposer,
  pluginCards,
  tourCompleted,
  disabled,
}: PostTourFirstTaskProps) {
  const { locale, t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const proposal = useMemo<FirstTaskProposal | null>(
    () => disabled || !tourCompleted || dismissed
      ? null
      : pickFirstTaskProposal(pluginCards, locale),
    [disabled, dismissed, locale, pluginCards, tourCompleted],
  );

  const onAccept = useCallback(() => {
    if (!proposal) return;
    try {
      onPrefillComposer(proposal.composerPrompt);
      setDismissed(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[post-tour-first-task] composer prefill failed", error);
      setPrefillError(message);
    }
  }, [onPrefillComposer, proposal]);

  const onSkip = useCallback(() => {
    setDismissed(true);
  }, []);

  if (!proposal) return null;

  return (
    <div
      data-testid="post-tour-first-task"
      data-plugin-id={proposal.pluginId}
      className={cn(
        "pointer-events-auto fixed bottom-6 right-6 z-[9000]",
        "w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-4 shadow-e4",
        "border-[hsl(var(--p-purple-500)/var(--opacity-medium))]",
      )}
      role="dialog"
      aria-label={t("postTourFirstTask.ariaLabel")}
    >
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: "hsl(var(--p-purple-500))" }}
      >
        {t("postTourFirstTask.badgeLabel")}
      </div>
      <h3 className="mt-1 text-[14px] font-semibold leading-tight">
        {proposal.headline}
      </h3>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
        {proposal.body}
      </p>
      {prefillError ? (
        <p className="mt-2 text-[11px] text-destructive" role="alert">
          {prefillError}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="post-tour-first-task:skip"
          onClick={onSkip}
          className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
        >
          {t("postTourFirstTask.skipButton")}
        </button>
        <button
          type="button"
          data-testid="post-tour-first-task:accept"
          onClick={onAccept}
          className={cn(
            "rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition hover:opacity-90",
          )}
        >
          {proposal.actionLabel}
        </button>
      </div>
    </div>
  );
}
