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
  "mainDialog.importConversationTitle": "Konversation importieren",
};
