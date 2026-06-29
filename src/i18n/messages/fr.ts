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
};
