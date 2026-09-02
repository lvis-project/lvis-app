/**
 * SessionGoalPanel — the session's goal as a chip in the composer status row,
 * next to the tasks chip: the tasks are the steps, the goal is what the steps
 * are for and why the session keeps going after a turn ends.
 *
 * The chip carries the round counter because that number is the one thing a
 * self-reviving session does not otherwise announce, and one button whose
 * meaning follows the goal's state — stop while it is running, resume while it
 * is paused, continue once the revival budget is spent, dismiss once the goal
 * is met.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Target, Pause, Play, X } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import {
  isSessionGoal,
  isSessionGoalAtCeiling,
  type SessionGoal,
} from "../../../shared/session-goal.js";
import type { LvisApi } from "../types.js";
import { isRecord } from "../../../shared/is-record.js";

/** What the chip's single button does, given the goal's state. */
type GoalAction = "pause" | "resume" | "dismiss";

function actionFor(goal: SessionGoal): GoalAction {
  if (goal.status === "complete") return "dismiss";
  if (goal.status === "paused" || isSessionGoalAtCeiling(goal)) return "resume";
  return "pause";
}

export function SessionGoalPanel({
  api,
  sessionId,
}: {
  api: LvisApi;
  /**
   * Current chat session id. Incoming `:changed` pushes are filtered on it so
   * another tile's goal cannot clobber this one, and it scopes every button.
   */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const latestSessionIdRef = useRef<string | undefined>(sessionId);
  const hasLivePushRef = useRef(false);
  latestSessionIdRef.current = sessionId;

  // The store is the SOT. A late initial fetch must not overwrite a goal a
  // live push already applied — the same guard the tasks chip carries.
  const applyGoal = useCallback(
    (next: SessionGoal | null, source: "initial-fetch" | "push") => {
      if (source === "initial-fetch" && hasLivePushRef.current) return;
      setGoal(next);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const requestedSessionId = sessionId;
    if (!requestedSessionId?.trim()) return;
    const current = await api.getSessionGoal(requestedSessionId);
    if (requestedSessionId !== latestSessionIdRef.current) return;
    applyGoal(isSessionGoal(current) ? current : null, "initial-fetch");
  }, [api, applyGoal, sessionId]);

  useEffect(() => {
    void refresh();
    return api.onSessionGoalChanged((payload: unknown) => {
      if (!isRecord(payload)) return;
      const emittedSid = payload.sessionId;
      const activeSessionId = latestSessionIdRef.current;
      if (typeof emittedSid !== "string" || emittedSid.length === 0) return;
      if (typeof activeSessionId !== "string" || emittedSid !== activeSessionId) return;
      const next = payload.goal;
      if (next !== null && !isSessionGoal(next)) return;
      hasLivePushRef.current = true;
      applyGoal(next === null ? null : next, "push");
    });
  }, [api, applyGoal, refresh, sessionId]);

  // A tile that swaps conversations drops the previous goal at once, rather
  // than showing it until the next push lands.
  useEffect(() => {
    hasLivePushRef.current = false;
    setGoal(null);
  }, [sessionId]);

  if (goal === null) return null;

  const action = actionFor(goal);
  const atCeiling = isSessionGoalAtCeiling(goal);
  const stateLabel =
    goal.status === "complete"
      ? t("sessionGoalPanel.stateComplete")
      : goal.status === "paused"
        ? t("sessionGoalPanel.statePaused")
        : atCeiling
          ? t("sessionGoalPanel.stateCeiling")
          : t("sessionGoalPanel.stateRunning");
  const actionLabel =
    action === "pause"
      ? t("sessionGoalPanel.actionStop")
      : action === "resume"
        ? atCeiling
          ? t("sessionGoalPanel.actionContinue")
          : t("sessionGoalPanel.actionResume")
        : t("sessionGoalPanel.actionDismiss");
  const ActionIcon = action === "pause" ? Pause : action === "resume" ? Play : X;

  const runAction = async () => {
    if (!sessionId?.trim()) return;
    try {
      if (action === "pause") await api.pauseSessionGoal(sessionId);
      else if (action === "resume") await api.resumeSessionGoal(sessionId);
      else await api.clearSessionGoal(sessionId);
    } catch (err) {
      // Silent: the store's own push is what actually moves the chip, so a
      // failed call correctly leaves it where it was.
      console.warn("session-goal action failed:", err);
    }
  };

  return (
    <span
      className="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-info/(--opacity-medium) bg-info/(--opacity-faint) px-1.5 tabular-nums text-info"
      data-testid="session-goal-panel"
      data-session-id={sessionId ?? ""}
      data-status={goal.status}
      data-at-ceiling={atCeiling ? "true" : "false"}
      title={t("sessionGoalPanel.panelTitle", { goal: goal.text, state: stateLabel })}
    >
      <Target className="h-3 w-3 shrink-0" />
      <span
        className="max-w-[14rem] min-w-0 truncate text-left"
        data-testid="session-goal-text"
      >
        {goal.text}
      </span>
      <span className="shrink-0" data-testid="session-goal-round">
        {goal.round}/{goal.ceiling}
      </span>
      <button
        type="button"
        onClick={() => { void runAction(); }}
        data-testid="session-goal-action"
        data-action={action}
        aria-label={actionLabel}
        title={actionLabel}
        className="shrink-0 rounded-full transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-70 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none"
      >
        <ActionIcon className="h-3 w-3" />
      </button>
    </span>
  );
}
