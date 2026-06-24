/**
 * English message catalog — the canonical key set for the whole app.
 *
 * Every other locale (see {@link ./ko}) must provide a translation for each
 * key here; missing keys fall back to this English text at runtime and are a
 * type error at build time. Keys are dot-namespaced by surface/component
 * (`settings.appearance.*`, `chatView.*`, …). Placeholders use single braces:
 * `"Hello {name}"`.
 *
 * This file is the seed; surface-specific keys are appended as each module is
 * migrated off hardcoded strings.
 */
export const en = {
  // ── Common / shared ───────────────────────────────────────────────
  "common.cancel": "Cancel",
  "common.allow": "Allow",
  "common.confirm": "Confirm",
  "common.ok": "OK",
  "common.save": "Save",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.retry": "Retry",
  "common.loading": "Loading…",
  "common.error": "Error",
  "common.thinking": "Thinking…",

  // ── Settings → Appearance → Language ──────────────────────────────
  "settings.appearance.language.title": "Language",
  "settings.appearance.language.description":
    "Choose the language used throughout the app. Changes apply immediately.",
  "settings.appearance.language.saved": "Language updated.",

  // ── Main-process dialogs / menus / notifications ──────────────────
  "mainDialog.restart": "Restart",
  "mainDialog.updateApplyTitle": "Apply Update",
  "mainDialog.updateRestartMessage": "LVIS will restart to v{version}.",
  "mainDialog.updateRestartDetail": "Work in progress will end. Do you want to continue?",
  "mainDialog.attachTitle": "Select attachment files",
  "mainDialog.installLocalPluginTitle": "Install local plugin (developer)",
  "mainDialog.installLocalPluginMessage": "Select the build folder that contains plugin.json",
  "mainDialog.unauthorizedFrame": "Unauthorized frame.",
  "mainDialog.noPersonasAvailable": "No personas available",
  "mainDialog.exportConversationTitle": "Export conversation",
} as const;

/**
 * Union of the *seed* (hand-curated, common) translation keys. The full app
 * key space is `string` (see {@link ./index.MessageKey}) because per-surface
 * keys are merged in from generated fragments; this strict type just keeps the
 * Korean seed catalog ({@link ./ko}) in lockstep with the English seed.
 */
export type SeedMessageKey = keyof typeof en;
