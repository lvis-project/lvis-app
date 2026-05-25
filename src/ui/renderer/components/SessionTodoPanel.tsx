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
 * Manual dismiss: when every item is completed (6/6) the header surfaces an
 * X button so the user can close a finished plan immediately. The actual
 * clear is driven by the store emitting an empty list (which makes the panel
 * return null), not a local-only hide — this keeps the renderer in sync with
 * the store SOT. This is an interim manual affordance while the turn-start
 * auto-clear (gated to completed + input-origin) is unreliable.
 *
 * Session filtering: pushes from `onSessionTodoChanged` are filtered by
 * the current `sessionId` prop so a stale session's emissions cannot
 * clobber the active view (the renderer used to apply every push
 * regardless of which session emitted it, which surfaced the bug
 * "TO-DO 가 작성은 되는데 업데이트는 안됨").
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ListChecks,
  X,
} from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import {
  isSessionTodoStatus,
  type SessionTodoItem,
  type SessionTodoStatus,
} from "../../../shared/session-todo.js";
import type { LvisApi } from "../types.js";

const STATUS_BADGE: Record<SessionTodoStatus, { label: string; cls: string; dot: string }> = {
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
      isSessionTodoStatus(item.status)
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

export function SessionTodoPanel({
  api,
  sessionId,
}: {
  api: LvisApi;
  /**
   * Current chat session id. Used to filter incoming `:changed` pushes so a
   * stale session can't clobber the visible list, and to scope the manual
   * dismiss clear to the active session.
   */
  sessionId?: string;
}) {
  const [items, setItems] = useState<SessionTodoItem[]>([]);
  // Start collapsed: a freshly-set plan opens in the closed state so it does
  // not push the input cluster down. The collapsed header still streams the
  // in-progress item title, so the user sees the active step at a glance and
  // expands only when they want the full list.
  const [open, setOpen] = useState(false);
  const itemsRef = useRef<SessionTodoItem[]>([]);
  const latestSessionIdRef = useRef<string | undefined>(sessionId);
  const hasLivePushRef = useRef(false);
  latestSessionIdRef.current = sessionId;

  // The store remains the item-list SOT. A late initial fetch must not
  // overwrite items that a live push already applied, so we guard
  // initial-fetch updates behind the `hasLivePushRef` flag.
  const applyItems = useCallback((next: SessionTodoItem[], source: "initial-fetch" | "push") => {
    if (source === "initial-fetch" && hasLivePushRef.current) {
      return;
    }
    itemsRef.current = next;
    setItems(next);
  }, []);

  const refresh = useCallback(async () => {
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
    hasLivePushRef.current = false;
    itemsRef.current = [];
    setItems([]);
  }, [sessionId]);

  if (items.length === 0) return null;

  const visible = items;
  const completedCount = items.filter((i) => i.status === "completed").length;
  const inProgress = items.find((i) => i.status === "in_progress");
  // A completed plan is the trigger for the manual dismiss affordance.
  const allComplete = visible.length > 0 && completedCount === visible.length;
  // Collapsed-header focus: prefer the in-progress item; if none yet (e.g. a
  // freshly-set plan still all-pending before step 1 is marked in_progress),
  // fall back to the first non-completed item so the closed header never goes
  // blank while there is still work to do.
  const collapsedFocus = inProgress ?? visible.find((i) => i.status !== "completed");
  const reduceMotion = prefersReducedMotion();
  // Pulse only when motion is allowed; otherwise rely on color/dot to
  // signal "active" (still readable, no jitter for sensitive users).
  const activePulse = reduceMotion ? "" : "animate-pulse";

  const handleDismiss = async () => {
    try {
      await api.clearSessionTodos(sessionId);
    } catch (err) {
      // Silent failure: the panel stays visible if the clear didn't land.
      // No user-facing text — the store emit is what actually clears the view.
      console.warn("session-todo dismiss failed:", err);
    }
  };

  return (
    <div
      // The input cluster below us already draws its own `border-t bg-card`
      // — we don't double up. Side borders + dashed amber tint signal "this
      // is the assistant's running plan" without a redundant horizontal rule.
      className="border-x border-dashed border-warning/40 bg-warning/5 text-xs transition-colors"
      data-testid="session-todo-panel"
      data-session-id={sessionId ?? ""}
    >
      <div className="flex items-center hover:bg-warning/10">
        <Button
          type="button"
          variant="ghost"
          className="h-auto flex-1 min-w-0 justify-start gap-2 rounded-none px-3 py-1.5 text-xs font-normal hover:bg-transparent"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <ListChecks className="h-3 w-3" />
          <span className="font-medium">세션 TO-DO</span>
          <Badge variant="outline" className="px-1 py-0 text-[10px]">
            {completedCount}/{visible.length}
          </Badge>
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
        {allComplete && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mr-1 h-6 w-6 shrink-0 rounded-none hover:bg-transparent"
            data-testid="session-todo-dismiss"
            title="완료된 TO-DO 닫기"
            onClick={(e) => {
              // Don't toggle the panel open/closed when dismissing.
              e.stopPropagation();
              void handleDismiss();
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      {open && (
        // Cap the expanded list so a long plan doesn't push the input
        // cluster off-screen — internal scroll preserves the chat layout.
        <ul className="max-h-[35vh] space-y-1 overflow-y-auto border-t px-3 py-1.5">
          {items.map((it) => {
            const meta = STATUS_BADGE[it.status];
            const active = it.status === "in_progress";
            return (
              <li
                key={it.id}
                className={`flex items-start gap-2 transition-opacity duration-200 ${
                  active ? activePulse : ""
                }`}
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
                  }`}
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
