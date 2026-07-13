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
import {
  NATIVE_CONTEXT_MENU_COMMANDS,
  NATIVE_CONTEXT_MENU_COMMANDS_BY_KIND,
  type NativeContextMenuAction,
  type NativeContextMenuCommand,
  type NativeContextMenuKind,
  type NativeContextMenuPayload,
} from "../../shared/native-context-menu.js";
import { UI } from "../../shared/ipc-channels.js";
import { t } from "../../i18n/index.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

const MAX_OPTIONS = 120;
const MAX_LABEL_CHARS = 120;
const MAX_REQUEST_ID_CHARS = 120;
const MAX_NATIVE_COMMANDS = 16;

const NATIVE_KINDS = new Set<NativeContextMenuKind>([
  "action-item",
  "workspace-entry",
  "project",
  "conversation",
  "message",
  "command-item",
]);
const NATIVE_COMMANDS = new Set<NativeContextMenuCommand>(NATIVE_CONTEXT_MENU_COMMANDS);

const NATIVE_LAYOUT: Record<
  NativeContextMenuKind,
  readonly (readonly NativeContextMenuCommand[])[]
> = {
  "action-item": [
    ["action.open-system"],
    ["action.copy-url", "action.copy-path"],
  ],
  "workspace-entry": [
    ["workspace.open", "workspace.reveal"],
    ["workspace.copy-path", "workspace.copy-relative-path"],
  ],
  project: [
    ["project.new-chat"],
    ["project.pin", "project.unpin", "project.reveal"],
    ["project.remove"],
  ],
  conversation: [
    ["conversation.open"],
    ["conversation.pin", "conversation.unpin"],
  ],
  message: [
    ["message.copy"],
    ["message.edit", "message.fork"],
    ["message.pin", "message.unpin"],
  ],
  "command-item": [
    ["command.activate"],
    ["command.copy"],
  ],
};

const NATIVE_LABEL: Record<NativeContextMenuCommand, () => string> = {
  "action.open-system": () => t("actionPanel.openInSystemApp"),
  "action.copy-url": () => t("actionPanel.copyUrl"),
  "action.copy-path": () => t("actionPanel.copyPath"),
  "workspace.open": () => t("chatPreviewRail.ctxOpen"),
  "workspace.reveal": () =>
    t(process.platform === "darwin"
      ? "chatPreviewRail.revealInFinder"
      : "chatPreviewRail.revealInExplorer"),
  "workspace.copy-path": () => t("chatPreviewRail.copyPath"),
  "workspace.copy-relative-path": () => t("chatPreviewRail.copyRelativePath"),
  "project.new-chat": () => t("sidebar.projectMenuNewChat"),
  "project.pin": () => t("sidebar.pinProject"),
  "project.unpin": () => t("sidebar.unpinProject"),
  "project.reveal": () => t("sidebar.projectMenuReveal"),
  "project.remove": () => t("sidebar.projectMenuRemove"),
  "conversation.open": () => t("chatPreviewRail.ctxOpen"),
  "conversation.pin": () => t("sidebar.pinConversation"),
  "conversation.unpin": () => t("sidebar.unpinConversation"),
  "message.copy": () => t("turnActionBar.copyButton"),
  "message.edit": () => t("chatView.editButtonTitle"),
  "message.fork": () => t("chatView.forkButtonTitle"),
  "message.pin": () => t("chatView.starButtonTitle"),
  "message.unpin": () => t("starredView.unstar"),
  "command.activate": () => t("chatPreviewRail.ctxOpen"),
  "command.copy": () => t("turnActionBar.copyButton"),
};

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

function normalizeNativePayload(value: unknown): NativeContextMenuPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const requestId = cleanRequestId(raw.requestId);
  const x = cleanCoordinate(raw.x);
  const y = cleanCoordinate(raw.y);
  const kind = raw.kind;
  if (
    !requestId ||
    x === null ||
    y === null ||
    typeof kind !== "string" ||
    !NATIVE_KINDS.has(kind as NativeContextMenuKind) ||
    !Array.isArray(raw.commands) ||
    raw.commands.length === 0 ||
    raw.commands.length > MAX_NATIVE_COMMANDS
  ) {
    return null;
  }

  const typedKind = kind as NativeContextMenuKind;
  const allowed = new Set<NativeContextMenuCommand>(
    NATIVE_CONTEXT_MENU_COMMANDS_BY_KIND[typedKind],
  );
  const commands: NativeContextMenuCommand[] = [];
  for (const rawCommand of raw.commands) {
    if (
      typeof rawCommand !== "string" ||
      !NATIVE_COMMANDS.has(rawCommand as NativeContextMenuCommand)
    ) {
      return null;
    }
    const command = rawCommand as NativeContextMenuCommand;
    if (!allowed.has(command)) return null;
    if (!commands.includes(command)) commands.push(command);
  }
  if (commands.length === 0) return null;
  return { requestId, x, y, kind: typedKind, commands };
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

function sendNativeAction(event: IpcMainInvokeEvent, action: NativeContextMenuAction): void {
  if (event.sender.isDestroyed()) return;
  event.sender.send(UI.nativeContextAction, action);
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
        : [{ label: t("mainDialog.noPersonasAvailable"), enabled: false }],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function buildNativeContextMenu(
  event: IpcMainInvokeEvent,
  payload: NativeContextMenuPayload,
): Menu {
  const included = new Set(payload.commands);
  const template: MenuItemConstructorOptions[] = [];
  for (const section of NATIVE_LAYOUT[payload.kind]) {
    const commands = section.filter((command) => included.has(command));
    if (commands.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    for (const command of commands) {
      template.push({
        label: NATIVE_LABEL[command](),
        click: () => sendNativeAction(event, {
          requestId: payload.requestId,
          command,
        }),
      });
    }
  }
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

  ipcMain.handle(UI.nativeContextMenu, (event, payload: unknown) => {
    const window = hostWindowForUiEvent(event);
    if (!window) {
      auditUnauthorized(auditLogger, UI.nativeContextMenu, event);
      return UNAUTHORIZED_FRAME;
    }

    const normalized = normalizeNativePayload(payload);
    if (!normalized) return { ok: false, error: "invalid-native-context-menu" };

    buildNativeContextMenu(event, normalized).popup({
      window,
      x: normalized.x,
      y: normalized.y,
    });
    return { ok: true };
  });
}
