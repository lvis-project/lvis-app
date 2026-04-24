import type { BrowserWindow } from "electron";
import type { Briefing, ShutdownSummary } from "../core/routine-engine.js";
import type { MemoryManager } from "../memory/memory-manager.js";

let latestRoutineBriefing: Briefing | null = null;

async function persistRoutineMessage(
  memoryManager: MemoryManager,
  opts: {
    routineId: string;
    routineTitle: string;
    heading: string;
    content: string;
  },
): Promise<void> {
  if (!opts.content) return;
  const latest = memoryManager.listSessionsByRoutine(opts.routineId, 1)[0];
  const sessionId = latest?.id ?? crypto.randomUUID();
  if (!latest) {
    await memoryManager.saveSessionMetadata(sessionId, {
      routineId: opts.routineId,
      routineTitle: opts.routineTitle,
    });
  }
  const existing = (memoryManager.loadSession(sessionId) ?? []) as Array<{ role: string; content: string }>;
  existing.push({
    role: "assistant",
    content: `${opts.heading}\n\n${opts.content}`,
  });
  await memoryManager.saveSession(sessionId, existing);
}

export async function persistRoutineBriefing(
  memoryManager: MemoryManager,
  briefing: Briefing,
): Promise<void> {
  const content = briefing.summary?.trim() || briefing.items.map((item) =>
    `- [${item.priority}] ${item.title}${item.detail ? ` — ${item.detail}` : ""}`
  ).join("\n");
  await persistRoutineMessage(memoryManager, {
    routineId: "daily-briefing",
    routineTitle: "데일리 브리핑",
    heading: "🗒️ 데일리 브리핑",
    content,
  });
}

export async function persistShutdownSummary(
  memoryManager: MemoryManager,
  summary: ShutdownSummary,
): Promise<void> {
  await persistRoutineMessage(memoryManager, {
    routineId: "shutdown-summary",
    routineTitle: "종료 요약",
    heading: "🌙 종료 요약",
    content: summary.summary.trim(),
  });
}

export function getLatestRoutineBriefing(): Briefing | null {
  if (!latestRoutineBriefing) return null;
  return {
    ...latestRoutineBriefing,
    items: latestRoutineBriefing.items.map((item) => ({ ...item })),
  };
}

export function clearLatestRoutineBriefing(): void {
  latestRoutineBriefing = null;
}

export async function deliverRoutineBriefing(
  mainWindow: BrowserWindow | null,
  memoryManager: MemoryManager,
  briefing: Briefing,
): Promise<void> {
  latestRoutineBriefing = {
    ...briefing,
    items: briefing.items.map((item) => ({ ...item })),
  };
  await persistRoutineBriefing(memoryManager, briefing);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("lvis:routine:briefing", briefing);
}
