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
