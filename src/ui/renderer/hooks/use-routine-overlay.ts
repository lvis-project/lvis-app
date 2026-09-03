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
import { errorMessage } from "../../../shared/error-message.js";
import { parseSettingsPath, type SettingsPath } from "../../../shared/settings-tabs.js";
import type { OnboardingProposalDisposition } from "../../../main/onboarding-proposal-store.js";

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
  handleProposalAnswer: (
    overlayItemId: string,
    disposition: OnboardingProposalDisposition,
    chatGroupId: string,
  ) => Promise<void>;
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
  locale,
  registry,
  focusedChatGroupId,
  onNavigateToSettings,
}: {
  api: Api;
  t: TranslateFn;
  /** The locale an accepted proposal's follow-up list is resolved in. */
  locale: string;
  registry: ChatGroupSessionRegistry;
  /** The tile a card with no origin conversation is pinned to on arrival. */
  focusedChatGroupId: string;
  /**
   * Move the settings view onto a destination. A proposal's `settings` action
   * names a tab and optionally a section within it, and the window owns
   * navigation, so it supplies the move.
   */
  onNavigateToSettings: (path: SettingsPath) => void;
}): UseRoutineOverlayResult {
  // runningRoutines tracks in-flight LLM sessions.
  const [runningRoutines, setRunningRoutines] = useState<Set<string>>(new Set());

  // addFire ref is populated by OverlayContextProvider during render
  // so the IPC subscription below can call it without prop-drilling
  const addFireRef = useRef<OverlayContextValue["addFire"] | null>(null);

  // Read through a ref so a focus change does not tear down the IPC
  // subscriptions below, which would drop cards mid-flight.
  const focusedChatGroupIdRef = useRef(focusedChatGroupId);
  focusedChatGroupIdRef.current = focusedChatGroupId;

  /**
   * Every card enters the queue here so the pin is stamped in ONE place. A card
   * that names its origin conversation needs no pin — the tile holding that
   * session draws it. A card without one is pinned to the focused tile now,
   * rather than resolved against focus at paint time; see `overlayCardTile`.
   */
  const pushCard = useCallback((item: OverlayItem): OverlayItem => {
    const pinned = item.originSessionId === undefined
      ? { ...item, adoptedChatGroupId: focusedChatGroupIdRef.current }
      : item;
    addFireRef.current?.(pinned);
    return pinned;
  }, []);
  const pushRoutineResult = useCallback((evt: RoutineFiredPayload) => {
    pushCard({
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
      pushCard({
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
      pushCard({
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
        console.warn("[lvis] listPendingRoutineResults failed:", errorMessage(err));
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
      // The queue and this lookup hold the SAME object: the handler below reads
      // the map, and a card whose pin lived only in the queue would be acted on
      // without it.
      overlayItemsRef.current.set(item.id, pushCard(item));
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
      // Only the two INSERTION sources reach this handler. A routine has its own
      // primary action, and a proposal answers rather than inserts — see
      // `handleProposalAnswer`.
      if (source.kind !== "plugin" && source.kind !== "app") return;
      if (!pendingPrompt) return;

      // Resolved from the card's ORIGIN, not from the surface that rendered
      // it. The two agree whenever the origin conversation is open — that is
      // how the card got there — but the tile can close between the paint and
      // the click, and inserting into the caller's tile then would put a
      // prompt staged for one conversation into another. A card with no origin
      // has no conversation to contradict, so the group the caller named (a
      // tile's own, or the focused one for the window's region) stands.
      const targetGroupId = item.originSessionId === undefined
        ? item.adoptedChatGroupId ?? chatGroupId
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
        console.warn("[lvis] acknowledgeRoutineResult failed:", errorMessage(err));
      });
    },
    [api],
  );

  // The user's answer to an onboarding proposal. Accepting performs the action
  // the manifest declared — and only that: text into a composer, or the
  // settings view onto the section that holds the option. Nothing here starts
  // a turn, which is why a proposal never travels the `imported_trigger` path
  // the insertion cards use.
  //
  // The answer is recorded whichever way it went, including "accepted": all
  // three are final for this launch, and two of them are final for good. The
  // host's reply re-stages whatever is still unanswered, so the next question
  // arrives only after this one has one.
  const handleProposalAnswer = useCallback(
    async (
      overlayItemId: string,
      disposition: OnboardingProposalDisposition,
      chatGroupId: string,
    ) => {
      const item = overlayItemsRef.current.get(overlayItemId);
      if (!item || item.source.kind !== "proposal") return;
      const { pluginId, proposalId, action } = item.source;
      overlayItemsRef.current.delete(overlayItemId);

      if (disposition === "accepted") {
        if (action.kind === "composer") {
          // The tile the card was pinned to, for the same reason an insertion
          // card inserts there: focus can move between the paint and the click.
          const tile = registry.read(item.adoptedChatGroupId ?? chatGroupId);
          if (tile) tile.prefillComposer(action.prompt);
        } else if (action.kind === "settings") {
          // Fail-closed rather than landing on the default tab: manifest
          // validation already rejected a path this build cannot reach, so a
          // null here means the declared destination is gone, and sending the
          // user somewhere else would answer their "yes" with the wrong page.
          const path = parseSettingsPath(action.path);
          if (path) onNavigateToSettings(path);
        }
      }

      try {
        await api.onboarding.answer(`${pluginId}:${proposalId}`, disposition, locale);
      } catch (err) {
        console.warn("[lvis] onboarding proposal answer failed:", errorMessage(err));
      }
    },
    [api, locale, onNavigateToSettings, registry],
  );

  return {
    addFireRef,
    runningRoutines,
    handlePluginPrimaryAction,
    handleRoutineAcknowledge,
    handleProposalAnswer,
  };
}
