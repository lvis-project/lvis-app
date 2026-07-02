import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { getApi } from "../api-client.js";
import type { useTranslation } from "../../../i18n/react.js";
import type { RoutineFiredPayload } from "../../../shared/routines-types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type {
  OverlayContextValue,
  OverlayItem,
} from "../context/OverlayContext.js";
import type { useChatState } from "./use-chat-state.js";

type Api = ReturnType<typeof getApi>;
type TFn = ReturnType<typeof useTranslation>["t"];
type InsertImportedTriggerEntry = ReturnType<typeof useChatState>["insertImportedTriggerEntry"];

/**
 * handleAsk ref signature — the forward-ref cycle bridge. App owns this ref;
 * use-send-message writes it (`ref.current = handleAsk`) and this hook reads it
 * (`ref.current(prompt, "trigger-import")`) from handlePluginPrimaryAction. The
 * ref only surfaces the first three params (the overlay-import call site never
 * passes the 4th `opts`), matching App's original declaration exactly.
 */
export type HandleAskRefFn = (
  q: string,
  mode?: "default" | "trigger-import",
  userIntent?: UserKeyboardIntentSnapshot,
) => Promise<void>;

export interface UseRoutineOverlayResult {
  /**
   * Populated by OverlayContextProvider DURING its render so the routine/overlay
   * IPC subscriptions here can call addFire() from outside the React tree. App
   * threads this straight into AppProviders → OverlayContextProvider.
   */
  addFireRef: MutableRefObject<OverlayContextValue["addFire"] | null>;
  /** In-flight LLM routine sessions; OverlayContextProvider derives running flags. */
  runningRoutines: Set<string>;
  handlePluginPrimaryAction: (overlayItemId: string) => Promise<void>;
  handleRoutineAcknowledge: (routineId: string, firedAt: string) => void;
}

/**
 * Routine + plugin-overlay IPC ownership, extracted verbatim from App.tsx.
 *
 * Owns the routine-fire overlay pipeline: `runningRoutines`, the `addFireRef`
 * surfaced to OverlayContextProvider, the `overlayItemsRef` lookup map, and the
 * two IPC subscription effects (routine running/finished/failed/fired + pending
 * drain; plugin overlay show/dismiss). Also owns the two overlay action
 * callbacks.
 *
 * Forward-ref cycle: `handlePluginPrimaryAction` calls `handleAskRef.current(...)`
 * to start a trigger-import turn. The ref is owned by App and written by
 * use-send-message, so the cycle is preserved through the shared ref rather than
 * an inline forward declaration.
 */
export function useRoutineOverlay({
  api,
  t,
  insertImportedTriggerEntry,
  handleAskRef,
}: {
  api: Api;
  t: TFn;
  insertImportedTriggerEntry: InsertImportedTriggerEntry;
  handleAskRef: MutableRefObject<HandleAskRefFn>;
}): UseRoutineOverlayResult {
  // runningRoutines tracks in-flight LLM sessions.
  const [runningRoutines, setRunningRoutines] = useState<Set<string>>(new Set());

  // addFire ref is populated by OverlayContextProvider during render
  // so the IPC subscription below can call it without prop-drilling
  const addFireRef = useRef<OverlayContextValue["addFire"] | null>(null);
  const pushRoutineResult = useCallback((evt: RoutineFiredPayload) => {
    addFireRef.current?.({
      id: `${evt.id}-${evt.firedAt}`,
      source: { kind: "routine", routineId: evt.id, firedAt: evt.firedAt },
      title: evt.title,
      summary: evt.summary,
      running: false,
      routineSessionId: evt.routineSessionId,
    });
  }, []);

  // C1+M4: single subscription for routine IPC events. runningStarted pushes a
  // running OverlayItem immediately (running:true); fired replaces it with the
  // completed item (running:false + summary). runningRoutines Set is kept in
  // sync for OverlayContextProvider to derive running flags on queue items.
  useEffect(() => {
    const unsubStarted = api.onRoutineRunningStarted((payload) => {
      const { routineId, firedAt, title } = payload;
      setRunningRoutines((prev) => new Set([...prev, routineId]));
      addFireRef.current?.({
        id: `${routineId}-running`,
        source: { kind: "routine", routineId, firedAt },
        title,
        summary: "",
        running: true,
      });
    });

    const unsubFinished = api.onRoutineRunningFinished((routineId) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(routineId);
        return next;
      });
    });

    // Major fix: clears running:true stuck OverlayItem when LLM session fails.
    // Uses the same stale-replace path as fired so the running OverlayItem
    // transitions to a visible error summary instead of staying spinning.
    const unsubFailed = api.onRoutineFailedV2((evt) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(evt.routineId);
        return next;
      });
      addFireRef.current?.({
        id: `${evt.routineId}-running`,
        source: { kind: "routine", routineId: evt.routineId, firedAt: new Date().toISOString() },
        title: t("app.routineFailedTitle"),
        summary: t("app.routineFailedSummary", { error: evt.error }),
        running: false,
      });
    });

    void (async () => {
      try {
        const pending = await api.listPendingRoutineResultsV2();
        for (const result of pending) pushRoutineResult(result);
      } catch (err) {
        console.warn("[lvis] listPendingRoutineResults failed:", (err as Error).message);
      }
    })();

    // M1: fired payload uses explicit allowlist fields only (no ...routine spread)
    const unsubFired = api.onRoutineFiredV2(pushRoutineResult);

    return () => { unsubStarted(); unsubFinished(); unsubFailed(); unsubFired(); };
  }, [api, pushRoutineResult, t]);

  // Overlay items ref tracks all items pushed via onOverlayShow so
  // handlePluginPrimaryAction can look up pendingPrompt by id without needing
  // to reach into OverlayContext (App.tsx is the parent of OverlayContextProvider).
  const overlayItemsRef = useRef<Map<string, OverlayItem>>(new Map());

  // Overlay IPC subscriptions: main pushes plugin OverlayItems via OVERLAY_V1.show.
  useEffect(() => {
    if (typeof api.onOverlayShow !== "function") return;
    const unsubShow = api.onOverlayShow((item) => {
      // Populate lookup ref so handlePluginPrimaryAction can find the item
      overlayItemsRef.current.set(item.id, item);
      addFireRef.current?.(item);
    });
    const unsubDismiss = typeof api.onOverlayDismiss === "function"
      ? api.onOverlayDismiss((id) => {
          overlayItemsRef.current.delete(id);
        })
      : () => {};
    return () => { unsubShow(); unsubDismiss(); };
  }, [api]);

  // Plugin overlay primary action handler (user confirm → main chat insert).
  // Called from OverlayCardRegion with the OverlayItem.id after OverlayContext.dismiss()
  // has already removed the item from the queue. overlayItemsRef still holds it.
  const handlePluginPrimaryAction = useCallback(
    async (overlayItemId: string) => {
      const item = overlayItemsRef.current.get(overlayItemId);
      if (!item) return;

      const { source, pendingPrompt, summary, title } = item;
      if (source.kind !== "plugin" || !pendingPrompt) return;

      // Clean up lookup ref
      overlayItemsRef.current.delete(overlayItemId);

      // Insert as imported_trigger entry — overlay trigger provenance preserved,
      // NOT a plain user bubble (architecture §9 plugin provenance contract)
      insertImportedTriggerEntry({
        sessionId: source.eventId,
        pluginId: source.pluginId,
        prompt: pendingPrompt,
        summary,
        title,
      });

      // Start the main ConversationLoop turn immediately (user-in-the-loop
      // confirm → auto-process). trigger-import mode skips the user-bubble
      // append since the imported_trigger marker already represents the prompt.
      void handleAskRef.current(pendingPrompt, "trigger-import");
    },
    [insertImportedTriggerEntry, handleAskRef],
  );

  const handleRoutineAcknowledge = useCallback(
    (routineId: string, firedAt: string) => {
      void api.acknowledgeRoutineResultV2(routineId, firedAt).catch((err) => {
        console.warn("[lvis] acknowledgeRoutineResult failed:", (err as Error).message);
      });
    },
    [api],
  );

  return { addFireRef, runningRoutines, handlePluginPrimaryAction, handleRoutineAcknowledge };
}
