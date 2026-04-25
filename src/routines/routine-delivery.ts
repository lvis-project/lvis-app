import type { BrowserWindow } from "electron";
import type { RoutineResult } from "../core/routine-engine.js";

let latestRoutineResult: RoutineResult | null = null;

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
