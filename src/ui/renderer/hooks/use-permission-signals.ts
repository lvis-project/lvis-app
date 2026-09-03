import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi } from "../api-client.js";
import { DEFAULT_TOAST_TTL_MS } from "../constants.js";
import type {
  PermissionReviewSuggestionPayload,
  PermissionReviewSuggestionReason,
  UserApprovalHitPayload,
} from "../../../shared/permissions-events.js";
import { errorMessage } from "../../../shared/error-message.js";

/**
 * The reviewer suggestion as an approval card draws it: why the host raised
 * it, the state of the single action it offers, and the two ways out of it.
 *
 * The card is per-request and the suggestion is an aggregate over a window of
 * requests, so the value is built here — one per window — and every dock reads
 * the same one rather than each card deriving its own.
 */
export interface ReviewerSuggestion {
  reason: PermissionReviewSuggestionReason;
  /** Approvals inside the host's window, for the "N approvals in M min" line. */
  allowCount: number;
  /** The host's window, in ms; the band states it in minutes. */
  windowMs: number;
  /** The enable action is in flight — the band's button waits on it. */
  busy: boolean;
  /** What the last enable attempt failed with; the band shows it inline. */
  error?: string;
  onEnable: () => void;
  onDismiss: () => void;
}

type ReviewSuggestionState =
  | (PermissionReviewSuggestionPayload & { busy: boolean; error?: string })
  | null;

export interface UsePermissionSignalsResult {
  userApprovalHitToast: UserApprovalHitPayload | null;
  reviewerSuggestion: ReviewerSuggestion | null;
}

/**
 * Owns the two IPC-driven permission disclosures the window subscribes once:
 *   • user-approval memory-hit — a toast, auto-dismissed after
 *     DEFAULT_TOAST_TTL_MS, because it reports something that already happened.
 *   • reviewer suggestion — held state, drawn as a band inside whichever
 *     approval card is up, with an "enable" action that flips the reviewer
 *     into LLM/interactive/auto mode.
 *
 * The suggestion carries no display timer. Its surface is an approval card, and
 * a card may not be on screen when the host raises it: a timer would expire the
 * suggestion in that gap and spend the tracker's whole cooldown on a band
 * nobody saw. It ends when the user acts on it — enable or dismiss — and the
 * main-side tracker's cooldown is what bounds how often it can come back.
 *
 * Both subscriptions include defense-in-depth payload validation (the IPC type
 * is a compile-time-only guarantee).
 */
export function usePermissionSignals(): UsePermissionSignalsResult {
  const [userApprovalHitToast, setUserApprovalHitToast] = useState<
    UserApprovalHitPayload | null
  >(null);
  const userApprovalHitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [reviewSuggestion, setReviewSuggestion] =
    useState<ReviewSuggestionState>(null);

  // Subscribe to user-approval-hit broadcasts. Returned closure both
  // unsubscribes the IPC listener and cancels any in-flight dismiss timer.
  // Defense-in-depth structural validation of the
  // IPC payload — TS type guarantees only compile-time; a future bug in
  // permission-manager emitting `null` / `""` / `"critical"` would otherwise
  // propagate to `.toUpperCase()` (throws) or render unexpected text.
  useEffect(() => {
    let api;
    try {
      api = getApi();
    } catch {
      return;
    }
    const unsubscribe = api.permission.onUserApprovalHit((payload) => {
      if (
        !payload ||
        typeof payload.toolName !== "string" ||
        payload.toolName.length === 0 ||
        (payload.scope !== "session" && payload.scope !== "persistent") ||
        (payload.verdictAtApproval !== "low" &&
          payload.verdictAtApproval !== "medium" &&
          payload.verdictAtApproval !== "high")
      ) {
        console.warn(
          "[chat] dropping malformed userApprovalHit payload — see permissions-events.ts SOT",
          payload,
        );
        return;
      }
      if (userApprovalHitTimerRef.current) {
        clearTimeout(userApprovalHitTimerRef.current);
      }
      setUserApprovalHitToast(payload);
      userApprovalHitTimerRef.current = setTimeout(() => {
        setUserApprovalHitToast(null);
      }, DEFAULT_TOAST_TTL_MS);
    });
    return () => {
      unsubscribe();
      if (userApprovalHitTimerRef.current) {
        clearTimeout(userApprovalHitTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let api;
    try {
      api = getApi();
    } catch {
      return;
    }
    const unsubscribe = api.permission.onReviewSuggestion?.((payload) => {
      if (
        !payload ||
        (payload.reason !== "allow-always" && payload.reason !== "repeat-allow") ||
        typeof payload.allowCount !== "number" ||
        typeof payload.allowAlwaysCount !== "number" ||
        typeof payload.threshold !== "number" ||
        typeof payload.windowMs !== "number"
      ) {
        console.warn("[chat] dropping malformed permission review suggestion payload", payload);
        return;
      }
      const numericFieldsValid =
        Number.isFinite(payload.allowCount) &&
        Number.isFinite(payload.allowAlwaysCount) &&
        Number.isFinite(payload.threshold) &&
        Number.isFinite(payload.windowMs) &&
        payload.allowCount >= 0 &&
        payload.allowAlwaysCount >= 0 &&
        payload.threshold > 0 &&
        payload.windowMs > 0 &&
        payload.windowMs <= 24 * 60 * 60 * 1000;
      if (!numericFieldsValid) {
        console.warn("[chat] dropping malformed permission review suggestion payload", payload);
        return;
      }
      setReviewSuggestion({ ...payload, busy: false });
    });
    if (!unsubscribe) return;
    return unsubscribe;
  }, []);

  const enableReviewSuggestion = useCallback(async () => {
    setReviewSuggestion((current) =>
      current ? { ...current, busy: true, error: undefined } : current,
    );
    try {
      const api = getApi();
      const reviewerResult = await api.permission.reviewerDispatch("mode llm");
      if (!reviewerResult?.ok) {
        throw new Error(reviewerResult?.error ?? "reviewer mode change failed");
      }
      const interactiveResult = await api.permission.reviewerDispatch("interactive low");
      if (!interactiveResult?.ok) {
        throw new Error(interactiveResult?.error ?? "interactive reviewer change failed");
      }
      const modeResult = await api.permission.setMode("auto");
      if (!modeResult?.ok) {
        throw new Error(modeResult?.message ?? modeResult?.error ?? "mode change failed");
      }
      setReviewSuggestion(null);
    } catch (err) {
      setReviewSuggestion((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: errorMessage(err),
            }
          : current,
      );
    }
  }, []);

  // Dismiss clears the held suggestion here and tells the main process nothing:
  // the tracker's own cooldown already decides when the next one may be raised,
  // so the band cannot come straight back on the following card.
  const dismissReviewSuggestion = useCallback(() => {
    setReviewSuggestion(null);
  }, []);

  const reviewerSuggestion = useMemo<ReviewerSuggestion | null>(
    () =>
      reviewSuggestion
        ? {
            reason: reviewSuggestion.reason,
            allowCount: reviewSuggestion.allowCount,
            windowMs: reviewSuggestion.windowMs,
            busy: reviewSuggestion.busy,
            ...(reviewSuggestion.error === undefined
              ? {}
              : { error: reviewSuggestion.error }),
            onEnable: () => void enableReviewSuggestion(),
            onDismiss: dismissReviewSuggestion,
          }
        : null,
    [reviewSuggestion, enableReviewSuggestion, dismissReviewSuggestion],
  );

  return {
    userApprovalHitToast,
    reviewerSuggestion,
  };
}
