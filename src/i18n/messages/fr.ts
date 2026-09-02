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
  "mainDialog.pluginPickFolderTitle": "Sélectionner des dossiers pour {plugin}",
  "mainDialog.installLocalPluginTitle": "Installer un plugin local (développeur)",
  "mainDialog.installLocalPluginMessage": "Sélectionnez le dossier de build contenant plugin.json",
  "mainDialog.unauthorizedFrame": "Cadre non autorisé.",
  "mainDialog.pluginDisableNotPermitted": "Ce plugin est géré par votre organisation et ne peut pas être désactivé.",
  "mainDialog.exportConversationTitle": "Exporter la conversation",
  "mainDialog.deleteConversationMessage": "Supprimer cette conversation ?",
  "mainDialog.deleteConversationDetail": "La transcription et ses points de contrôle sont supprimés du disque. Cette action est irréversible.",
  "mainDialog.deleteConversationConfirm": "Supprimer",
  "mainDialog.cancelButton": "Annuler",
  "mainDialog.importConversationTitle": "Importer la conversation",

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
  "startupTab.renderingSectionTitle":
    "Rendu",
  "startupTab.renderingSectionDesc":
    "Détermine si LVIS utilise la carte graphique pour dessiner l'interface.",
  "startupTab.hardwareAccelerationLabel":
    "Utiliser l'accélération matérielle",
  "startupTab.hardwareAccelerationHelp":
    "Prend effet au prochain démarrage de LVIS. Désactivez-la si la fenêtre reste noire, scintille ou si l'application se ferme pendant l'affichage : sur certains postes gérés et bureaux virtuels, les pilotes graphiques ne la prennent pas en charge. C'est pourquoi elle est désactivée par défaut sous Windows et Linux.",
  "startupTab.hardwareAccelerationEnvForced":
    "La variable d'environnement {envVar} active actuellement cette option, quelle que soit la valeur enregistrée ici.",
  "startupTab.corpCaSectionTitle":
    "Certificat du réseau d'entreprise",
  "startupTab.corpCaSectionDesc":
    "Pour les réseaux qui inspectent le trafic TLS à l'aide d'un certificat racine fourni par l'entreprise.",
  "startupTab.corpCaEnabledLabel":
    "Faire confiance au certificat racine de l'entreprise",
  "startupTab.corpCaEnabledHelp":
    "Prend effet au prochain démarrage de LVIS. Pour la navigation, LVIS fait confiance aux certificats approuvés par le système d'exploitation, mais les appels au modèle, les requêtes vers la place de marché et les vérifications de mise à jour sont vérifiés séparément et ne le font pas. Sur un réseau qui inspecte le trafic TLS, ce sont précisément ceux-là qui échouent avec une erreur de certificat alors que les pages ordinaires s'affichent ; c'est ce que cette option corrige. Laissez-la activée en cas de doute : sur un poste sans un tel certificat, elle ne trouve rien et ne change rien.",
  "startupTab.corpCaEnabledEnvForced":
    "La variable d'environnement {envVar} désactive actuellement cette option, quelle que soit la valeur enregistrée ici.",
  "startupTab.corpCaCommonNameLabel":
    "Nom du certificat",
  "startupTab.corpCaCommonNameHelp":
    "Le nom commun (CN) du certificat racine de votre entreprise, tel qu'il figure dans le magasin de confiance du système. La valeur par défaut ci-dessous n'est qu'un exemple : demandez le nom réel à votre service informatique si les erreurs de certificat persistent. Une partie du nom suffit.",
  "startupTab.corpCaCommonNameEnvForced":
    "La variable d'environnement {envVar} fournit actuellement ce nom, à la place de la valeur enregistrée ici.",
  "startupTab.corpCaDebugLabel":
    "Journaliser le détail de la recherche de certificat",
  "startupTab.corpCaDebugHelp":
    "Écrit dans le journal de l'application ce qui a été recherché et ce qui a été trouvé. À n'activer que pendant le diagnostic d'un problème de certificat.",
  "startupTab.corpCaDebugEnvForced":
    "La variable d'environnement {envVar} active actuellement cette option, quelle que soit la valeur enregistrée ici.",
  "startupTab.launchSectionTitle": "Lancer au démarrage",
  "startupTab.launchSectionDesc":
    "Détermine si LVIS démarre automatiquement lorsque vous vous connectez à votre ordinateur.",
  "startupTab.launchAtStartupLabel": "Lancer LVIS à la connexion",
  "startupTab.launchAtStartupHint": "Démarrer LVIS automatiquement après votre connexion. (Application installée uniquement.)",
  "startupTab.launchMinimizedLabel": "Démarrer masqué dans la barre d'état",
  "startupTab.launchMinimizedHint": "Au lancement à la connexion, démarrer réduit dans la barre d'état sans ouvrir de fenêtre.",
  "startupTab.launchRegisterFailedTitle": "Impossible d'appliquer le lancement au démarrage",
  "startupTab.shutdownTimeoutLabel":
    "Temps alloué au nettoyage à la fermeture",
  "startupTab.shutdownTimeoutHelp":
    "À la fermeture, LVIS arrête ses routines, ses extensions et ses processus en arrière-plan, puis enregistre la disposition des fenêtres avant de se fermer. Si cela n'est pas terminé dans ce délai, l'application se ferme quand même et ce qui était en cours d'écriture est abandonné. Augmentez-le si une extension a besoin de plus de temps pour s'arrêter ; réduisez-le si la fermeture vous semble lente.",
  "startupTab.shutdownTimeoutEnvForced":
    "La variable d'environnement {envVar} fournit actuellement cette valeur, à la place de celle enregistrée ici.",
  "startupTab.shutdownTimeoutSeconds": "{seconds} secondes",
  "startupTab.shutdownTimeoutSecondsDefault": "{seconds} secondes (par défaut)",
  "startupTab.launchRegisterFailedBody":
    "LVIS n'a pas pu s'enregistrer pour se lancer à la connexion sur ce système. Ouvrez les paramètres pour réessayer.",
};
