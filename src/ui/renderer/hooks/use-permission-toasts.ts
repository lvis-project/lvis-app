import { useCallback, useEffect, useRef, useState } from "react";
import { getApi } from "../api-client.js";
import { DEFAULT_TOAST_TTL_MS, LONG_TOAST_TTL_MS } from "../constants.js";
import type {
  PermissionReviewSuggestionPayload,
  UserApprovalHitPayload,
} from "../../../shared/permissions-events.js";

export type PermissionReviewSuggestionState =
  (PermissionReviewSuggestionPayload & { busy?: boolean; error?: string }) | null;

export interface UsePermissionToastsResult {
  userApprovalHitToast: UserApprovalHitPayload | null;
  permissionReviewSuggestion: PermissionReviewSuggestionState;
  handleEnablePermissionReviewSuggestion: () => Promise<void>;
}

/**
 * Owns the two IPC-driven permission disclosure toasts:
 *   • user-approval memory-hit (#793) — auto-dismiss after DEFAULT_TOAST_TTL_MS.
 *   • permission review suggestion — auto-dismiss after LONG_TOAST_TTL_MS, with
 *     an "enable" action that flips the reviewer into LLM/interactive/auto mode.
 *
 * Both subscriptions include defense-in-depth payload validation (the IPC type
 * is a compile-time-only guarantee).
 */
export function usePermissionToasts(): UsePermissionToastsResult {
  const [userApprovalHitToast, setUserApprovalHitToast] = useState<
    UserApprovalHitPayload | null
  >(null);
  const userApprovalHitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [permissionReviewSuggestion, setPermissionReviewSuggestion] =
    useState<PermissionReviewSuggestionState>(null);
  const permissionReviewSuggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Subscribe to user-approval-hit broadcasts. Returned closure both
  // unsubscribes the IPC listener and cancels any in-flight dismiss timer.
  // Cluster review S-Med-2: defense-in-depth structural validation of the
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
      if (permissionReviewSuggestionTimerRef.current) {
        clearTimeout(permissionReviewSuggestionTimerRef.current);
      }
      setPermissionReviewSuggestion(payload);
      permissionReviewSuggestionTimerRef.current = setTimeout(() => {
        setPermissionReviewSuggestion(null);
      }, LONG_TOAST_TTL_MS);
    });
    if (!unsubscribe) return;
    return () => {
      unsubscribe();
      if (permissionReviewSuggestionTimerRef.current) {
        clearTimeout(permissionReviewSuggestionTimerRef.current);
      }
    };
  }, []);

  const handleEnablePermissionReviewSuggestion = useCallback(async () => {
    if (permissionReviewSuggestionTimerRef.current) {
      clearTimeout(permissionReviewSuggestionTimerRef.current);
      permissionReviewSuggestionTimerRef.current = null;
    }
    setPermissionReviewSuggestion((current) =>
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
      setPermissionReviewSuggestion(null);
    } catch (err) {
      setPermissionReviewSuggestion((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  }, []);

  return {
    userApprovalHitToast,
    permissionReviewSuggestion,
    handleEnablePermissionReviewSuggestion,
  };
}
