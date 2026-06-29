/**
 * Japanese message catalog. Mirrors every key in ./en.
 */
import type { SeedMessageKey } from "./en.js";

export const ja: Record<SeedMessageKey, string> = {
  // Common / shared
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
  "common.thinking": "思考中…",

  // Settings > Appearance > Language
  "settings.appearance.language.title": "言語",
  "settings.appearance.language.description":
    "アプリ全体で使用する言語を選択します。変更はすぐに適用されます。",
  "settings.appearance.language.saved": "言語を更新しました。",

  // Main-process dialogs / menus / notifications
  "mainDialog.restart": "再起動",
  "mainDialog.updateApplyTitle": "アップデートを適用",
  "mainDialog.updateRestartMessage": "LVIS は v{version} に再起動します。",
  "mainDialog.updateRestartDetail": "進行中の作業は終了します。続行しますか？",
  "mainDialog.attachTitle": "添付ファイルを選択",
  "mainDialog.installLocalPluginTitle": "ローカルプラグインをインストール (開発者)",
  "mainDialog.installLocalPluginMessage": "plugin.json を含むビルドフォルダーを選択してください",
  "mainDialog.unauthorizedFrame": "許可されていないフレームです。",
  "mainDialog.noPersonasAvailable": "利用可能な persona はありません",
  "mainDialog.exportConversationTitle": "会話をエクスポート",
};
