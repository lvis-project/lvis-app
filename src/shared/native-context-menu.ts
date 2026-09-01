export const NATIVE_CONTEXT_MENU_COMMANDS = [
  "action.open-system",
  "action.copy-url",
  "action.copy-path",
  "workspace.open",
  "workspace.reveal",
  "workspace.copy-path",
  "workspace.copy-relative-path",
  "project.new-chat",
  "project.pin",
  "project.unpin",
  "project.edit",
  "project.reveal",
  "project.archive",
  "project.unarchive",
  "project.add",
  "project.remove",
  "conversation.open",
  "conversation.pin",
  "conversation.unpin",
  "conversation.rename",
  "conversation.mark-unread",
  "conversation.mark-read",
  "conversation.archive",
  "conversation.unarchive",
  "conversation.share",
  "conversation.copy",
  "conversation.delete",
  "conversation.import",
  "message.copy",
  "message.edit",
  "message.fork",
  "message.returnHere",
  "command.activate",
  "command.copy",
] as const;

export type NativeContextMenuCommand = (typeof NATIVE_CONTEXT_MENU_COMMANDS)[number];

export type NativeContextMenuKind =
  | "action-item"
  | "workspace-entry"
  | "project"
  | "conversation"
  | "message"
  | "command-item";

export interface NativeContextMenuPayload {
  requestId: string;
  x: number;
  y: number;
  kind: NativeContextMenuKind;
  commands: NativeContextMenuCommand[];
}

export interface NativeContextMenuAction {
  requestId: string;
  command: NativeContextMenuCommand;
}

export const NATIVE_CONTEXT_MENU_COMMANDS_BY_KIND = {
  "action-item": ["action.open-system", "action.copy-url", "action.copy-path"],
  "workspace-entry": [
    "workspace.open",
    "workspace.reveal",
    "workspace.copy-path",
    "workspace.copy-relative-path",
  ],
  // `project.add` is the only command the Projects tab's EMPTY area offers, so
  // it shares the `project` kind rather than earning a kind of its own: a
  // right-click on a row and a right-click on the blank space below it are the
  // same menu with a different subset of commands enabled. `conversation.import`
  // is the same arrangement one tab over: it creates a NEW conversation, so it
  // belongs to the LIST rather than to any row in it.
  project: [
    "project.new-chat",
    "project.pin",
    "project.unpin",
    "project.edit",
    "project.reveal",
    "project.archive",
    "project.unarchive",
    "project.add",
    "project.remove",
  ],
  conversation: [
    "conversation.open",
    "conversation.pin",
    "conversation.unpin",
    "conversation.rename",
    "conversation.mark-unread",
    "conversation.mark-read",
    "conversation.archive",
    "conversation.unarchive",
    "conversation.share",
    "conversation.copy",
    "conversation.delete",
    "conversation.import",
  ],
  message: ["message.copy", "message.edit", "message.fork", "message.returnHere"],
  "command-item": ["command.activate", "command.copy"],
} as const satisfies Record<NativeContextMenuKind, readonly NativeContextMenuCommand[]>;


/**
 * A menu whose ROWS are not known ahead of time — the composer's command menu,
 * whose contents are the installed plugins, the connected MCP servers, and the
 * skills registered right now.
 *
 * This is a second contract rather than more entries in the allow-list above,
 * because the two answer different questions. The allow-list menu asks "which
 * of these fixed commands apply here?", and main owns every label. Here the
 * renderer owns the rows, so the ids it gets back are its own and mean nothing
 * to main; main's job is to draw text it did not write, which is why
 * `sanitizeNativeMenuLabel` exists.
 */
export interface NativeMenuItem {
  /** Opaque to main: echoed back on click and resolved by the renderer. */
  id: string;
  label: string;
  /** macOS draws this under the label; other platforms ignore it. */
  sublabel?: string;
  accelerator?: string;
  enabled?: boolean;
  submenu?: NativeMenuItem[];
}

/** Items drawn together; sections are separated by a divider. */
interface NativeMenuSection {
  items: NativeMenuItem[];
}

export interface DynamicNativeMenuPayload {
  requestId: string;
  x: number;
  y: number;
  sections: NativeMenuSection[];
}

export interface DynamicNativeMenuAction {
  requestId: string;
  id: string;
}

/** One row of a menu is one line. Nothing in a label may claim to be more. */
const NATIVE_MENU_LABEL_MAX = 120;
/** Deep enough for category then item; a third level is not a menu, it is a tree. */
export const NATIVE_MENU_MAX_DEPTH = 2;
export const NATIVE_MENU_MAX_ITEMS = 400;

/**
 * A plugin's name and an MCP server's tool names are third-party text, and a
 * native menu row is drawn by the OS with no markup to escape into. What such
 * text CAN reach is structure: a line separator splits one row across the menu,
 * and a bidi override reorders what the OS draws. Both are removed, and the
 * result is capped so one row cannot push the rest off the screen.
 */
export function sanitizeNativeMenuLabel(raw: string): string {
  const flattened = raw.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g,
    " ",
  );
  const collapsed = flattened.replace(/\s+/g, " ").trim();
  return collapsed.length > NATIVE_MENU_LABEL_MAX
    ? `${collapsed.slice(0, NATIVE_MENU_LABEL_MAX - 1)}\u2026`
    : collapsed;
}
