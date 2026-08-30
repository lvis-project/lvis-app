import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { approvalQueueReducer } from "../../../lib/approval-queue-reducer.js";
import type { UserApprovalVerdict } from "../../../shared/permissions-events.js";
import type { ApprovalChoice, ApprovalDecision, ApprovalRequest } from "../types.js";

export type ApprovalDecisionExtras = Pick<ApprovalDecision, "elicitationContent">;

/**
 * Which surface draws the card for a session.
 *
 * The queue is the window's — one `lvis:approval:request` subscription, one
 * FIFO — but a card belongs in the conversation that asked: a tile draws the
 * requests of its own session and of the sub-agents it spawned, a side chat
 * draws its own. Each surface CLAIMS the sessions it draws, and the window's
 * own dock is left with exactly the requests no surface claimed — a headless
 * routine's turn, a request that names no conversation at all.
 *
 * A claim is a predicate rather than a list because ownership is dynamic (a
 * tile's children come and go) and the surface already keeps that predicate
 * stable for its stream subscriptions.
 */
export class ApprovalSurfaceClaims {
  private readonly owners = new Map<string, (sessionId: string) => boolean>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** Register a surface's ownership; returns the release. */
  claim(surfaceId: string, ownsSession: (sessionId: string) => boolean): () => void {
    this.owners.set(surfaceId, ownsSession);
    this.bump();
    return () => {
      if (this.owners.get(surfaceId) !== ownsSession) return;
      this.owners.delete(surfaceId);
      this.bump();
    };
  }

  /** The surface drawing `sessionId`'s cards, if any surface claimed it. */
  ownerOf(sessionId: string): string | null {
    for (const [surfaceId, ownsSession] of this.owners) {
      if (ownsSession(sessionId)) return surfaceId;
    }
    return null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Changes whenever a claim is added or released — what re-renders readers. */
  readVersion = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface ApprovalQueueApi {
  /** Every request the window is holding, in the order the host asked. */
  queue: ApprovalRequest[];
  /** Answer one request; a second call for the same id while the first is in flight is ignored. */
  decide: (
    requestId: string,
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => Promise<void>;
  /** Forget requests the host settled without an answer from this window. */
  dropSettled: (ids: readonly string[]) => void;
  claims: ApprovalSurfaceClaims;
}

/**
 * Approval queue hook.
 *
 * Owns: the window's FIFO of pending requests (via approvalQueueReducer), the
 * window.lvis.approval.onRequest subscription, the one-time read of requests
 * parked before this renderer subscribed, the per-request in-flight guard on
 * `decide`, and the claims register the drawing surfaces attach to. A decided
 * request stays in the queue — and so on screen — until the host acknowledges
 * the answer, so every surfaced request is actionable exactly once.
 */
export function useApproval(): ApprovalQueueApi {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const queueRef = useRef<ApprovalRequest[]>([]);
  // In-flight guard — one answer per request. A request leaves this set when
  // it leaves the queue, never earlier: releasing it on `respond()` settling
  // would let a click that lands before the drop commits answer it twice.
  const inFlightRequestIdsRef = useRef<Set<string>>(new Set());
  // Every request this renderer has answered. A parked snapshot fetched before
  // the host settled one of them must not draw its card again.
  const answeredRequestIdsRef = useRef<Set<string>>(new Set());
  // Guard late setQueue from async `respond()` callbacks resolving after
  // unmount.
  const aliveRef = useRef(true);
  const claims = useMemo(() => new ApprovalSurfaceClaims(), []);
  // A queued request becomes clickable as soon as its dock is committed.
  // Synchronize the imperative queue ref before paint so a fast click cannot
  // observe the previous (or empty) queue.
  useLayoutEffect(() => {
    queueRef.current = queue;
    for (const id of inFlightRequestIdsRef.current) {
      if (!queue.some((req) => req.id === id)) inFlightRequestIdsRef.current.delete(id);
    }
  }, [queue]);

  useEffect(() => {
    aliveRef.current = true;
    // Surface preload init bugs explicitly. The approval queue is a
    // load-bearing UX path; silently no-op'ing here when `window.lvis` is
    // missing makes the bug present as "tools never resolve" instead of
    // "preload didn't run".
    if (!window.lvis) {
      console.error("[use-approval] window.lvis is undefined — preload missing or failed to load");
      return () => {
        aliveRef.current = false;
      };
    }
    const unsub = window.lvis.approval.onRequest((req) => {
      if (!aliveRef.current) return;
      setQueue((q) => approvalQueueReducer(q, { type: "push", req }));
    });
    // Requests parked before this renderer subscribed — a reload mid-approval.
    // Subscribed first, fetched second, so nothing can fall between the two;
    // a request that arrived both ways is kept once. Parked requests were
    // asked first, so they go ahead of anything that arrived meanwhile. One
    // this renderer has already answered (an answer in flight, or settled
    // after the snapshot was taken) is not a parked request any more.
    void window.lvis.approval.listPending().then(
      (parked) => {
        if (!aliveRef.current) return;
        const stillParked = parked.filter(
          (req) => !inFlightRequestIdsRef.current.has(req.id) && !answeredRequestIdsRef.current.has(req.id),
        );
        setQueue((q) =>
          [...stillParked, ...q].reduce<ApprovalRequest[]>(
            (acc, req) =>
              acc.some((held) => held.id === req.id)
                ? acc
                : approvalQueueReducer(acc, { type: "push", req }),
            [],
          ),
        );
      },
      (err: unknown) => {
        console.warn("[use-approval] listPending failed:", (err as Error).message);
      },
    );
    return () => {
      aliveRef.current = false;
      unsub();
    };
  }, []);

  /**
   * Forget requests the host has already settled without an answer from here
   * — a turn that timed out or was cancelled while its ask was parked. A
   * request whose answer is in flight is left to `decide`, which removes it
   * once the host acknowledges.
   */
  const dropSettled = useCallback((ids: readonly string[]) => {
    const settled = ids.filter((id) => !inFlightRequestIdsRef.current.has(id));
    if (settled.length === 0) return;
    setQueue((q) => approvalQueueReducer(q, { type: "drop", ids: settled }));
  }, []);

  /**
   * Answer one pending request.
   *
   * On `respond()` rejection we only log — we do NOT re-push the request.
   * The main process may already have emitted a response (or the request is
   * no longer actionable), and re-pushing causes a double-display bug.
   */
  const decide = useCallback(
    async (
      requestId: string,
      choice: ApprovalChoice,
      pattern?: string,
      extras?: ApprovalDecisionExtras,
    ) => {
      if (inFlightRequestIdsRef.current.has(requestId)) return;
      const current = queueRef.current.find((req) => req.id === requestId);
      if (!current) return;
      // Assert preload availability explicitly. If the user landed on this
      // code path with no preload, the queue would never surface a request
      // anyway; reaching here means the early-return safeguard exists in two
      // places and one of them is stale.
      if (!window.lvis) {
        console.error("[use-approval] decide: window.lvis is undefined — preload missing");
        return;
      }
      inFlightRequestIdsRef.current.add(requestId);
      answeredRequestIdsRef.current.add(requestId);

      try {
        await window.lvis.approval.respond({
          requestId: current.id,
          choice,
          rememberPattern: pattern,
          // Confused-deputy defense: echo nonce + HMAC verbatim so the main process can verify
          // this response was bound to the original request (confused-
          // deputy defense). Stale or cross-wired responses fail the check
          // and are forcibly downgraded to deny-once.
          nonce: current.nonce,
          hmac: current.hmac,
          ...(extras && "elicitationContent" in extras
            ? { elicitationContent: extras.elicitationContent }
            : {}),
        });
      } catch (err) {
        // Log only — do NOT re-push. See JSDoc above.
        console.warn("[lvis] approval.respond failed:", (err as Error).message);
      } finally {
        // Keep the decided request mounted until the IPC request settles. If a
        // new request arrives meanwhile, showing it before this guard releases
        // would make its click look successful while being ignored.
        if (aliveRef.current) {
          setQueue((q) => approvalQueueReducer(q, { type: "drop", ids: [requestId] }));
        } else {
          inFlightRequestIdsRef.current.delete(requestId);
        }
      }
    },
    [],
  );

  return useMemo(() => ({ queue, decide, dropSettled, claims }), [queue, decide, dropSettled, claims]);
}

/** Re-render when a surface claims or releases sessions. */
export function useApprovalClaimsVersion(claims: ApprovalSurfaceClaims): number {
  return useSyncExternalStore(claims.subscribe, claims.readVersion, claims.readVersion);
}

/**
 * The window's approval queue plus the decisions only the window can host —
 * the exact-deny draft in Settings and the `/allow` sentence proposal. Every
 * drawing surface (tile, side chat, the window's own dock) reads this one
 * value, so a card is answered through the same path wherever it is shown.
 */
export interface ApprovalSurfaceContextValue extends ApprovalQueueApi {
  /** Open the exact-deny editor in Settings for `request`. */
  openPermanentDeny: (request: ApprovalRequest, verdict: UserApprovalVerdict) => void;
  /** The request whose exact-deny draft Settings is holding; its card waits. */
  lockedRequestId: string | null;
  /** `/allow <sentence>` proposal: the request it names and the choice to pre-select. */
  proposal: { requestId: string; choice: ApprovalChoice } | null;
}

const ApprovalSurfaceContext = createContext<ApprovalSurfaceContextValue | null>(null);

export const ApprovalSurfaceProvider = ApprovalSurfaceContext.Provider;

export function useApprovalSurface(): ApprovalSurfaceContextValue {
  const value = useContext(ApprovalSurfaceContext);
  if (value === null) {
    throw new Error("useApprovalSurface: rendered outside ApprovalSurfaceProvider");
  }
  return value;
}
