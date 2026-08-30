import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { getApi } from "../api-client.js";
import type { RoutineFiredPayload } from "../../../shared/routines-types.js";
import type {
  OverlayContextValue,
  OverlayItem,
} from "../context/OverlayContext.js";
import {
  tileHoldingSession,
  type ChatGroupSessionRegistry,
} from "../components/chat-group-session-registry.js";
import type { TranslateFn } from "../../../i18n/translate.js";

type Api = ReturnType<typeof getApi>;

export interface UseRoutineOverlayResult {
  /**
   * Populated by OverlayContextProvider DURING its render so the routine/overlay
   * IPC subscriptions here can call addFire() from outside the React tree. App
   * threads this straight into OverlayContextProvider.
   */
  addFireRef: MutableRefObject<OverlayContextValue["addFire"] | null>;
  /** In-flight LLM routine sessions; OverlayContextProvider derives running flags. */
  runningRoutines: Set<string>;
  handlePluginPrimaryAction: (overlayItemId: string, chatGroupId: string) => Promise<void>;
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
 * `handlePluginPrimaryAction` reaches a conversation through the tile registry
 * rather than a captured callback: the card is shown in ONE tile, and the turn
 * it starts belongs to that tile's conversation, which the window cannot know
 * at subscribe time.
 */
export function useRoutineOverlay({
  api,
  t,
  registry,
}: {
  api: Api;
  t: TranslateFn;
  registry: ChatGroupSessionRegistry;
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
      createdAt: evt.firedAt,
      routineSessionId: evt.routineSessionId,
    });
  }, []);

  // Single subscription for routine IPC events. runningStarted pushes a
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
        createdAt: firedAt,
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
    const unsubFailed = api.onRoutineFailed((evt) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(evt.routineId);
        return next;
      });
      const failedAt = new Date().toISOString();
      addFireRef.current?.({
        id: `${evt.routineId}-running`,
        source: { kind: "routine", routineId: evt.routineId, firedAt: failedAt },
        title: t("app.routineFailedTitle"),
        summary: t("app.routineFailedSummary", { error: evt.error }),
        running: false,
        createdAt: failedAt,
      });
    });

    void (async () => {
      try {
        const pending = await api.listPendingRoutineResults();
        for (const result of pending) pushRoutineResult(result);
      } catch (err) {
        console.warn("[lvis] listPendingRoutineResults failed:", (err as Error).message);
      }
    })();

    // Fired payload uses explicit allowlist fields only (no ...routine spread)
    const unsubFired = api.onRoutineFired(pushRoutineResult);

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

  // Insertion-overlay primary action handler (user confirm → main chat insert).
  // Called from OverlayCardRegion with the OverlayItem.id after OverlayContext.dismiss()
  // has already removed the item from the queue. overlayItemsRef still holds it.
  //
  // Two staged sources land here, and BOTH are non-user-authored: a plugin overlay
  // trigger and an MCP App's `ui/message` that arrived with no turn in flight. The
  // click is the gate — neither may start a turn on its own. They differ only in
  // provenance, which rides the envelope already inside `pendingPrompt` and the send
  // mode (→ `plugin-emitted` / `app-emitted` trust origin in main).
  const handlePluginPrimaryAction = useCallback(
    async (overlayItemId: string, chatGroupId: string) => {
      const item = overlayItemsRef.current.get(overlayItemId);
      if (!item) return;

      const { source, pendingPrompt, summary } = item;
      if (source.kind === "routine" || !pendingPrompt) return;

      // Resolved from the card's ORIGIN, not from the surface that rendered
      // it. The two agree whenever the origin conversation is open — that is
      // how the card got there — but the tile can close between the paint and
      // the click, and inserting into the caller's tile then would put a
      // prompt staged for one conversation into another. A card with no origin
      // has no conversation to contradict, so the group the caller named (a
      // tile's own, or the focused one for the window's region) stands.
      const targetGroupId = item.originSessionId === undefined
        ? chatGroupId
        : tileHoldingSession(registry.readTiles(), item.originSessionId)?.chatGroupId;
      const tile = targetGroupId === undefined ? undefined : registry.read(targetGroupId);
      if (!tile) {
        console.warn("[lvis] overlay confirm dropped: origin conversation is no longer open");
        return;
      }

      // Clean up lookup ref
      overlayItemsRef.current.delete(overlayItemId);

      // Insert as imported_trigger entry — staged provenance preserved, NOT a plain
      // user bubble (architecture §9 plugin provenance contract; same rule for apps).
      tile.insertImportedTriggerEntry({
        sessionId: source.eventId,
        source: source.kind === "plugin" ? `plugin:${source.pluginId}` : `app:${source.serverId}`,
        prompt: pendingPrompt,
        summary,
      });

      // Start THAT tile's turn (user-in-the-loop confirm → auto-process). Both
      // modes skip the user-bubble append since the imported_trigger marker
      // already represents the staged prompt.
      void tile.ask(
        pendingPrompt,
        source.kind === "plugin" ? "trigger-import" : "app-message",
      );
    },
    [registry],
  );

  const handleRoutineAcknowledge = useCallback(
    (routineId: string, firedAt: string) => {
      void api.acknowledgeRoutineResult(routineId, firedAt).catch((err) => {
        console.warn("[lvis] acknowledgeRoutineResult failed:", (err as Error).message);
      });
    },
    [api],
  );

  return { addFireRef, runningRoutines, handlePluginPrimaryAction, handleRoutineAcknowledge };
}
