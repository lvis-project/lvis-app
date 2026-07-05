/**
 * French message catalog. Mirrors every key in ./en.
 */
import type { SeedMessageKey } from "./en.js";

export const fr: Record<SeedMessageKey, string> = {
  "common.cancel": "Annuler",
  "common.allow": "Autoriser",
  "common.confirm": "Confirmer",
  "common.ok": "OK",
  "common.save": "Enregistrer",
  "common.close": "Fermer",
  "common.delete": "Supprimer",
  "common.remove": "Retirer",
  "common.retry": "Réessayer",
  "common.loading": "Chargement…",
  "common.error": "Erreur",
  "common.thinking": "Réflexion…",
  "settings.appearance.language.title": "Langue",
  "settings.appearance.language.description": "Choisissez la langue utilisée dans toute l'application. Les changements s'appliquent immédiatement.",
  "settings.appearance.language.saved": "Langue mise à jour.",
  "mainDialog.restart": "Redémarrer",
  "mainDialog.updateApplyTitle": "Appliquer la mise à jour",
  "mainDialog.updateRestartMessage": "LVIS va redémarrer vers v{version}.",
  "mainDialog.updateRestartDetail": "Le travail en cours se terminera. Voulez-vous continuer ?",
  "mainDialog.attachTitle": "Sélectionner des fichiers joints",
  "mainDialog.installLocalPluginTitle": "Installer un plugin local (développeur)",
  "mainDialog.installLocalPluginMessage": "Sélectionnez le dossier de build contenant plugin.json",
  "mainDialog.unauthorizedFrame": "Cadre non autorisé.",
  "mainDialog.noPersonasAvailable": "Aucune persona disponible",
  "mainDialog.exportConversationTitle": "Exporter la conversation",

  // ── E4 — Démarrage / raccourcis globaux ───────────────────────────
  "settingsContent.tabStartup": "Démarrage",
  "startupTab.title": "Démarrage et raccourcis",
  "startupTab.description":
    "Définissez un raccourci global pour afficher/masquer la fenêtre et choisissez si LVIS démarre à la connexion.",
  "startupTab.shortcutSectionTitle": "Raccourci global",
  "startupTab.shortcutSectionDesc":
    "Une combinaison de touches à l'échelle du système qui affiche ou masque la fenêtre LVIS depuis n'importe où.",
  "startupTab.shortcutEnabledLabel": "Activer le raccourci global",
  "startupTab.shortcutEnabledHint": "Enregistrer le raccourci auprès du système d'exploitation.",
  "startupTab.shortcutAcceleratorLabel": "Raccourci afficher/masquer la fenêtre",
  "startupTab.shortcutRecord": "Enregistrer",
  "startupTab.shortcutClear": "Effacer",
  "startupTab.shortcutCapturing": "Appuyez sur une combinaison de touches…",
  "startupTab.shortcutUnset": "Non défini",
  "startupTab.shortcutEnabledNoAccelerator":
    "Le raccourci est activé mais aucune combinaison n'est définie. Enregistrez-en une pour l'activer.",
  "startupTab.shortcutRegisterFailedTitle": "Échec de l'enregistrement du raccourci",
  "startupTab.shortcutRegisterFailedBody":
    "{accelerator} est déjà utilisé par une autre application. Choisissez une autre combinaison.",
  "startupTab.launchSectionTitle": "Lancer au démarrage",
  "startupTab.launchSectionDesc":
    "Détermine si LVIS démarre automatiquement lorsque vous vous connectez à votre ordinateur.",
  "startupTab.launchAtStartupLabel": "Lancer LVIS à la connexion",
  "startupTab.launchAtStartupHint": "Démarrer LVIS automatiquement après votre connexion. (Application installée uniquement.)",
  "startupTab.launchMinimizedLabel": "Démarrer masqué dans la barre d'état",
  "startupTab.launchMinimizedHint": "Au lancement à la connexion, démarrer réduit dans la barre d'état sans ouvrir de fenêtre.",
  "startupTab.launchRegisterFailedTitle": "Impossible d'appliquer le lancement au démarrage",
  "startupTab.launchRegisterFailedBody":
    "LVIS n'a pas pu s'enregistrer pour se lancer à la connexion sur ce système. Ouvrez les paramètres pour réessayer.",
};
