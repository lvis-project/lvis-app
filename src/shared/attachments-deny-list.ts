/**
 * Single source of truth for the file-picker deny-list. Imported by both
 * the renderer (`src/ui/renderer/types/attachments.ts`) and the main
 * process (`src/ipc/domains/attach.ts`) so the two sides cannot drift.
 *
 * Lowercase comparison.
 */
export const DENY_EXTENSIONS = [
  "exe",
  "bat",
  "cmd",
  "com",
  "scr",
  "vbs",
  "msi",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "sh",
  "ps1",
] as const;

export type DenyExtension = (typeof DENY_EXTENSIONS)[number];
