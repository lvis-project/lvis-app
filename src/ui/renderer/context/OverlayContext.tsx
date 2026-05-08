/**
 * OverlayContext — Q10 routine fire overlay queue.
 *
 * Inherits v1 RoutineCard policy:
 *   - Single active card + queue navigation (prev/next)
 *   - queueIndex / queueTotal display
 *   - dismiss (permanent removal)
 *   - snooze (default 30 min, re-enters queue on expiry)
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
  /** ms epoch — when snooze expires; absent means not snoozed */
  snoozedUntil?: number;
  /** primary action label — routine: "결과 보기", plugin: free */
  primaryActionLabel?: string;
  /** routine-specific — path to JSONL for RoutineSessionView */
  routineSessionPath?: string;
}

export interface OverlayContextValue {
  /** Currently displayed item (head of visible queue) */
  active: OverlayItem | null;
  /** 1-based index of active within visible queue */
  queueIndex: number;
  /** Total items in visible (non-snoozed) queue */
  queueTotal: number;
  /** Navigate to previous item */
  prev: () => void;
  /** Navigate to next item */
  next: () => void;
  /** Permanently remove from queue */
  dismiss: (id: string) => void;
  /** Snooze — default 30 min. Expired items re-enter queue at tail */
  snooze: (id: string, durationMs?: number) => void;
  /** Add or update an overlay item. Replaces existing entry with same source key. */
  addFire: (item: Omit<OverlayItem, "snoozedUntil">) => void;
  /** Open RoutineSessionView modal */
  openSession: (routineId: string, firedAt: string) => void;
}

const SNOOZE_DEFAULT_MS = 30 * 60 * 1000; // 30 minutes

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function OverlayContextProvider({
  children,
  onOpenSession,
  addFireRef,
}: {
  children: ReactNode;
  onOpenSession: (routineId: string, firedAt: string) => void;
  /**
   * Optional ref that App.tsx populates so it can call addFire() from
   * outside the React tree (e.g. from an IPC subscription useEffect).
   * The ref is set synchronously during render, before any effects fire.
   */
  addFireRef?: RefObject<((item: Omit<OverlayItem, "snoozedUntil">) => void) | null>;
}) {
  const [queue, setQueue] = useState<OverlayItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tick, setTick] = useState(0); // forces re-render on snooze expiry

  // Visible queue = queue items whose snooze has expired (or never snoozed)
  const now = Date.now();
  const visible = useMemo(
    () => queue.filter((it) => !it.snoozedUntil || it.snoozedUntil <= now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, tick],
  );

  const active = visible[activeIndex] ?? null;
  const queueIndex = visible.length > 0 ? Math.min(activeIndex, visible.length - 1) + 1 : 0;
  const queueTotal = visible.length;

  // Clamp activeIndex when visible queue shrinks
  useEffect(() => {
    if (activeIndex >= visible.length && visible.length > 0) {
      setActiveIndex(visible.length - 1);
    }
  }, [visible.length, activeIndex]);

  // Schedule re-render when next snoozed item is ready to re-enter
  useEffect(() => {
    if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
    const snoozed = queue.filter((it) => it.snoozedUntil && it.snoozedUntil > Date.now());
    if (snoozed.length === 0) return;
    const nextExpiry = Math.min(...snoozed.map((it) => it.snoozedUntil!));
    const delay = nextExpiry - Date.now();
    snoozeTimerRef.current = setTimeout(() => setTick((t) => t + 1), delay + 50);
    return () => {
      if (snoozeTimerRef.current) clearTimeout(snoozeTimerRef.current);
    };
  }, [queue]);

  const addFire = useCallback((item: Omit<OverlayItem, "snoozedUntil">) => {
    setQueue((prev) => {
      // Stale fire replace: source.kind === "routine" + same routineId → replace;
      // source.kind === "plugin" + same (pluginId, eventId) → replace.
      const filtered = prev.filter((it) => {
        if (item.source.kind === "routine" && it.source.kind === "routine") {
          return it.source.routineId !== item.source.routineId;
        }
        if (item.source.kind === "plugin" && it.source.kind === "plugin") {
          return !(
            it.source.pluginId === item.source.pluginId &&
            it.source.eventId === item.source.eventId
          );
        }
        return true;
      });
      return [...filtered, { ...item }];
    });
    // When a new fire arrives, navigate to tail (newest item)
    setActiveIndex((prev) => Math.max(0, prev));
  }, []);

  // Expose addFire via ref so App.tsx can call it from IPC subscription
  if (addFireRef) {
    // Safe: synchronous assignment during render, before effects
    (addFireRef as { current: typeof addFire }).current = addFire;
  }

  const dismiss = useCallback((id: string) => {
    setQueue((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const snooze = useCallback((id: string, durationMs = SNOOZE_DEFAULT_MS) => {
    const until = Date.now() + durationMs;
    setQueue((prev) =>
      prev.map((it) => (it.id === id ? { ...it, snoozedUntil: until } : it)),
    );
  }, []);

  const prev = useCallback(() => {
    setActiveIndex((i) => Math.max(0, i - 1));
  }, []);

  const next = useCallback(() => {
    setActiveIndex((i) => Math.min(visible.length - 1, i + 1));
  }, [visible.length]);

  const openSession = useCallback(
    (routineId: string, firedAt: string) => {
      onOpenSession(routineId, firedAt);
    },
    [onOpenSession],
  );

  const value = useMemo<OverlayContextValue>(
    () => ({ active, queueIndex, queueTotal, prev, next, dismiss, snooze, addFire, openSession }),
    [active, queueIndex, queueTotal, prev, next, dismiss, snooze, addFire, openSession],
  );

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

export function useOverlayContext(): OverlayContextValue {
  const v = useContext(OverlayContext);
  if (!v) throw new Error("useOverlayContext must be used within OverlayContextProvider");
  return v;
}
