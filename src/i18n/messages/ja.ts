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
  "mainDialog.pluginPickFolderTitle": "{plugin} で使用するフォルダーを選択",
  "mainDialog.installLocalPluginTitle": "ローカルプラグインをインストール (開発者)",
  "mainDialog.installLocalPluginMessage": "plugin.json を含むビルドフォルダーを選択してください",
  "mainDialog.unauthorizedFrame": "許可されていないフレームです。",
  "mainDialog.pluginDisableNotPermitted": "このプラグインは組織によって管理されているため、無効にできません。",
  "mainDialog.exportConversationTitle": "会話をエクスポート",
  "mainDialog.deleteConversationMessage": "この会話を削除しますか？",
  "mainDialog.deleteConversationDetail": "トランスクリプトとチェックポイントがディスクから削除されます。元に戻せません。",
  "mainDialog.deleteConversationConfirm": "削除",
  "mainDialog.cancelButton": "キャンセル",
  "mainDialog.importConversationTitle": "会話をインポート",

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
  "startupTab.renderingSectionTitle":
    "画面描画",
  "startupTab.renderingSectionDesc":
    "LVIS が画面を描画する際にグラフィックカードを使うかどうかを設定します。",
  "startupTab.hardwareAccelerationLabel":
    "ハードウェアアクセラレーションを使う",
  "startupTab.hardwareAccelerationHelp":
    "次回 LVIS を起動したときから適用されます。ウィンドウが真っ黒になる、ちらつく、描画中にアプリが落ちる場合はオフにしてください — 管理された PC や仮想デスクトップのグラフィックドライバーでは動作しないことがあります。そのため Windows と Linux では既定でオフです。",
  "startupTab.hardwareAccelerationEnvForced":
    "環境変数 {envVar} が、ここに保存された値に関係なくこの項目をオンにしています。",
  "startupTab.corpCaSectionTitle":
    "社内ネットワーク証明書",
  "startupTab.corpCaSectionDesc":
    "会社が発行したルート証明書で TLS 通信を検査するネットワーク向けの設定です。",
  "startupTab.corpCaEnabledLabel":
    "社内ルート証明書を信頼する",
  "startupTab.corpCaEnabledHelp":
    "次回 LVIS を起動したときから適用されます。ウェブページの表示では OS が信頼する証明書をそのまま使いますが、モデル呼び出し・マーケットプレイスへの要求・更新確認は別に検証するため使いません。TLS 通信を検査するネットワークでは、ページは開けるのにこれらだけが証明書エラーで失敗します。この設定がその問題を解消します。迷う場合はオンのままで構いません — そうした証明書がない PC では何も見つからず、何も変わりません。",
  "startupTab.corpCaEnabledEnvForced":
    "環境変数 {envVar} が、ここに保存された値に関係なくこの項目をオフにしています。",
  "startupTab.corpCaCommonNameLabel":
    "証明書の名前",
  "startupTab.corpCaCommonNameHelp":
    "システムの証明書ストアに登録されている社内ルート証明書のコモンネーム (CN) です。下の既定値は仮の名前なので、証明書エラーが続く場合は社内の IT 担当者に実際の名前を確認してください。名前の一部でも一致します。",
  "startupTab.corpCaCommonNameEnvForced":
    "環境変数 {envVar} が、ここに保存された値の代わりにこの名前を指定しています。",
  "startupTab.corpCaDebugLabel":
    "証明書の検索内容をログに残す",
  "startupTab.corpCaDebugHelp":
    "何を検索し何が見つかったかをアプリケーションログに書き出します。証明書の問題を調べるときだけオンにしてください。",
  "startupTab.corpCaDebugEnvForced":
    "環境変数 {envVar} が、ここに保存された値に関係なくこの項目をオンにしています。",
  "startupTab.launchSectionTitle": "起動時に自動実行",
  "startupTab.launchSectionDesc":
    "コンピューターにサインインしたときに LVIS を自動的に起動するかを設定します。",
  "startupTab.launchAtStartupLabel": "ログイン時に LVIS を起動",
  "startupTab.launchAtStartupHint": "サインイン後に LVIS を自動的に起動します。（インストール済みアプリのみ）",
  "startupTab.launchMinimizedLabel": "トレイに隠して起動",
  "startupTab.launchMinimizedHint": "ログイン時の起動でウィンドウを開かず、トレイに最小化した状態で起動します。",
  "startupTab.launchRegisterFailedTitle": "起動時の自動実行を適用できませんでした",
  "startupTab.shutdownTimeoutLabel":
    "終了時のクリーンアップに許可する時間",
  "startupTab.shutdownTimeoutHelp":
    "終了すると LVIS はルーチン、プラグイン、バックグラウンドプロセスを停止し、ウィンドウ配置を保存してから閉じます。この時間内に終わらない場合はそのまま閉じ、書き込み中だった内容は破棄されます。停止に時間がかかるプラグインがある場合は長く、終了が遅く感じる場合は短くしてください。",
  "startupTab.shutdownTimeoutEnvForced":
    "現在は環境変数 {envVar} がこの値を指定しており、ここに保存された値の代わりに使用されます。",
  "startupTab.shutdownTimeoutSeconds": "{seconds} 秒",
  "startupTab.shutdownTimeoutSecondsDefault": "{seconds} 秒 (既定)",
  "startupTab.launchRegisterFailedBody":
    "このシステムでログイン時の自動起動を登録できませんでした。設定から再試行してください。",
};
