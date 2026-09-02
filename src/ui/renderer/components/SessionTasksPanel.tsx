/**
 * SessionTasksPanel — the assistant's session task list (`session_tasks`
 * tool) as a chip in the composer status row, with the numbered list in a
 * popover. Numbers are 1-based and match what the model sees, so "task 2"
 * on screen is the "task 2" the assistant talks about.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ListChecks, X } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  isSessionTaskItem,
  type SessionTaskItem,
  type SessionTaskStatus,
} from "../../../shared/session-tasks.js";
import type { LvisApi } from "../types.js";
import { isRecord } from "../../../shared/is-record.js";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion.js";

const STATUS_BADGE: Record<SessionTaskStatus, { labelKey: string; cls: string; dot: string }> = {
  pending: {
    labelKey: "sessionTasksPanel.statusPending",
    cls: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/(--opacity-medium)",
  },
  in_progress: {
    labelKey: "sessionTasksPanel.statusInProgress",
    cls: "bg-warning/(--opacity-soft) text-warning",
    dot: "bg-warning",
  },
  completed: {
    labelKey: "sessionTasksPanel.statusCompleted",
    cls: "bg-success/(--opacity-soft) text-success",
    dot: "bg-success",
  },
};

function isSessionTaskItemArray(value: unknown): value is SessionTaskItem[] {
  return Array.isArray(value) && value.every(isSessionTaskItem);
}

export function SessionTasksPanel({
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
  const { t } = useTranslation();
  const [items, setItems] = useState<SessionTaskItem[]>([]);
  // The list lives in a popover that starts closed: a freshly-set plan must
  // not take space from the conversation. The chip still names the active
  // step, so the user sees what is happening at a glance and opens the list
  // only when they want the whole plan.
  const [open, setOpen] = useState(false);
  const itemsRef = useRef<SessionTaskItem[]>([]);
  const latestSessionIdRef = useRef<string | undefined>(sessionId);
  const hasLivePushRef = useRef(false);
  latestSessionIdRef.current = sessionId;

  // The store remains the item-list SOT. A late initial fetch must not
  // overwrite items that a live push already applied, so we guard
  // initial-fetch updates behind the `hasLivePushRef` flag.
  const applyItems = useCallback((next: SessionTaskItem[], source: "initial-fetch" | "push") => {
    if (source === "initial-fetch" && hasLivePushRef.current) {
      return;
    }
    itemsRef.current = next;
    setItems(next);
  }, []);

  const refresh = useCallback(async () => {
    const requestedSessionId = sessionId;
    // Before a tile holds a conversation there is nothing to list, and the
    // channel names its session or nothing at all — main has no "current
    // session" to resolve an unnamed read against.
    if (!requestedSessionId?.trim()) return;
    const list = await api.listSessionTasks(requestedSessionId);
    if (requestedSessionId !== latestSessionIdRef.current) {
      return;
    }
    if (!isSessionTaskItemArray(list)) {
      return;
    }
    applyItems(list, "initial-fetch");
  }, [api, applyItems, sessionId]);

  useEffect(() => {
    void refresh();
    const unsub = api.onSessionTasksChanged((payload: unknown) => {
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
      if (!isSessionTaskItemArray(next)) {
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
  // refresh covers both "swap to a session that has tasks" (fetch repopulates,
  // including a list read back from the session's metadata sidecar) and "swap
  // to a session that has none" (fetch returns []).
  useEffect(() => {
    hasLivePushRef.current = false;
    itemsRef.current = [];
    setItems([]);
  }, [sessionId]);

  // Read before the empty-list bail: hook order must not depend on whether
  // there is a plan to draw.
  const reduceMotion = usePrefersReducedMotion();

  if (items.length === 0) return null;

  const visible = items;
  const completedCount = items.filter((i) => i.status === "completed").length;
  const inProgress = items.find((i) => i.status === "in_progress");
  // A completed plan is the trigger for the manual dismiss affordance. Finished
  // tasks stay listed (and persisted) until the user dismisses them or the
  // assistant replaces the plan.
  const allComplete = visible.length > 0 && completedCount === visible.length;
  // Collapsed-header focus: prefer the in-progress item; if none yet (e.g. a
  // freshly-set plan still all-pending before step 1 is marked in_progress),
  // fall back to the first non-completed item so the closed header never goes
  // blank while there is still work to do.
  const collapsedFocus = inProgress ?? visible.find((i) => i.status !== "completed");
  // Pulse only when motion is allowed; otherwise rely on color/dot to
  // signal "active" (still readable, no jitter for sensitive users).
  const activePulse = reduceMotion ? "" : "animate-pulse";

  const handleDismiss = async () => {
    if (!sessionId?.trim()) return;
    try {
      await api.clearSessionTasks(sessionId);
    } catch (err) {
      // Silent failure: the panel stays visible if the clear didn't land.
      // No user-facing text — the store emit is what actually clears the view.
      console.warn("session-tasks dismiss failed:", err);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* A chip in the composer's status row, next to the context ring: the
            plan describes the SESSION's work, which is what that row is for.
            It used to be a full-width band above the composer, which floated
            over an empty toast reserve whenever there was nothing to notify. */}
        <button
          type="button"
          className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-warning/(--opacity-medium) bg-warning/(--opacity-faint) px-1.5 tabular-nums text-warning transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:bg-warning/(--opacity-subtle) focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none ${
            open ? "bg-warning/(--opacity-subtle)" : ""
          }`}
          data-testid="session-tasks-panel"
          data-session-id={sessionId ?? ""}
          aria-expanded={open}
          title={t("sessionTasksPanel.panelTitle")}
        >
          <ListChecks className="h-3 w-3 shrink-0" />
          <span className="shrink-0">
            {completedCount}/{visible.length}
          </span>
          {/* The focus item (in-progress, else the first not-completed) rides
              on the chip so the active step is readable without opening the
              list. Pulse only when it is actually in progress. */}
          {collapsedFocus && (
            <span
              className={`max-w-[14rem] min-w-0 truncate text-left ${
                collapsedFocus.status === "in_progress" ? activePulse : ""
              }`}
              data-testid="session-tasks-collapsed-active"
              title={collapsedFocus.content}
            >
              {items.indexOf(collapsedFocus) + 1}. {collapsedFocus.content}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0 text-xs" data-testid="session-tasks-list">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <ListChecks className="h-3 w-3" />
          <span className="font-medium">{t("sessionTasksPanel.panelTitle")}</span>
          <Badge variant="outline" className="px-1 py-0 text-[10px]">
            {completedCount}/{visible.length}
          </Badge>
          {allComplete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6 shrink-0"
              data-testid="session-tasks-dismiss"
              title={t("sessionTasksPanel.dismissTitle")}
              onClick={() => { void handleDismiss(); }}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
        {/* Cap the list so a long plan stays inside the popover — internal
            scroll instead of a popover taller than the window. */}
        <ul className="max-h-[35vh] space-y-1 overflow-y-auto border-t px-3 py-1.5">
          {items.map((it, i) => {
            const meta = STATUS_BADGE[it.status];
            const active = it.status === "in_progress";
            return (
              <li
                key={it.id}
                className={`flex items-start gap-2 transition-opacity duration-200 ${
                  active ? activePulse : ""
                }`}
                data-testid={active ? "session-tasks-active-row" : "session-tasks-row"}
                data-status={it.status}
                data-index={i + 1}
              >
                {/* The 1-based number is the task's identity for the user and
                    the model alike — it is what "task 2" refers to. */}
                <span className="mt-px w-4 shrink-0 text-right tabular-nums text-muted-foreground">
                  {i + 1}.
                </span>
                {/* Leading status dot — color alone communicates state
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
                  {t(meta.labelKey)}
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
      </PopoverContent>
    </Popover>
  );
}
