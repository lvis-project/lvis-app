import { ipcMain } from "electron";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateSender } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";

const PROMPTS_UPDATED = CHANNELS.prompts.updated;

function normalizePromptPatch(value: unknown): {
  id: string;
  name: string;
  description?: string;
  systemPromptAdd: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.systemPromptAdd !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    systemPromptAdd: raw.systemPromptAdd,
  };
}

function broadcastPromptsUpdated(deps: IpcDeps): void {
  for (const win of deps.getAppWindows?.() ?? [deps.getMainWindow()]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(PROMPTS_UPDATED);
  }
}

export function registerPromptHandlers(deps: IpcDeps): void {
  const { auditLogger, personaPromptStore } = deps;

  ipcMain.handle(CHANNELS.prompts.list, async (event) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.prompts.list, event);
      return UNAUTHORIZED_FRAME;
    }
    const prompts = (await personaPromptStore?.list() ?? []).map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
      systemPromptAdd: prompt.systemPromptAdd,
    }));
    return { prompts };
  });

  ipcMain.handle(CHANNELS.prompts.listSummaries, async (event) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.prompts.listSummaries, event);
      return UNAUTHORIZED_FRAME;
    }
    const prompts = (await personaPromptStore?.list() ?? []).map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
    }));
    return { prompts };
  });

  ipcMain.handle(CHANNELS.prompts.save, async (event, payload: unknown) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.prompts.save, event);
      return UNAUTHORIZED_FRAME;
    }
    const prompt = normalizePromptPatch(payload);
    if (!prompt || !personaPromptStore) {
      return { ok: false, error: "invalid-persona-prompt" } as const;
    }
    try {
      const saved = await personaPromptStore.save(prompt);
      broadcastPromptsUpdated(deps);
      return {
        ok: true,
        prompt: {
          id: saved.id,
          name: saved.name,
          systemPromptAdd: saved.systemPromptAdd,
        },
      } as const;
    } catch (err) {
      return { ok: false, error: (err as Error).message } as const;
    }
  });

  ipcMain.handle(CHANNELS.prompts.delete, async (event, id: unknown) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.prompts.delete, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof id !== "string" || !personaPromptStore) {
      return { ok: false, error: "invalid-persona-prompt-id" } as const;
    }
    try {
      const deleted = await personaPromptStore.delete(id);
      if (deleted) broadcastPromptsUpdated(deps);
      return { ok: true, deleted } as const;
    } catch (err) {
      return { ok: false, error: (err as Error).message } as const;
    }
  });

}

export { PROMPTS_UPDATED };
