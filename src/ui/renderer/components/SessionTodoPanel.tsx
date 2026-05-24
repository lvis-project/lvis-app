/**
 * SessionTodoPanel — collapsible chat-side checklist for the
 * `todo_session_write` LLM tool. Visually distinct from persistent task views
 * (dashed border, amber accent) so the user can tell at a glance this is
 * the assistant's running plan.
 *
 * Expanded view: every item with status pill + content. The currently
 * in-progress item pulses so it's the obvious focal point.
 *
 * Collapsed view: header alone, but the title of the in-progress item
 * keeps streaming next to the badge — user always knows what the
 * assistant is working on without expanding.
 *
 * Continuation indicator: when items survive a panel re-mount on the same
 * `sessionId` we surface a small "이어서" badge so the user can tell the
 * panel is continuing prior work rather than starting fresh. Without this
 * the user reported confusion about whether a new turn resets state.
 *
 * Session filtering: pushes from `onSessionTodoChanged` are filtered by
 * the current `sessionId` prop so a stale session's emissions cannot
 * clobber the active view (the renderer used to apply every push
 * regardless of which session emitted it, which surfaced the bug
 * "TO-DO 가 작성은 되는데 업데이트는 안됨").
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks, Pencil, Plus, RotateCcw, Sparkles } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import type { LvisApi } from "../types.js";

interface SessionTodoItem {
  id: string;
  content: string;
  status: string;
}

type PlanBadge = "fresh" | "resumed";
type ChangeBadge = "added" | "updated";

const STATUS_BADGE: Record<string, { label: string; cls: string; dot: string }> = {
  pending: {
    label: "대기",
    cls: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/40",
  },
  in_progress: {
    label: "진행",
    cls: "bg-warning/15 text-warning",
    dot: "bg-warning",
  },
  completed: {
    label: "완료",
    cls: "bg-success/15 text-success",
    dot: "bg-success",
  },
  failed: {
    label: "실패",
    cls: "bg-destructive/15 text-destructive",
    dot: "bg-destructive",
  },
  deleted: {
    label: "취소",
    cls: "bg-muted text-muted-foreground line-through",
    dot: "bg-muted-foreground/40",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionTodoItemArray(value: unknown): value is SessionTodoItem[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!isRecord(item)) return false;
    return (
      typeof item.id === "string" &&
      typeof item.content === "string" &&
      typeof item.status === "string" &&
      Object.prototype.hasOwnProperty.call(STATUS_BADGE, item.status)
    );
  });
}

/**
 * Detects whether the prefers-reduced-motion media query is honored at
 * mount time. The result is captured once — a runtime change to the OS
 * preference would require a remount, which is acceptable for a UX hint
 * and avoids a useEffect listener for a signal that almost never flips.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function classifyTodoChange(
  prev: readonly SessionTodoItem[],
  next: readonly SessionTodoItem[],
): ChangeBadge | null {
  const prevById = new Map(prev.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const added = next.some((item) => !prevById.has(item.id));
  if (added) return "added";
  const updated = next.some((item) => {
    const before = prevById.get(item.id);
    return Boolean(before && (before.content !== item.content || before.status !== item.status));
  });
  if (updated) return "updated";
  const reordered = next.some((item, index) => prev[index]?.id !== item.id);
  if (reordered) return "updated";
  const removed = prev.some((item) => !nextById.has(item.id));
  return removed ? "updated" : null;
}

export function SessionTodoPanel({
  api,
  sessionId,
}: {
  api: LvisApi;
  /**
   * Current chat session id. Used to (a) filter incoming `:changed`
   * pushes so a stale session can't clobber the visible list, and (b)
   * decide whether to render the "이어서" continuation chip when the
   * panel re-mounts on the same id with prior items.
   */
  sessionId?: string;
}) {
  const [items, setItems] = useState<SessionTodoItem[]>([]);
  // Start collapsed: a freshly-set plan opens in the closed state so it does
  // not push the input cluster down. The collapsed header still streams the
  // in-progress item title, so the user sees the active step at a glance and
  // expands only when they want the full list.
  const [open, setOpen] = useState(false);
  // Plan marker: "resumed" only when the initial fetch finds existing items;
  // "fresh" when a live push creates a plan after an empty/cleared state.
  // Kept separate from item state so late initial fetches cannot overwrite a
  // live "fresh" push that arrived first.
  const [planBadge, setPlanBadge] = useState<PlanBadge | null>(null);
  // Last non-initial mutation marker. This is intentionally lightweight UI
  // state derived from item diffs; the store remains the item-list SOT.
  const [changeBadge, setChangeBadge] = useState<ChangeBadge | null>(null);
  const itemsRef = useRef<SessionTodoItem[]>([]);
  const latestSessionIdRef = useRef<string | undefined>(sessionId);
  const hasLivePushRef = useRef(false);
  latestSessionIdRef.current = sessionId;

  const applyItems = useCallback((next: SessionTodoItem[], source: "initial-fetch" | "push") => {
    const prev = itemsRef.current;
    if (source === "initial-fetch" && hasLivePushRef.current) {
      return;
    }
    itemsRef.current = next;
    setItems(next);

    if (next.length === 0) {
      setPlanBadge(null);
      setChangeBadge(null);
      return;
    }

    if (source === "initial-fetch") {
      setPlanBadge((current) => current ?? "resumed");
      return;
    }

    if (prev.length === 0) {
      setPlanBadge((current) => current ?? "fresh");
      setChangeBadge(null);
      return;
    }

    const change = classifyTodoChange(prev, next);
    setChangeBadge(change);
  }, []);

  const refresh = useCallback(async () => {
    if (typeof api.listSessionTodos !== "function") return;
    const requestedSessionId = sessionId;
    const list = await api.listSessionTodos(requestedSessionId);
    if (requestedSessionId !== latestSessionIdRef.current) {
      return;
    }
    if (!isSessionTodoItemArray(list)) {
      return;
    }
    applyItems(list, "initial-fetch");
  }, [api, applyItems, sessionId]);

  useEffect(() => {
    void refresh();
    if (typeof api.onSessionTodoChanged !== "function") {
      return undefined;
    }
    const unsub = api.onSessionTodoChanged((payload: unknown) => {
      if (!isRecord(payload)) {
        return;
      }
      const emittedSid = payload.sessionId;
      const next = payload.items;
      // Drop malformed or foreign pushes. Main/preload require `sessionId`;
      // accepting omitted IDs would let stale session events overwrite the
      // active view and reintroduce a hidden legacy path.
      if (typeof emittedSid !== "string" || emittedSid.length === 0) {
        return;
      }
      const activeSessionId = latestSessionIdRef.current;
      if (typeof activeSessionId !== "string" || activeSessionId.length === 0) {
        return;
      }
      if (emittedSid !== activeSessionId) {
        return;
      }
      if (!isSessionTodoItemArray(next)) {
        return;
      }
      hasLivePushRef.current = true;
      applyItems(next, "push");
    });
    return unsub;
  }, [api, refresh, sessionId]);

  // When the chat session id flips (new chat, load session, fork) we want
  // the panel to drop stale state immediately — otherwise the user sees
  // the prior session's items until the next push lands. Resetting via
  // refresh covers both "swap to a session that has todos" (fetch repopulates)
  // and "swap to a session that has none" (fetch returns []).
  useEffect(() => {
    setPlanBadge(null);
    setChangeBadge(null);
    hasLivePushRef.current = false;
    itemsRef.current = [];
    setItems([]);
  }, [sessionId]);

  if (items.length === 0) return null;

  const visible = items.filter((i) => i.status !== "deleted");
  const completedCount = items.filter((i) => i.status === "completed").length;
  const inProgress = items.find((i) => i.status === "in_progress");
  // Collapsed-header focus: prefer the in-progress item; if none yet (e.g. a
  // freshly-set plan still all-pending before step 1 is marked in_progress),
  // fall back to the first non-completed item so the closed header never goes
  // blank while there is still work to do.
  const collapsedFocus = inProgress ?? visible.find((i) => i.status !== "completed");
  const reduceMotion = prefersReducedMotion();
  // Pulse only when motion is allowed; otherwise rely on color/dot to
  // signal "active" (still readable, no jitter for sensitive users).
  const activePulse = reduceMotion ? "" : "animate-pulse";

  return (
    <div
      // The input cluster below us already draws its own `border-t bg-card`
      // — we don't double up. Side borders + dashed amber tint signal "this
      // is the assistant's running plan" without a redundant horizontal rule.
      className="border-x border-dashed border-warning/40 bg-warning/5 text-xs transition-colors"
      data-testid="session-todo-panel"
      data-session-id={sessionId ?? ""}
    >
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start gap-2 rounded-none px-3 py-1.5 text-xs font-normal hover:bg-warning/10"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <ListChecks className="h-3 w-3" />
        <span className="font-medium">세션 TO-DO</span>
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {completedCount}/{visible.length}
        </Badge>
        {/* Plan chip — makes the current-turn plan boundary explicit.
            `planBadge === null` means the first fetch hasn't resolved yet, so show nothing. */}
        {planBadge === "resumed" && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0 text-[10px] text-warning"
            data-testid="session-todo-continuation"
            title="현재 턴에서 작성된 TO-DO 를 이어서 진행 중"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            이어서
          </span>
        )}
        {planBadge === "fresh" && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0 text-[10px] text-success"
            data-testid="session-todo-fresh"
            title="현재 턴의 TO-DO 를 새로 작성"
          >
            <Sparkles className="h-2.5 w-2.5" />
            새 시작
          </span>
        )}
        {changeBadge === "added" && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0 text-[10px] text-primary"
            data-testid="session-todo-added"
            title="이번 업데이트에서 TO-DO 항목이 추가됨"
          >
            <Plus className="h-2.5 w-2.5" />
            추가
          </span>
        )}
        {changeBadge === "updated" && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0 text-[10px] text-muted-foreground"
            data-testid="session-todo-updated"
            title="이번 업데이트에서 TO-DO 항목이 수정됨"
          >
            <Pencil className="h-2.5 w-2.5" />
            수정
          </span>
        )}
        {/* Collapsed-state focal point: the focus item (in-progress, else the
            first non-completed) streams next to the count so the user can see
            what's happening at a glance without expanding. Pulse only when the
            focus item is actually in-progress. */}
        {!open && collapsedFocus && (
          <span
            className={`ml-2 min-w-0 flex-1 truncate text-left text-warning ${
              collapsedFocus.status === "in_progress" ? activePulse : ""
            }`}
            data-testid="session-todo-collapsed-active"
            title={collapsedFocus.content}
          >
            {collapsedFocus.content}
          </span>
        )}
      </Button>
      {open && (
        // Cap the expanded list so a long plan doesn't push the input
        // cluster off-screen — internal scroll preserves the chat layout.
        <ul className="max-h-[35vh] space-y-1 overflow-y-auto border-t px-3 py-1.5">
          {items.map((it) => {
            const meta = STATUS_BADGE[it.status] ?? STATUS_BADGE.pending;
            const active = it.status === "in_progress";
            return (
              <li
                key={it.id}
                className={`flex items-start gap-2 transition-opacity duration-200 ${
                  active ? activePulse : ""
                } ${it.status === "deleted" ? "opacity-50" : "opacity-100"}`}
                data-testid={active ? "session-todo-active-row" : undefined}
                data-status={it.status}
              >
                {/* Warp-style leading dot — color alone communicates state
                    even when the user has dimmed text or scaled the chip
                    label below readability. */}
                <span
                  aria-hidden
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${meta.dot} ${
                    active ? activePulse : ""
                  }`}
                />
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${meta.cls}`}
                >
                  {meta.label}
                </span>
                <span
                  className={`min-w-0 flex-1 transition-opacity duration-200 ${
                    it.status === "completed" ? "line-through opacity-70" : ""
                  } ${it.status === "deleted" ? "line-through opacity-50" : ""}`}
                >
                  {it.content}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
