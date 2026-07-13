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
  "project.reveal",
  "project.remove",
  "conversation.open",
  "conversation.pin",
  "conversation.unpin",
  "message.copy",
  "message.edit",
  "message.fork",
  "message.pin",
  "message.unpin",
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
  project: [
    "project.new-chat",
    "project.pin",
    "project.unpin",
    "project.reveal",
    "project.remove",
  ],
  conversation: ["conversation.open", "conversation.pin", "conversation.unpin"],
  message: ["message.copy", "message.edit", "message.fork", "message.pin", "message.unpin"],
  "command-item": ["command.activate", "command.copy"],
} as const satisfies Record<NativeContextMenuKind, readonly NativeContextMenuCommand[]>;
