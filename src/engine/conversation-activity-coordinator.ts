/**
 * Main-conversation execution coordinator.
 *
 * The current host owns one mutable main ConversationLoop. Every surface
 * therefore has to acquire the same turn or session-mutation lease before it
 * touches that loop. This deliberately stays transport-neutral: Electron,
 * loopback API, a future CLI, and a future remote adapter can all use the same
 * coordinator without gaining a second execution path.
 *
 * Per-session actors are a later evolution once the host owns independent
 * ConversationLoop instances. Until then, a process-wide coordinator is the
 * honest representation of the runtime's concurrency model.
 */

export interface ConversationActivityCoordinator {
  /** Allocate a process-wide stream correlation id for legacy render adapters. */
  allocateStreamId(): number;
  /** True while the active main ConversationLoop cannot be mutated safely. */
  isBusy(): boolean;
  /** The current turn lease, when one exists. */
  activeTurn(): Promise<unknown> | null;
  /** The current session-mutation lease, when one exists. */
  activeMutation(): Promise<unknown> | null;
  /**
   * Acquire the exclusive turn lease before running `factory`.
   *
   * The factory is deferred so the lease is observable before any synchronous
   * work can re-enter the runtime.
   */
  trackTurn<T>(factory: () => Promise<T>): Promise<T>;
  /**
   * Try to acquire the exclusive turn lease without synthesizing a rejected
   * promise. Command handlers that must change state before starting a turn use
   * this to fail before mutating state.
   */
  tryTrackTurn<T>(factory: () => Promise<T>): Promise<T> | null;
  /**
   * Acquire the exclusive session-mutation lease, or return null when a turn
   * or another mutation already owns the main conversation.
   */
  trackMutation<T>(factory: () => Promise<T>): Promise<T> | null;
}

/**
 * Build the v1 coordinator shared by every adapter for the active main
 * conversation. `busyError` preserves the existing IPC/public API error
 * contract while keeping the coordinator itself independent of a transport.
 */
export function createConversationActivityCoordinator(
  busyError = "streaming-active",
): ConversationActivityCoordinator {
  let nextStreamId = 0;
  let activeTurn: Promise<unknown> | null = null;
  let activeMutation: Promise<unknown> | null = null;

  const isBusy = () => activeTurn !== null || activeMutation !== null;

  const allocateStreamId = () => {
    if (nextStreamId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("stream-id-exhausted");
    }
    nextStreamId += 1;
    return nextStreamId;
  };

  const tryTrackTurn = <T>(factory: () => Promise<T>): Promise<T> | null => {
    if (isBusy()) return null;
    const lease = Promise.resolve().then(factory).finally(() => {
      if (activeTurn === lease) activeTurn = null;
    });
    activeTurn = lease;
    return lease;
  };

  const trackTurn = <T>(factory: () => Promise<T>): Promise<T> =>
    tryTrackTurn(factory) ?? Promise.reject(new Error(busyError));

  const trackMutation = <T>(factory: () => Promise<T>): Promise<T> | null => {
    if (isBusy()) return null;
    const lease = Promise.resolve().then(factory).finally(() => {
      if (activeMutation === lease) activeMutation = null;
    });
    activeMutation = lease;
    return lease;
  };

  return {
    allocateStreamId,
    isBusy,
    activeTurn: () => activeTurn,
    activeMutation: () => activeMutation,
    trackTurn,
    tryTrackTurn,
    trackMutation,
  };
}
