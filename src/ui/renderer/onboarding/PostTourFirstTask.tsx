/**
 * Tutorial-X5 — Post-tour first-task proposal card.
 *
 * Mounts unconditionally inside `App.tsx` but stays invisible until:
 *   (a) the SpotlightTour has fired a `complete` event (or the user
 *       dismissed it after the final step), AND
 *   (b) at least one installed plugin has a registered first-task
 *       proposal in `first-task-proposals.ts`.
 *
 * UX contract:
 *   - The card is a non-modal floating banner anchored bottom-right so
 *     the user can dismiss + continue chatting at any time. No backdrop.
 *   - The CTA pre-fills the chat composer via `api.composerSeedText` (or
 *     a fallback IPC) — the user explicitly presses Send. This keeps
 *     the tool-approval contract intact: LVIS never auto-invokes a
 *     plugin tool on behalf of the user during onboarding.
 *   - After dismissal (CTA accepted *or* "나중에"), the proposal is
 *     not re-shown for the rest of the session. The component tracks
 *     this in local state; a persisted flag is not needed because the
 *     proposal only applies to first-boot.
 *
 * Data sources:
 *   - `installedPluginIds` is passed in from App.tsx via the existing
 *     plugin runtime list (no new IPC) so the component is purely
 *     presentational.
 *   - `composerSeedText(text)` is the host's existing composer-set IPC;
 *     when not present (legacy/stub api), the card falls back to
 *     `navigator.clipboard.writeText` + a "텍스트 복사됨" microcopy so
 *     the user can paste it manually rather than getting stuck.
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../../lib/utils.js";
import {
  pickFirstTaskProposal,
  type FirstTaskProposal,
} from "./first-task-proposals.js";

export interface PostTourFirstTaskApi {
  /**
   * Pre-fill the chat composer with the given text. When undefined the
   * card uses the clipboard fallback. The host's existing
   * `chat.setComposerDraft` IPC is the canonical implementation.
   */
  composerSeedText?: (text: string) => Promise<{ ok: boolean }> | void;
}

export interface PostTourFirstTaskProps {
  api: PostTourFirstTaskApi;
  /** Plugin ids that are currently installed (marketplace slugs). */
  installedPluginIds: readonly string[];
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
  api,
  installedPluginIds,
  tourCompleted,
  disabled,
}: PostTourFirstTaskProps) {
  const [dismissed, setDismissed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [proposal, setProposal] = useState<FirstTaskProposal | null>(null);

  useEffect(() => {
    if (disabled || !tourCompleted || dismissed) {
      setProposal(null);
      return;
    }
    setProposal(pickFirstTaskProposal(installedPluginIds));
  }, [disabled, tourCompleted, dismissed, installedPluginIds]);

  const onAccept = useCallback(async () => {
    if (!proposal) return;
    setAccepted(true);
    if (typeof api.composerSeedText === "function") {
      try {
        await api.composerSeedText(proposal.composerSeed);
      } catch {
        // Composer-set IPC failure is non-fatal; user still sees the card.
      }
    } else if (
      typeof navigator !== "undefined" &&
      navigator.clipboard?.writeText
    ) {
      try {
        await navigator.clipboard.writeText(proposal.composerSeed);
      } catch {
        /* clipboard write rejection is benign */
      }
    }
    setDismissed(true);
  }, [api, proposal]);

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
        "w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-4 shadow-2xl",
        "border-[hsl(var(--p-purple-500)/0.4)]",
      )}
      role="dialog"
      aria-label="LVIS 첫 작업 제안"
    >
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: "hsl(var(--p-purple-500))" }}
      >
        ✨ 첫 작업 제안
      </div>
      <h3 className="mt-1 text-[14px] font-semibold leading-tight">
        {proposal.headlineKo}
      </h3>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
        {proposal.bodyKo}
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="post-tour-first-task:skip"
          onClick={onSkip}
          className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
        >
          나중에
        </button>
        <button
          type="button"
          data-testid="post-tour-first-task:accept"
          onClick={() => void onAccept()}
          disabled={accepted}
          className={cn(
            "rounded-md px-3 py-1 text-[11px] font-medium text-primary-foreground transition",
            "bg-primary hover:opacity-90 disabled:opacity-60",
          )}
        >
          {accepted ? "보냈습니다 ✓" : proposal.ctaKo}
        </button>
      </div>
      {typeof api.composerSeedText !== "function" && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          ↑ 채팅 입력창에 메시지가 복사됩니다.
        </p>
      )}
    </div>
  );
}
