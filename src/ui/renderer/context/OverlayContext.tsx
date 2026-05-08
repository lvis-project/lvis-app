/**
 * OverlayContext — Q10 routine fire overlay queue.
 *
 * Q10 policy:
 *   - Single active card + queue navigation (prev/next)
 *   - queueIndex / queueTotal display
 *   - dismiss (permanent removal)
 *   - snooze removed (production smoke test: UX risk)
 *   - stale fire replace: new fire for same routineId replaces all prior entries
 *
 * Q9 isolation: only ~200ch summary flows here. Full content is read
 * directly by RoutineSessionView from the JSONL file.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type OverlayItemSource =
  | { kind: "routine"; routineId: string; firedAt: string }
  // TODO(work-proactive): connect to OverlayContext via main IPC. Implement after Q10 ships.
  | { kind: "plugin"; pluginId: string; eventId: string };

export interface OverlayItem {
  /** Unique id: `${source.kind}-${unique}` */
  id: string;
  source: OverlayItemSource;
  title: string;
  summary: string;
  /** running phase — true: spinner + "진행 중…", false: summary + actions */
  running: boolean;
  /** primary action label — routine: "결과 보기", plugin: free */
  primaryActionLabel?: string;
  /** routine-specific — path to JSONL for RoutineSessionView */
  routineSessionPath?: string;
  /**
   * Q11 plugin (insertion-type) — prompt to inject into main chat when the
   * user confirms (primary action). Absent for routine-source items.
   */
  pendingPrompt?: string;
  /**
   * ISO timestamp when the item was created/received. Used by OverlayCard
   * relativeTime display for plugin-source items (which lack a firedAt on source).
   */
  createdAt?: string;
}

export interface OverlayContextValue {
  /** Currently displayed item (head of visible queue) */
  active: OverlayItem | null;
  /** 1-based index of active within visible queue */
  queueIndex: number;
  /** Total items in visible queue */
  queueTotal: number;
  /** Navigate to previous item */
  prev: () => void;
  /** Navigate to next item */
  next: () => void;
  /** Permanently remove from queue */
  dismiss: (id: string) => void;
  /** Add or update an overlay item. Replaces existing entry with same source key. */
  addFire: (item: OverlayItem) => void;
  /** Open RoutineSessionView modal */
  openSession: (routineId: string, firedAt: string) => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function OverlayContextProvider({
  children,
  onOpenSession,
  addFireRef,
  runningRoutines,
}: {
  children: ReactNode;
  onOpenSession: (routineId: string, firedAt: string) => void;
  /**
   * Optional ref that App.tsx populates so it can call addFire() from
   * outside the React tree (e.g. from an IPC subscription useEffect).
   * The ref is set synchronously during render, before any effects fire.
   */
  addFireRef?: RefObject<((item: OverlayItem) => void) | null>;
  /**
   * C1: Set of currently-running routine IDs from App.tsx runningRoutines state.
   * Provider syncs queue items' running flag when this set changes.
   */
  runningRoutines?: Set<string>;
}) {
  const [queue, setQueue] = useState<OverlayItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const active = queue[activeIndex] ?? null;
  const queueIndex = queue.length > 0 ? Math.min(activeIndex, queue.length - 1) + 1 : 0;
  const queueTotal = queue.length;

  // Clamp activeIndex when queue shrinks
  useEffect(() => {
    if (activeIndex >= queue.length && queue.length > 0) {
      setActiveIndex(queue.length - 1);
    }
  }, [queue.length, activeIndex]);

  // C1: sync running flag from runningRoutines set whenever it changes
  useEffect(() => {
    if (!runningRoutines) return;
    setQueue((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (item.source.kind !== "routine") return item;
        const isRunning = runningRoutines.has(item.source.routineId);
        if (isRunning !== item.running) {
          changed = true;
          return { ...item, running: isRunning };
        }
        return item;
      });
      return changed ? next : prev;
    });
  }, [runningRoutines]);

  const addFire = useCallback((item: OverlayItem) => {
    setQueue((prev) => {
      // Stale fire replace: source.kind === "routine" + same routineId → replace;
      // source.kind === "plugin" + same (pluginId, eventId) → replace.
      // Stale guard: for routine items, only replace if incoming firedAt >= existing firedAt.
      // Date.parse() defensive comparison — handles any ISO string normalisation
      // differences; falls back to keeping existing on NaN (safe).
      let dominated = false;
      const filtered = prev.filter((it) => {
        if (item.source.kind === "routine" && it.source.kind === "routine") {
          if (it.source.routineId !== item.source.routineId) return true;
          // Same routineId: drop existing only if incoming is same age or newer.
          const itemTime = Date.parse(item.source.firedAt);
          const existingTime = Date.parse(it.source.firedAt);
          if (Number.isFinite(itemTime) && Number.isFinite(existingTime) && itemTime < existingTime) {
            dominated = true; // incoming is stale — keep existing
            return true;
          }
          return false; // drop existing, incoming is newer
        }
        if (item.source.kind === "plugin" && it.source.kind === "plugin") {
          return !(
            it.source.pluginId === item.source.pluginId &&
            it.source.eventId === item.source.eventId
          );
        }
        return true;
      });
      if (dominated) return prev; // stale replay — discard
      return [...filtered, { ...item }];
    });
  }, []);

  // M7: navigate to tail (newest item) when a new fire arrives.
  // Kept outside setQueue updater to avoid setState-inside-updater side-effect
  // (StrictMode double-invokes updaters, which would double-advance activeIndex).
  const prevQueueLengthRef = useRef(0);
  useEffect(() => {
    if (queue.length > prevQueueLengthRef.current) {
      setActiveIndex(queue.length - 1);
    }
    prevQueueLengthRef.current = queue.length;
  }, [queue.length]);

  // Expose addFire via ref so App.tsx can call it from IPC subscription
  if (addFireRef) {
    // Safe: synchronous assignment during render, before effects
    addFireRef.current = addFire;
  }

  const dismiss = useCallback((id: string) => {
    setQueue((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const prev = useCallback(() => {
    setActiveIndex((i) => Math.max(0, i - 1));
  }, []);

  const next = useCallback(() => {
    setActiveIndex((i) => Math.min(queue.length - 1, i + 1));
  }, [queue.length]);

  const openSession = useCallback(
    (routineId: string, firedAt: string) => {
      onOpenSession(routineId, firedAt);
    },
    [onOpenSession],
  );

  const value = useMemo<OverlayContextValue>(
    () => ({ active, queueIndex, queueTotal, prev, next, dismiss, addFire, openSession }),
    [active, queueIndex, queueTotal, prev, next, dismiss, addFire, openSession],
  );

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

export function useOverlayContext(): OverlayContextValue {
  const v = useContext(OverlayContext);
  if (!v) throw new Error("useOverlayContext must be used within OverlayContextProvider");
  return v;
}
