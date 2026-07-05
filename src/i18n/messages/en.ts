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

  // ── E4 — Startup / global shortcuts settings tab ──────────────────
  "settingsContent.tabStartup": "Startup",
  "startupTab.title": "Startup & Shortcuts",
  "startupTab.description":
    "Set a global shortcut to show/hide the window, and choose whether LVIS launches at login.",
  "startupTab.shortcutSectionTitle": "Global shortcut",
  "startupTab.shortcutSectionDesc":
    "A system-wide key combination that shows or hides the LVIS window from anywhere.",
  "startupTab.shortcutEnabledLabel": "Enable global shortcut",
  "startupTab.shortcutEnabledHint": "Register the shortcut with the operating system.",
  "startupTab.shortcutAcceleratorLabel": "Show/hide window shortcut",
  "startupTab.shortcutRecord": "Record",
  "startupTab.shortcutClear": "Clear",
  "startupTab.shortcutCapturing": "Press a key combination…",
  "startupTab.shortcutUnset": "Not set",
  "startupTab.shortcutEnabledNoAccelerator":
    "The shortcut is enabled but no key combination is set. Record one to activate it.",
  "startupTab.shortcutRegisterFailedTitle": "Shortcut registration failed",
  "startupTab.shortcutRegisterFailedBody":
    "{accelerator} is already in use by another app. Choose a different combination.",
  "startupTab.launchSectionTitle": "Launch at startup",
  "startupTab.launchSectionDesc":
    "Control whether LVIS starts automatically when you sign in to your computer.",
  "startupTab.launchAtStartupLabel": "Launch LVIS at login",
  "startupTab.launchAtStartupHint": "Start LVIS automatically after you sign in. (Installed app only.)",
  "startupTab.launchMinimizedLabel": "Start hidden in the tray",
  "startupTab.launchMinimizedHint": "When launching at login, start minimized to the tray without opening a window.",
  "startupTab.launchRegisterFailedTitle": "Launch at startup could not be applied",
  "startupTab.launchRegisterFailedBody":
    "LVIS could not register itself to launch at login on this system. Open Settings to try again.",
} as const;

/**
 * Union of the *seed* (hand-curated, common) translation keys. The full app
 * key space is `string` (see {@link ./index.MessageKey}) because per-surface
 * keys are merged in from generated fragments; this strict type just keeps the
 * Korean seed catalog ({@link ./ko}) in lockstep with the English seed.
 */
export type SeedMessageKey = keyof typeof en;
