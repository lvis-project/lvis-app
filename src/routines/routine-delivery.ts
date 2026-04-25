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
