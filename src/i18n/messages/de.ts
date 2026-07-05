/**
 * German message catalog. Mirrors every key in ./en.
 */
import type { SeedMessageKey } from "./en.js";

export const de: Record<SeedMessageKey, string> = {
  "common.cancel": "Abbrechen",
  "common.allow": "Zulassen",
  "common.confirm": "Bestätigen",
  "common.ok": "OK",
  "common.save": "Speichern",
  "common.close": "Schließen",
  "common.delete": "Löschen",
  "common.remove": "Entfernen",
  "common.retry": "Erneut versuchen",
  "common.loading": "Wird geladen…",
  "common.error": "Fehler",
  "common.thinking": "Denkt nach…",
  "settings.appearance.language.title": "Sprache",
  "settings.appearance.language.description": "Wähle die Sprache für die gesamte App. Änderungen werden sofort angewendet.",
  "settings.appearance.language.saved": "Sprache aktualisiert.",
  "mainDialog.restart": "Neu starten",
  "mainDialog.updateApplyTitle": "Update anwenden",
  "mainDialog.updateRestartMessage": "LVIS wird mit v{version} neu gestartet.",
  "mainDialog.updateRestartDetail": "Laufende Arbeit wird beendet. Möchtest du fortfahren?",
  "mainDialog.attachTitle": "Anhangsdateien auswählen",
  "mainDialog.installLocalPluginTitle": "Lokales Plugin installieren (Entwickler)",
  "mainDialog.installLocalPluginMessage": "Wähle den Build-Ordner aus, der plugin.json enthält",
  "mainDialog.unauthorizedFrame": "Nicht autorisierter Frame.",
  "mainDialog.noPersonasAvailable": "Keine Personas verfügbar",
  "mainDialog.exportConversationTitle": "Konversation exportieren",

  // ── E4 — Start / globale Tastenkürzel ─────────────────────────────
  "settingsContent.tabStartup": "Start",
  "startupTab.title": "Start & Tastenkürzel",
  "startupTab.description":
    "Lege ein globales Tastenkürzel zum Ein-/Ausblenden des Fensters fest und wähle, ob LVIS beim Anmelden startet.",
  "startupTab.shortcutSectionTitle": "Globales Tastenkürzel",
  "startupTab.shortcutSectionDesc":
    "Eine systemweite Tastenkombination, die das LVIS-Fenster von überall ein- oder ausblendet.",
  "startupTab.shortcutEnabledLabel": "Globales Tastenkürzel aktivieren",
  "startupTab.shortcutEnabledHint": "Das Tastenkürzel beim Betriebssystem registrieren.",
  "startupTab.shortcutAcceleratorLabel": "Tastenkürzel zum Ein-/Ausblenden des Fensters",
  "startupTab.shortcutRecord": "Aufnehmen",
  "startupTab.shortcutClear": "Löschen",
  "startupTab.shortcutCapturing": "Drücke eine Tastenkombination…",
  "startupTab.shortcutUnset": "Nicht festgelegt",
  "startupTab.shortcutEnabledNoAccelerator":
    "Das Tastenkürzel ist aktiviert, aber keine Kombination festgelegt. Nimm eine auf, um es zu aktivieren.",
  "startupTab.shortcutRegisterFailedTitle": "Registrierung des Tastenkürzels fehlgeschlagen",
  "startupTab.shortcutRegisterFailedBody":
    "{accelerator} wird bereits von einer anderen App verwendet. Wähle eine andere Kombination.",
  "startupTab.launchSectionTitle": "Beim Start ausführen",
  "startupTab.launchSectionDesc":
    "Legt fest, ob LVIS automatisch startet, wenn du dich an deinem Computer anmeldest.",
  "startupTab.launchAtStartupLabel": "LVIS beim Anmelden starten",
  "startupTab.launchAtStartupHint": "LVIS nach der Anmeldung automatisch starten. (Nur installierte App.)",
  "startupTab.launchMinimizedLabel": "Versteckt im Infobereich starten",
  "startupTab.launchMinimizedHint": "Beim Start mit der Anmeldung minimiert im Infobereich starten, ohne ein Fenster zu öffnen.",
  "startupTab.launchRegisterFailedTitle": "Start beim Anmelden konnte nicht angewendet werden",
  "startupTab.launchRegisterFailedBody":
    "LVIS konnte den Start bei der Anmeldung auf diesem System nicht registrieren. Öffne die Einstellungen, um es erneut zu versuchen.",
};
