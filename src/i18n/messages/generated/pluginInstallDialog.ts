// Source: src/ui/renderer/dialogs/PluginInstallDialog.tsx
// Seeded by the i18n migration; admin-consent keys (#1098) added by hand.
export const en = {
  "pluginInstallDialog.title": "Install Plugin",
  "pluginInstallDialog.confirmInstall": "Install '{name}'?",
  "pluginInstallDialog.cancel": "Cancel",
  "pluginInstallDialog.install": "Install",
  "pluginInstallDialog.adminTitle": "Administrator plugin install",
  "pluginInstallDialog.adminWarning":
    "'{name}' is an administrator-policy plugin. Installing it grants this plugin system-wide administrator privileges. Only continue if you trust its source.",
  "pluginInstallDialog.adminConsent": "I understand this grants administrator privileges.",
  "pluginInstallDialog.adminInstall": "Install with admin access",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "pluginInstallDialog.title": "플러그인 설치",
  "pluginInstallDialog.confirmInstall": "'{name}' 설치?",
  "pluginInstallDialog.cancel": "취소",
  "pluginInstallDialog.install": "설치",
  "pluginInstallDialog.adminTitle": "관리자 권한 플러그인 설치",
  "pluginInstallDialog.adminWarning":
    "'{name}' 은(는) 관리자 정책 플러그인입니다. 설치하면 이 플러그인에 시스템 전역 관리자 권한이 부여됩니다. 출처를 신뢰하는 경우에만 계속하세요.",
  "pluginInstallDialog.adminConsent": "이 플러그인에 관리자 권한이 부여됨을 이해했습니다.",
  "pluginInstallDialog.adminInstall": "관리자 권한으로 설치",
};
