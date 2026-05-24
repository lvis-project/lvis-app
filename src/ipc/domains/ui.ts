/**
 * UI domain IPC handlers.
 * Covers native host UI surfaces that must escape renderer DOM clipping.
 */
import { BrowserWindow, Menu, ipcMain, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import type {
  AssistantContextMenuAction,
  AssistantContextMenuPayload,
  AssistantContextMenuPersona,
} from "../../shared/assistant-context-menu.js";
import { UI } from "../../shared/ipc-channels.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

const MAX_OPTIONS = 120;
const MAX_LABEL_CHARS = 120;
const MAX_REQUEST_ID_CHARS = 120;

function cleanMenuText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\r\n\t]/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_LABEL_CHARS);
}

function cleanRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > MAX_REQUEST_ID_CHARS) return null;
  return cleaned;
}

function cleanCoordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100_000, Math.round(value)));
}

function cleanPersonas(value: unknown): AssistantContextMenuPersona[] | null {
  if (!Array.isArray(value)) return null;
  const out: AssistantContextMenuPersona[] = [];
  for (const item of value.slice(0, MAX_OPTIONS)) {
    const raw = item as { id?: unknown; name?: unknown } | null;
    const id = cleanMenuText(raw?.id);
    const name = cleanMenuText(raw?.name);
    if (id && name) out.push({ id, name });
  }
  return out;
}

function normalizePayload(value: unknown): AssistantContextMenuPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const requestId = cleanRequestId(raw.requestId);
  const x = cleanCoordinate(raw.x);
  const y = cleanCoordinate(raw.y);
  const personas = cleanPersonas(raw.personas);
  if (!requestId || x === null || y === null || !personas) return null;
  return {
    requestId,
    x,
    y,
    personas,
    activePersonaId: cleanMenuText(raw.activePersonaId) ?? "",
  };
}

function hostWindowForUiEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  if (!validateSender(event)) return null;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return null;

  const rawUrl = event.senderFrame?.url ?? "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:" && url.pathname.toLowerCase().endsWith("/plugin-ui-shell.html")) {
      return null;
    }
  } catch {
    return null;
  }

  const topLevelUrl = event.sender.getURL();
  if (topLevelUrl && rawUrl && topLevelUrl !== rawUrl) return null;
  return window;
}

function sendAction(event: IpcMainInvokeEvent, action: AssistantContextMenuAction): void {
  if (event.sender.isDestroyed()) return;
  event.sender.send(UI.assistantContextAction, action);
}

function buildAssistantContextMenu(
  event: IpcMainInvokeEvent,
  payload: AssistantContextMenuPayload,
): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Persona",
      submenu: payload.personas.length > 0
        ? payload.personas.map((persona): MenuItemConstructorOptions => ({
          label: persona.name,
          type: "radio",
          checked: payload.activePersonaId === persona.id,
          click: () => sendAction(event, { requestId: payload.requestId, kind: "persona", id: persona.id }),
        }))
        : [{ label: "사용 가능한 persona 없음", enabled: false }],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function registerUiHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(UI.assistantContextMenu, (event, payload: unknown) => {
    const window = hostWindowForUiEvent(event);
    if (!window) {
      auditUnauthorized(auditLogger, UI.assistantContextMenu, event);
      return UNAUTHORIZED_FRAME;
    }

    const normalized = normalizePayload(payload);
    if (!normalized) return { ok: false, error: "invalid-assistant-context-menu" };

    buildAssistantContextMenu(event, normalized).popup({
      window,
      x: normalized.x,
      y: normalized.y,
    });
    return { ok: true };
  });
}
