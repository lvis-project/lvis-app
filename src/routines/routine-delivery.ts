import type { BrowserWindow } from "electron";
import type { RoutineResult } from "../core/routine-engine.js";
import type { NotificationService } from "../main/notification-service.js";

let latestRoutineResult: RoutineResult | null = null;
/**
 * Issue #260 — singleton-style notification service handle. Boot wires this
 * once via {@link setNotificationServiceForRoutines}; every delivery site
 * (routine-coordinator, IPC dev-trigger, main.ts shutdown) then fires through
 * the shared instance without each caller needing direct wiring.
 *
 * Module-level state is acceptable here: {@link deliverRoutineResult} is
 * already module-level and singleton-scoped (latestRoutineResult above).
 */
let notificationServiceForRoutines: NotificationService | undefined;
export function setNotificationServiceForRoutines(svc: NotificationService | undefined): void {
  notificationServiceForRoutines = svc;
}

export function getLatestRoutineResult(): RoutineResult | null {
  return latestRoutineResult ? { ...latestRoutineResult } : null;
}

export function clearLatestRoutineResult(): void {
  latestRoutineResult = null;
}

export function notifyRoutineStarted(
  mainWindow: BrowserWindow | null,
  payload: { routineId: string; trigger: string; startedAt: string },
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("lvis:routine:started", payload);
}

export async function deliverRoutineResult(
  mainWindow: BrowserWindow | null,
  result: RoutineResult,
): Promise<void> {
  latestRoutineResult = { ...result };
  // Issue #260 — fire `routine` system notification at the delivery site so
  // every routine-completion path (coordinator, IPC dev-trigger, main.ts
  // shutdown) gets the user-facing cue without duplicating wiring. The fire
  // happens BEFORE the mainWindow null/destroyed early return because the
  // notification path uses NotificationService's live mainWindow getter and
  // can still emit an OS notification even when the window is gone.
  try {
    notificationServiceForRoutines?.fire({
      kind: "routine",
      title: `${result.routineId} 완료`,
      body: result.summary ?? "",
      contextRef: { routineId: result.routineId, sessionId: result.sessionId },
    });
  } catch {
    // notification failure must never block routine delivery
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("lvis:routine:completed", result);
}

/**
 * Emits a `lvis:routine:completed` event for an aborted/failed routine so the
 * renderer's running-indicator (`useRoutineRunning`) clears its in-flight
 * entry. Without this, a started→failed path leaves a zombie spinner forever.
 */
export function notifyRoutineFailed(
  mainWindow: BrowserWindow | null,
  payload: { routineId: string; trigger: string },
  error: string,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const completedAt = new Date().toISOString();
  mainWindow.webContents.send("lvis:routine:completed", {
    routineId: payload.routineId,
    trigger: payload.trigger,
    summary: `루틴 실행 실패: ${error}`,
    generatedAt: completedAt,
  });
}
