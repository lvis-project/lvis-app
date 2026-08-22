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
  "mainDialog.pluginDisableNotPermitted": "Dieses Plugin wird von Ihrer Organisation verwaltet und kann nicht deaktiviert werden.",
  "mainDialog.noPersonasAvailable": "Keine Personas verfügbar",
  "mainDialog.exportConversationTitle": "Konversation exportieren",
  "mainDialog.importConversationTitle": "Konversation importieren",

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
  "startupTab.renderingSectionTitle":
    "Darstellung",
  "startupTab.renderingSectionDesc":
    "Legt fest, ob LVIS die Grafikkarte zum Zeichnen der Oberfläche verwendet.",
  "startupTab.hardwareAccelerationLabel":
    "Hardwarebeschleunigung verwenden",
  "startupTab.hardwareAccelerationHelp":
    "Wird beim nächsten Start von LVIS wirksam. Schalten Sie sie aus, wenn das Fenster schwarz bleibt, flackert oder die App beim Zeichnen abstürzt — auf manchen verwalteten Rechnern und virtuellen Desktops kommen die Grafiktreiber damit nicht zurecht. Deshalb ist sie unter Windows und Linux standardmäßig aus.",
  "startupTab.hardwareAccelerationEnvForced":
    "Die Umgebungsvariable {envVar} schaltet dies derzeit ein, unabhängig vom hier gespeicherten Wert.",
  "startupTab.corpCaSectionTitle":
    "Unternehmenszertifikat",
  "startupTab.corpCaSectionDesc":
    "Für Netzwerke, die den TLS-Verkehr mit einem firmeneigenen Stammzertifikat aufbrechen.",
  "startupTab.corpCaEnabledLabel":
    "Stammzertifikat des Unternehmens vertrauen",
  "startupTab.corpCaEnabledHelp":
    "Wird beim nächsten Start von LVIS wirksam. Beim Surfen vertraut LVIS den Zertifikaten des Betriebssystems, aber Modellaufrufe, Marketplace-Anfragen und Update-Prüfungen prüfen getrennt und tun das nicht. In einem Netzwerk, das den TLS-Verkehr aufbricht, scheitern genau diese mit einem Zertifikatsfehler, während normale Seiten laden; das behebt es. Lassen Sie es im Zweifel an -- auf einem Rechner ohne ein solches Zertifikat findet es nichts und ändert nichts.",
  "startupTab.corpCaEnabledEnvForced":
    "Die Umgebungsvariable {envVar} schaltet dies derzeit aus, unabhängig vom hier gespeicherten Wert.",
  "startupTab.corpCaCommonNameLabel":
    "Zertifikatsname",
  "startupTab.corpCaCommonNameHelp":
    "Der Common Name (CN) des Stammzertifikats Ihres Unternehmens, so wie er im Systemzertifikatspeicher steht. Der Standardwert unten ist nur ein Platzhalter -- fragen Sie Ihre IT-Abteilung nach dem echten Namen, wenn weiterhin Zertifikatsfehler auftreten. Ein Namensteil genügt.",
  "startupTab.corpCaCommonNameEnvForced":
    "Die Umgebungsvariable {envVar} liefert diesen Namen gerade anstelle des hier gespeicherten Werts.",
  "startupTab.corpCaDebugLabel":
    "Details der Zertifikatssuche protokollieren",
  "startupTab.corpCaDebugHelp":
    "Schreibt in das Anwendungsprotokoll, wonach gesucht und was gefunden wurde. Nur zur Diagnose eines Zertifikatsproblems einschalten.",
  "startupTab.corpCaDebugEnvForced":
    "Die Umgebungsvariable {envVar} schaltet dies derzeit ein, unabhängig vom hier gespeicherten Wert.",
  "startupTab.launchSectionTitle": "Beim Start ausführen",
  "startupTab.launchSectionDesc":
    "Legt fest, ob LVIS automatisch startet, wenn du dich an deinem Computer anmeldest.",
  "startupTab.launchAtStartupLabel": "LVIS beim Anmelden starten",
  "startupTab.launchAtStartupHint": "LVIS nach der Anmeldung automatisch starten. (Nur installierte App.)",
  "startupTab.launchMinimizedLabel": "Versteckt im Infobereich starten",
  "startupTab.launchMinimizedHint": "Beim Start mit der Anmeldung minimiert im Infobereich starten, ohne ein Fenster zu öffnen.",
  "startupTab.launchRegisterFailedTitle": "Start beim Anmelden konnte nicht angewendet werden",
  "startupTab.shutdownTimeoutLabel":
    "Zeit für die Bereinigung beim Beenden",
  "startupTab.shutdownTimeoutHelp":
    "Beim Beenden stoppt LVIS seine Routinen, Plug-ins und Hintergrundprozesse und speichert die Fensteranordnung, bevor es schließt. Ist das innerhalb dieser Zeit nicht abgeschlossen, schließt es trotzdem, und noch nicht Geschriebenes geht verloren. Erhöhe den Wert, wenn ein Plug-in länger zum Herunterfahren braucht; verringere ihn, wenn sich das Beenden langsam anfühlt.",
  "startupTab.shutdownTimeoutEnvForced":
    "Die Umgebungsvariable {envVar} liefert diesen Wert gerade, anstelle des hier gespeicherten Werts.",
  "startupTab.shutdownTimeoutSeconds": "{seconds} Sekunden",
  "startupTab.shutdownTimeoutSecondsDefault": "{seconds} Sekunden (Standard)",
  "startupTab.launchRegisterFailedBody":
    "LVIS konnte den Start bei der Anmeldung auf diesem System nicht registrieren. Öffne die Einstellungen, um es erneut zu versuchen.",
};
