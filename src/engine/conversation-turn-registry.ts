/**
 * Live public-turn ownership for the one mutable conversation runtime.
 *
 * A durable receipt protects admission/replay across restarts. This registry is
 * deliberately process-local: it owns the sole AbortController that can stop a
 * live remote turn, proves exact actor/share ownership, and never attempts to
 * revive a model call after a process restart.
 */

type ConversationTurnCancelResult =
  | "cancel-requested"
  | "not-active"
  | "not-owner";

export interface ConversationPublicTurnControl {
  /** Opaque host-minted identifier; never a persisted session or stream id. */
  readonly turnId: string;
  /** Exact host-minted actor plus share-binding key, never sent over the wire. */
  readonly actorId: string;
  /** The only cancellation capability for this live turn. */
  readonly abortController: AbortController;
  /** Re-evaluates the backing paired-share binding after a durable change. */
  readonly isCurrent: () => boolean;
}

interface ConversationTurnRegistration {
  /** Remove the entry once the accepted turn reaches any terminal outcome. */
  complete(): void;
}

export interface ConversationTurnRegistry {
  /**
   * Register the one currently cancellable public turn. The shared activity
   * coordinator still owns execution exclusivity; this only adds ownership.
   */
  register(control: ConversationPublicTurnControl): ConversationTurnRegistration | null;
  /** Request cancellation only for the caller's currently-live public turn. */
  cancelOwned(actorId: string, turnId: string): ConversationTurnCancelResult;
  /** Abort the live entry only if a durable paired-share guard became stale. */
  invalidateStale(): void;
  /** Read-only test/lifecycle visibility; it never exposes actor identity. */
  hasActiveTurn(turnId: string): boolean;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly actorId: string;
  readonly abortController: AbortController;
  readonly isCurrent: () => boolean;
  cancelled: boolean;
}

/** Create the in-memory companion to the durable remote ownership store. */
export function createConversationTurnRegistry(): ConversationTurnRegistry {
  let active: ActiveTurn | null = null;

  const requestAbort = (entry: ActiveTurn, reason: string): void => {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.abortController.abort(new Error(reason));
  };

  const register = (control: ConversationPublicTurnControl): ConversationTurnRegistration | null => {
    if (!isValidControl(control) || active !== null) return null;
    const entry: ActiveTurn = {
      turnId: control.turnId,
      actorId: control.actorId,
      abortController: control.abortController,
      isCurrent: control.isCurrent,
      cancelled: false,
    };
    active = entry;
    let completed = false;
    return Object.freeze({
      complete(): void {
        if (completed) return;
        completed = true;
        if (active === entry) active = null;
      },
    });
  };

  return Object.freeze({
    register,
    cancelOwned(actorId: string, turnId: string): ConversationTurnCancelResult {
      const entry = active;
      if (entry === null || entry.turnId !== turnId) return "not-active";
      if (entry.actorId !== actorId) return "not-owner";
      requestAbort(entry, "remote owner cancelled turn");
      return "cancel-requested";
    },
    invalidateStale(): void {
      const entry = active;
      if (entry === null) return;
      let current = false;
      try {
        current = entry.isCurrent() === true;
      } catch {
        current = false;
      }
      if (!current) requestAbort(entry, "remote paired share revoked");
    },
    hasActiveTurn(turnId: string): boolean {
      return active?.turnId === turnId;
    },
  });
}

function isValidControl(value: ConversationPublicTurnControl): boolean {
  return typeof value.turnId === "string"
    && value.turnId.length > 0
    && value.turnId.length <= 256
    && typeof value.actorId === "string"
    && value.actorId.length > 0
    && value.actorId.length <= 512
    && value.abortController instanceof AbortController
    && typeof value.isCurrent === "function";
}
