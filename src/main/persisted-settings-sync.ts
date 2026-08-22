/**
 * Synchronous boot-time reads of the persisted settings file.
 *
 * Several decisions are made before the async bootstrap constructs
 * `SettingsService`: the window is sized and its initial mode primed
 * (`persisted-app-mode.ts`), Chromium's GPU process is allowed or refused
 * (`persisted-hardware-acceleration.ts`), and the corporate CA is injected into
 * the TLS stack (`persisted-corp-ca.ts`). Each of those needs the user's saved
 * choice, and none of them can ask the service for it.
 *
 * They were each parsing the settings file themselves, three copies of the same
 * open/parse/narrow. This is that parse, once. The rule every caller shares:
 * a missing file, a corrupt file, a missing field, or a field of the wrong
 * type all mean "the user has not chosen" — `undefined`, never a value. Each
 * caller turns that absence into ITS own default, because the defaults differ
 * and collapsing them here would hide that.
 */
import { existsSync, readFileSync } from "node:fs";
import { settingsFilePath } from "../data/settings-store.js";

/**
 * The `system` block of the persisted settings file, or `undefined` when the
 * file is absent, unparseable, or has no such block.
 *
 * A corrupt file is not reported here: the async settings-service path surfaces
 * the parse error later, with the machinery to tell the user about it. Boot
 * decisions taken before that just fall back to their defaults.
 */
export function readPersistedSystemSectionSync(
  userDataPath: string,
): Record<string, unknown> | undefined {
  const settingsPath = settingsFilePath(userDataPath);
  if (!existsSync(settingsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const system = parsed.system;
    return typeof system === "object" && system !== null
      ? (system as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A `system.<key>` boolean, or `undefined` when it is absent or not a boolean. */
export function readPersistedSystemBooleanSync(
  userDataPath: string,
  key: string,
): boolean | undefined {
  const value = readPersistedSystemSectionSync(userDataPath)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A `system.<key>` string, or `undefined` when it is absent, not a string, or
 * blank. Blank counts as absent: a text field the user emptied is a field they
 * left to the default, not an instruction to search for the empty name.
 */
export function readPersistedSystemStringSync(
  userDataPath: string,
  key: string,
): string | undefined {
  const value = readPersistedSystemSectionSync(userDataPath)?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
