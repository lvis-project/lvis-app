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

  // ── E4 — 起動 / グローバルショートカット ─────────────────────────
  "settingsContent.tabStartup": "起動",
  "startupTab.title": "起動とショートカット",
  "startupTab.description":
    "ウィンドウの表示/非表示を切り替えるグローバルショートカットを設定し、ログイン時に LVIS を起動するか選択します。",
  "startupTab.shortcutSectionTitle": "グローバルショートカット",
  "startupTab.shortcutSectionDesc":
    "どこからでも LVIS ウィンドウを表示または非表示にするシステム全体のキーの組み合わせです。",
  "startupTab.shortcutEnabledLabel": "グローバルショートカットを有効化",
  "startupTab.shortcutEnabledHint": "ショートカットをオペレーティングシステムに登録します。",
  "startupTab.shortcutAcceleratorLabel": "ウィンドウ表示/非表示のショートカット",
  "startupTab.shortcutRecord": "記録",
  "startupTab.shortcutClear": "クリア",
  "startupTab.shortcutCapturing": "キーの組み合わせを押してください…",
  "startupTab.shortcutUnset": "未設定",
  "startupTab.shortcutEnabledNoAccelerator":
    "ショートカットは有効ですが、キーの組み合わせが設定されていません。記録して有効化してください。",
  "startupTab.shortcutRegisterFailedTitle": "ショートカットの登録に失敗しました",
  "startupTab.shortcutRegisterFailedBody":
    "{accelerator} は他のアプリで使用中です。別の組み合わせを選択してください。",
  "startupTab.launchSectionTitle": "起動時に自動実行",
  "startupTab.launchSectionDesc":
    "コンピューターにサインインしたときに LVIS を自動的に起動するかを設定します。",
  "startupTab.launchAtStartupLabel": "ログイン時に LVIS を起動",
  "startupTab.launchAtStartupHint": "サインイン後に LVIS を自動的に起動します。（インストール済みアプリのみ）",
  "startupTab.launchMinimizedLabel": "トレイに隠して起動",
  "startupTab.launchMinimizedHint": "ログイン時の起動でウィンドウを開かず、トレイに最小化した状態で起動します。",
};
