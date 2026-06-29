/**
 * Locale → message-catalog registry.
 *
 * Each locale's catalog is the union of:
 *   - the hand-curated *seed* (common keys: {@link ./en} / {@link ./ko}), and
 *   - the *generated* per-surface fragments ({@link ./generated}), produced by
 *     the i18n migration and assembled by `scripts/i18n-build-catalog.mjs`.
 *
 * Generated entries override seed entries on key collision (the surface-
 * specific text wins), though namespacing keeps collisions out of practice.
 */
import type { Locale } from "../locale.js";
import { en } from "./en.js";
import { ko } from "./ko.js";
import { generatedEn, generatedKo } from "./generated/index.js";

const englishFallbackMessages: Messages = { ...en, ...generatedEn };
const koreanMessages: Messages = { ...ko, ...generatedKo };

const ja: Messages = {
  ...englishFallbackMessages,
  "common.cancel": "キャンセル",
  "common.allow": "許可",
  "common.confirm": "確認",
  "common.ok": "OK",
  "common.save": "保存",
  "common.close": "閉じる",
  "common.delete": "削除",
  "common.remove": "削除",
  "common.retry": "再試行",
  "common.loading": "読み込み中…",
  "common.error": "エラー",
  "common.thinking": "考え中…",
  "settings.appearance.language.title": "言語",
  "settings.appearance.language.description": "アプリ全体で使用する言語を選択します。変更はすぐに反映されます。",
  "settings.appearance.language.saved": "言語を更新しました。",
  "mainDialog.restart": "再起動",
  "mainDialog.updateApplyTitle": "アップデートを適用",
  "mainDialog.updateRestartMessage": "LVIS は v{version} に再起動します。",
  "mainDialog.updateRestartDetail": "進行中の作業は終了します。続行しますか？",
  "mainDialog.attachTitle": "添付ファイルを選択",
  "mainDialog.installLocalPluginTitle": "ローカルプラグインをインストール（開発者）",
  "mainDialog.installLocalPluginMessage": "plugin.json を含むビルドフォルダを選択してください",
  "mainDialog.unauthorizedFrame": "認証されていないフレームです。",
  "mainDialog.noPersonasAvailable": "利用可能な persona はありません",
  "mainDialog.exportConversationTitle": "会話をエクスポート",
};

const zh: Messages = {
  ...englishFallbackMessages,
  "common.cancel": "取消",
  "common.allow": "允许",
  "common.confirm": "确认",
  "common.ok": "确定",
  "common.save": "保存",
  "common.close": "关闭",
  "common.delete": "删除",
  "common.remove": "移除",
  "common.retry": "重试",
  "common.loading": "正在加载…",
  "common.error": "错误",
  "common.thinking": "正在思考…",
  "settings.appearance.language.title": "语言",
  "settings.appearance.language.description": "选择整个应用使用的语言。更改会立即生效。",
  "settings.appearance.language.saved": "语言已更新。",
  "mainDialog.restart": "重新启动",
  "mainDialog.updateApplyTitle": "应用更新",
  "mainDialog.updateRestartMessage": "LVIS 将重启到 v{version}。",
  "mainDialog.updateRestartDetail": "正在进行的工作将结束。要继续吗？",
  "mainDialog.attachTitle": "选择附件文件",
  "mainDialog.installLocalPluginTitle": "安装本地插件（开发者）",
  "mainDialog.installLocalPluginMessage": "选择包含 plugin.json 的构建文件夹",
  "mainDialog.unauthorizedFrame": "未授权的框架。",
  "mainDialog.noPersonasAvailable": "没有可用的 persona",
  "mainDialog.exportConversationTitle": "导出对话",
};

const es: Messages = {
  ...englishFallbackMessages,
  "common.cancel": "Cancelar",
  "common.allow": "Permitir",
  "common.confirm": "Confirmar",
  "common.ok": "Aceptar",
  "common.save": "Guardar",
  "common.close": "Cerrar",
  "common.delete": "Eliminar",
  "common.remove": "Quitar",
  "common.retry": "Reintentar",
  "common.loading": "Cargando…",
  "common.error": "Error",
  "common.thinking": "Pensando…",
  "settings.appearance.language.title": "Idioma",
  "settings.appearance.language.description": "Elige el idioma usado en toda la app. Los cambios se aplican de inmediato.",
  "settings.appearance.language.saved": "Idioma actualizado.",
  "mainDialog.restart": "Reiniciar",
  "mainDialog.updateApplyTitle": "Aplicar actualización",
  "mainDialog.updateRestartMessage": "LVIS se reiniciará en v{version}.",
  "mainDialog.updateRestartDetail": "El trabajo en curso finalizará. ¿Quieres continuar?",
  "mainDialog.attachTitle": "Seleccionar archivos adjuntos",
  "mainDialog.installLocalPluginTitle": "Instalar plugin local (desarrollador)",
  "mainDialog.installLocalPluginMessage": "Selecciona la carpeta de build que contiene plugin.json",
  "mainDialog.unauthorizedFrame": "Marco no autorizado.",
  "mainDialog.noPersonasAvailable": "No hay personas disponibles",
  "mainDialog.exportConversationTitle": "Exportar conversación",
};

const fr: Messages = {
  ...englishFallbackMessages,
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

const de: Messages = {
  ...englishFallbackMessages,
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
};

/**
 * Any translation key. The full key space is open (`string`) because surface
 * keys are merged in from generated fragments; lookups fall back to English
 * and then to the key itself, so an unknown key is visible, never blank.
 */
export type MessageKey = string;

/** A message catalog: every key mapped to a localized string. */
export type Messages = Record<string, string>;

/** All catalogs, keyed by locale. Consumed by {@link ../translate.translate}. */
export const messages: Record<Locale, Messages> = {
  en: englishFallbackMessages,
  ko: koreanMessages,
  ja,
  zh,
  es,
  fr,
  de,
};
