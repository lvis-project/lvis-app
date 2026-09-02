/**
 * UI domain IPC handlers.
 * Covers native host UI surfaces that must escape renderer DOM clipping.
 */
import { BrowserWindow, Menu, ipcMain, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import {
  NATIVE_CONTEXT_MENU_COMMANDS,
  NATIVE_CONTEXT_MENU_COMMANDS_BY_KIND,
  NATIVE_MENU_MAX_DEPTH,
  NATIVE_MENU_MAX_ITEMS,
  sanitizeNativeMenuLabel,
  type DynamicNativeMenuAction,
  type NativeContextMenuAction,
  type NativeContextMenuCommand,
  type NativeContextMenuKind,
  type NativeContextMenuPayload,
} from "../../shared/native-context-menu.js";
import { UI } from "../../shared/ipc-channels.js";
import { t } from "../../i18n/index.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

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
  // Grouped by what the action COSTS to undo, cheapest first: open, then
  // labelling, then things that leave the window, then archive, and removal
  // last and alone. VS Code's context-menu guidance is to group similar
  // actions and keep the destructive one out of the group above it.
  project: [
    ["project.new-chat"],
    ["project.pin", "project.unpin", "project.edit", "project.reveal"],
    ["project.archive", "project.unarchive"],
    ["project.add"],
    ["project.remove"],
  ],
  conversation: [
    ["conversation.open"],
    ["conversation.mark-unread", "conversation.mark-read"],
    ["conversation.rename", "conversation.pin", "conversation.unpin"],
    ["conversation.share", "conversation.copy"],
    ["conversation.archive", "conversation.unarchive"],
    ["conversation.delete"],
    ["conversation.import"],
  ],
  message: [
    ["message.copy"],
    ["message.edit", "message.fork"],
    ["message.returnHere"],
  ],
  "command-item": [
    ["command.activate"],
    ["command.copy"],
  ],
};

const NATIVE_LABEL: Record<NativeContextMenuCommand, () => string> = {
  "action.open-system": () => t("toolActivity.openInSystemApp"),
  "action.copy-url": () => t("toolActivity.copyUrl"),
  "action.copy-path": () => t("toolActivity.copyPath"),
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
  "project.edit": () => t("sidebar.projectMenuEdit"),
  // Names the actual file manager, the way workspace.reveal already does. A
  // generic "reveal folder" made the same action read differently depending on
  // which menu you opened it from.
  "project.reveal": () =>
    t(process.platform === "darwin"
      ? "chatPreviewRail.revealInFinder"
      : "chatPreviewRail.revealInExplorer"),
  "project.archive": () => t("sidebar.projectMenuArchive"),
  "project.unarchive": () => t("sidebar.projectMenuUnarchive"),
  "project.add": () => t("sidebar.projectMenuAdd"),
  "project.remove": () => t("sidebar.projectMenuRemove"),
  "conversation.open": () => t("chatPreviewRail.ctxOpen"),
  "conversation.pin": () => t("sidebar.pinConversation"),
  "conversation.unpin": () => t("sidebar.unpinConversation"),
  "conversation.rename": () => t("sidebar.renameConversation"),
  "conversation.mark-unread": () => t("sidebar.markConversationUnread"),
  "conversation.mark-read": () => t("sidebar.markConversationRead"),
  "conversation.archive": () => t("sidebar.archiveConversation"),
  "conversation.unarchive": () => t("sidebar.unarchiveConversation"),
  "conversation.share": () => t("sidebar.shareConversation"),
  "conversation.copy": () => t("sidebar.copyConversation"),
  "conversation.delete": () => t("sidebar.deleteConversation"),
  "conversation.import": () => t("mainToolbar.import"),
  "message.copy": () => t("turnActionBar.copyButton"),
  "message.edit": () => t("chatView.editButtonTitle"),
  "message.fork": () => t("chatView.forkButtonTitle"),
  "message.returnHere": () => t("chatView.returnHereButtonTitle"),
  "command.activate": () => t("chatPreviewRail.ctxOpen"),
  "command.copy": () => t("turnActionBar.copyButton"),
};

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

/**
 * An accelerator is a key spec, not text: anything outside this shape is
 * dropped rather than handed to Electron, which throws on a malformed one and
 * would take the whole menu down with it. At least one modifier is required so
 * a row can never claim a bare keystroke the app itself may want.
 */
const ACCELERATOR_PATTERN = /^(?:(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)\+)+[A-Za-z0-9]$/;

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
  // Host-renderer frames only: this used to re-type the plugin-shell rejection
  // by hand instead of asking the guard that owns it.
  if (!validateHostRendererSender(event)) return null;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return null;

  const rawUrl = event.senderFrame?.url ?? "";

  const topLevelUrl = event.sender.getURL();
  if (topLevelUrl && rawUrl && topLevelUrl !== rawUrl) return null;
  return window;
}

function sendNativeAction(event: IpcMainInvokeEvent, action: NativeContextMenuAction): void {
  if (event.sender.isDestroyed()) return;
  event.sender.send(UI.nativeContextAction, action);
}

/** Popped-up menus, held until the OS reports them closed. */
const liveDynamicMenus = new Set<Menu>();

function sendDynamicMenuAction(
  event: IpcMainInvokeEvent,
  action: DynamicNativeMenuAction,
): void {
  if (event.sender.isDestroyed()) return;
  event.sender.send(UI.dynamicMenuAction, action);
}

/**
 * A dynamic menu carries rows main did not author, so nothing here trusts the
 * payload's shape: a row is kept only if it has an id and something to draw
 * after sanitising, the tree is bounded in depth and total rows, and an id is
 * echoed back verbatim rather than interpreted.
 */
function buildDynamicMenuItems(
  event: IpcMainInvokeEvent,
  requestId: string,
  items: unknown,
  depth: number,
  budget: { remaining: number },
): MenuItemConstructorOptions[] {
  if (!Array.isArray(items) || depth > NATIVE_MENU_MAX_DEPTH) return [];
  const built: MenuItemConstructorOptions[] = [];
  for (const raw of items) {
    if (budget.remaining <= 0) break;
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (typeof item.label !== "string") continue;
    const label = sanitizeNativeMenuLabel(item.label);
    if (label.length === 0) continue;
    const id = item.id;
    // Children are drawn before the parent claims its own slot, so a container
    // whose subtree did not survive the budget can be dropped whole. Demoting
    // it to a leaf instead would draw a row that reports a choice the renderer
    // registered no callback for: the menu closes, nothing runs, and the reply
    // consumes the pending request so the NEXT choice is dead too.
    const declaresSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
    const submenu = declaresSubmenu
      ? buildDynamicMenuItems(event, requestId, item.submenu, depth + 1, budget)
      : [];
    if (declaresSubmenu && submenu.length === 0) continue;
    budget.remaining -= 1;
    const sublabel = typeof item.sublabel === "string"
      ? sanitizeNativeMenuLabel(item.sublabel)
      : "";
    built.push({
      label,
      ...(sublabel.length > 0 ? { sublabel } : {}),
      ...(typeof item.accelerator === "string" && ACCELERATOR_PATTERN.test(item.accelerator)
        ? { accelerator: item.accelerator }
        : {}),
      enabled: item.enabled !== false,
      // A row with children opens them; only a leaf reports a choice. A leaf
      // that carries a state is drawn as a radio item showing it.
      ...(submenu.length > 0
        ? { submenu }
        : {
          ...(typeof item.checked === "boolean" ? { type: "radio" as const, checked: item.checked } : {}),
          click: () => sendDynamicMenuAction(event, { requestId, id }),
        }),
    });
  }
  return built;
}

function buildDynamicMenu(
  event: IpcMainInvokeEvent,
  payload: unknown,
): { menu: Menu; x: number; y: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const requestId = cleanRequestId(raw.requestId);
  const x = cleanCoordinate(raw.x);
  const y = cleanCoordinate(raw.y);
  if (!requestId || x === null || y === null || !Array.isArray(raw.sections)) return null;

  const budget = { remaining: NATIVE_MENU_MAX_ITEMS };
  const template: MenuItemConstructorOptions[] = [];
  for (const section of raw.sections) {
    if (!section || typeof section !== "object") continue;
    const items = buildDynamicMenuItems(
      event,
      requestId,
      (section as Record<string, unknown>).items,
      1,
      budget,
    );
    if (items.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...items);
  }
  if (template.length === 0) return null;
  // The clamped coordinates travel with the menu: the raw payload's are a DOM
  // rect the renderer never bounded, and a clipped composer reports a negative
  // left edge, which would pop the menu off every display.
  return { menu: Menu.buildFromTemplate(template), x, y };
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

  ipcMain.handle(UI.dynamicMenu, (event, payload: unknown) => {
    const window = hostWindowForUiEvent(event);
    if (!window) {
      auditUnauthorized(auditLogger, UI.dynamicMenu, event);
      return UNAUTHORIZED_FRAME;
    }

    const built = buildDynamicMenu(event, payload);
    if (!built) return { ok: false, error: "invalid-dynamic-menu" };

    // Electron does not retain a popped-up menu for the caller, so the local
    // binding is the only reference keeping it alive; release it when the OS
    // closes the menu rather than when this handler returns.
    liveDynamicMenus.add(built.menu);
    built.menu.popup({
      window,
      x: built.x,
      y: built.y,
      callback: () => liveDynamicMenus.delete(built.menu),
    });
    return { ok: true };
  });
}
