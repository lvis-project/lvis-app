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
import { ChevronDown, ChevronRight, ListChecks, RotateCcw, Sparkles } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import type { LvisApi } from "../types.js";

interface SessionTodoItem {
  id: string;
  content: string;
  status: string;
}

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
  // Continuation marker: true when the panel surfaced items via the
  // initial `listSessionTodos` fetch (i.e. items already existed for
  // this session before mount). Distinguishes "이어서 진행" from "새 시작".
  const [resumed, setResumed] = useState<boolean | null>(null);
  // Track which session's items are currently rendered so a `:changed`
  // event for a different session id is dropped instead of overwriting.
  const visibleSessionRef = useRef<string | undefined>(sessionId);

  const refresh = useCallback(async () => {
    if (typeof api.listSessionTodos !== "function") return;
    const list = await api.listSessionTodos(sessionId);
    visibleSessionRef.current = sessionId;
    setItems(list);
    // First fetch on a session id determines the continuation state:
    //   - existing items => "이어서" (resumed)
    //   - empty list     => "새 시작" (fresh)
    setResumed(list.length > 0);
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
    if (typeof api.onSessionTodoChanged !== "function") {
      return undefined;
    }
    const unsub = api.onSessionTodoChanged(({ sessionId: emittedSid, items: next }) => {
      // Drop pushes from a different session — without this, switching
      // chats keeps the old session emitting into the active panel.
      // The bridge is permitted to omit `sessionId` (legacy clients);
      // in that case we accept the push as the bridge already filtered.
      if (emittedSid && sessionId && emittedSid !== sessionId) {
        return;
      }
      visibleSessionRef.current = emittedSid ?? sessionId;
      setItems(next);
      // Latch the continuation marker on the very first arrival so it
      // stays stable for the lifetime of this mount:
      //   - null → false  (panel mounted empty, items just landed = 새 시작)
      //   - null → true   (panel mounted with items already = 이어서)
      // Subsequent pushes do not flip the marker.
      setResumed((prev) => (prev === null ? next.length > 0 : prev));
    });
    return unsub;
  }, [api, refresh, sessionId]);

  // When the chat session id flips (new chat, load session, fork) we want
  // the panel to drop stale state immediately — otherwise the user sees
  // the prior session's items until the next push lands. Resetting via
  // refresh covers both "swap to a session that has todos" (fetch repopulates)
  // and "swap to a session that has none" (fetch returns []).
  useEffect(() => {
    setResumed(null);
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
        {/* Continuation chip — explicit affordance for the user feedback:
            "신규 TO-DO 를 작성하거나, 다음 턴을 시작할 때, 계속 이어서 하는 것인지
            초기화 하고 가는 것인지도 판단이 잘 안되고 있음". `resumed === null`
            means the first fetch hasn't resolved yet, so show nothing. */}
        {resumed === true && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0 text-[10px] text-warning"
            data-testid="session-todo-continuation"
            title="이전 턴의 TO-DO 를 이어서 진행 중"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            이어서
          </span>
        )}
        {resumed === false && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0 text-[10px] text-success"
            data-testid="session-todo-fresh"
            title="새 세션에서 TO-DO 를 새로 작성"
          >
            <Sparkles className="h-2.5 w-2.5" />
            새 시작
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
