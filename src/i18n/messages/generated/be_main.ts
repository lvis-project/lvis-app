// AUTO-GENERATED — i18n migration. Source: src/main.ts. Do not edit by hand.
export const en = {
  // marketplacePackageLabel
  "be_main.labelAgent": "Agent",
  "be_main.labelSkill": "Skill",
  "be_main.labelMcpServer": "MCP Server",
  "be_main.labelPlugin": "Plugin",

  // dialog buttons
  "be_main.btnOk": "OK",
  "be_main.btnRemove": "Remove",
  "be_main.btnCancel": "Cancel",
  "be_main.btnInstall": "Install",
  "be_main.btnInstallAndOpenSettings": "Install and Open Settings",

  // handleAssistantMarketplaceAction / handleMcpMarketplaceAction dialogs
  "be_main.packageNotInstalledMsg": "{label} '{name}' is not installed.",
  "be_main.packageNotInstalledDetail": "The removal request from an external link was not processed.",
  "be_main.packageUninstallMsg": "Remove {label} '{name}'?",
  "be_main.packageUninstallDetail": "This removal was requested via an external link.",
  "be_main.packageInstallMsg": "Install {label} '{name}'?",
  "be_main.packageInstallDetail": "This installation was requested via an external link.",

  // handleMcpLoginAction dialog
  "be_main.mcpLoginPrepareMsg": "Prepare login for MCP '{name}'?",
  "be_main.mcpLoginPrepareDetail": "The MCP server will be installed and its connection settings registered before OAuth login. Tokens or authorization codes are not stored in the marketplace manifest.",

  // handleLvisUri — managed plugin uninstall dialogs
  "be_main.pluginManagedCannotRemoveMsg": "Plugin '{name}' cannot be removed.",
  "be_main.pluginManagedCannotRemoveDetail": "Plugins installed by an administrator cannot be removed by user request.",
  "be_main.pluginNotInstalledMsg": "Plugin '{name}' is not installed.",
  "be_main.pluginNotInstalledDetail": "The removal request from an external link was not processed.",
  "be_main.pluginUninstallMsg": "Remove plugin '{name}'?",
  "be_main.pluginUninstallDetail": "This removal was requested via an external link. Plugin files, local data, settings, stored secrets, and recorded login sessions will be deleted.",
  "be_main.pluginInstallMsg": "Install plugin '{slug}'?",
  "be_main.pluginInstallDetail": "This installation was requested via an external link.",

  // createViewMenu / menu labels
  "be_main.menuPlugins": "Plugins",
  "be_main.menuHome": "Home",
  "be_main.menuSettings": "Settings...",
  "be_main.menuOpenLvis": "Open LVIS",
  "be_main.menuQuit": "Quit",
  "be_main.menuAlwaysOnTop": "Always on Top",
  "be_main.menuView": "View",
  "be_main.menuHelp": "Help",
  "be_main.menuEdit": "Edit",
  "be_main.menuUndo": "Undo",
  "be_main.menuRedo": "Redo",
  "be_main.menuCut": "Cut",
  "be_main.menuCopy": "Copy",
  "be_main.menuPaste": "Paste",
  "be_main.menuPasteAndMatchStyle": "Paste and Match Style",
  "be_main.menuDelete": "Delete",
  "be_main.menuSelectAll": "Select All",
  "be_main.menuApp": "App",

  // settings window title
  "be_main.settingsWindowTitle": "LVIS Settings",

  // bootstrap status messages
  "be_main.bootstrapStatus0": "Preparing runtime...",
  "be_main.bootstrapStatus1": "Loading user settings and memory...",
  "be_main.bootstrapStatus2": "Verifying plugin integrity...",
  "be_main.bootstrapStatus3": "Syncing with marketplace...",
  "be_main.bootstrapStatus4": "Opening workspace...",

  // splash status updates in main()
  "be_main.splashCheckingCerts": "Checking network certificates...",
  "be_main.splashLoadingSettings": "Loading user settings and memory...",
  "be_main.splashOpeningWorkspace": "Opening workspace...",

  // splash HTML aria-label
  "be_main.splashVersionLabel": "Version information",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_main.labelAgent": "에이전트",
  "be_main.labelSkill": "스킬",
  "be_main.labelMcpServer": "MCP 서버",
  "be_main.labelPlugin": "플러그인",

  "be_main.btnOk": "확인",
  "be_main.btnRemove": "제거",
  "be_main.btnCancel": "취소",
  "be_main.btnInstall": "설치",
  "be_main.btnInstallAndOpenSettings": "설치 후 설정 열기",

  "be_main.packageNotInstalledMsg": "{label} '{name}'은(는) 설치되어 있지 않습니다.",
  "be_main.packageNotInstalledDetail": "외부 링크의 제거 요청을 처리하지 않았습니다.",
  "be_main.packageUninstallMsg": "{label} '{name}'을(를) 제거하시겠습니까?",
  "be_main.packageUninstallDetail": "외부 링크로부터 요청된 제거입니다.",
  "be_main.packageInstallMsg": "{label} '{name}'을(를) 설치하시겠습니까?",
  "be_main.packageInstallDetail": "외부 링크로부터 요청된 설치입니다.",

  "be_main.mcpLoginPrepareMsg": "MCP '{name}' 로그인을 준비하시겠습니까?",
  "be_main.mcpLoginPrepareDetail": "OAuth 로그인을 위해 먼저 MCP 서버를 설치하고 연결 설정을 등록합니다. 토큰이나 인증 코드는 마켓플레이스 manifest에 저장되지 않습니다.",

  "be_main.pluginManagedCannotRemoveMsg": "플러그인 '{name}'은(는) 제거할 수 없습니다.",
  "be_main.pluginManagedCannotRemoveDetail": "관리자가 설치한 플러그인은 사용자 요청으로 제거할 수 없습니다.",
  "be_main.pluginNotInstalledMsg": "플러그인 '{name}'은(는) 설치되어 있지 않습니다.",
  "be_main.pluginNotInstalledDetail": "외부 링크의 제거 요청을 처리하지 않았습니다.",
  "be_main.pluginUninstallMsg": "플러그인 '{name}'을(를) 제거하시겠습니까?",
  "be_main.pluginUninstallDetail": "외부 링크로부터 요청된 제거입니다. 플러그인 파일, 로컬 데이터, 설정, 저장된 비밀값, 기록된 로그인 세션이 삭제됩니다.",
  "be_main.pluginInstallMsg": "플러그인 '{slug}'을(를) 설치하시겠습니까?",
  "be_main.pluginInstallDetail": "외부 링크로부터 요청된 설치입니다.",

  "be_main.menuPlugins": "플러그인",
  "be_main.menuHome": "홈",
  "be_main.menuSettings": "설정...",
  "be_main.menuOpenLvis": "LVIS 열기",
  "be_main.menuQuit": "종료",
  "be_main.menuAlwaysOnTop": "항상 위에",
  "be_main.menuView": "보기",
  "be_main.menuHelp": "도움말",
  "be_main.menuEdit": "편집",
  "be_main.menuUndo": "실행 취소",
  "be_main.menuRedo": "다시 실행",
  "be_main.menuCut": "잘라내기",
  "be_main.menuCopy": "복사",
  "be_main.menuPaste": "붙여넣기",
  "be_main.menuPasteAndMatchStyle": "서식 없이 붙여넣기",
  "be_main.menuDelete": "삭제",
  "be_main.menuSelectAll": "전체 선택",
  "be_main.menuApp": "앱",

  "be_main.settingsWindowTitle": "LVIS 설정",

  "be_main.bootstrapStatus0": "런타임을 준비하는 중...",
  "be_main.bootstrapStatus1": "사용자 설정과 메모리를 불러오는 중...",
  "be_main.bootstrapStatus2": "플러그인 무결성을 확인하는 중...",
  "be_main.bootstrapStatus3": "마켓플레이스와 동기화하는 중...",
  "be_main.bootstrapStatus4": "작업 화면을 여는 중...",

  "be_main.splashCheckingCerts": "네트워크 인증서를 확인하는 중...",
  "be_main.splashLoadingSettings": "사용자 설정과 메모리를 불러오는 중...",
  "be_main.splashOpeningWorkspace": "작업 화면을 여는 중...",

  "be_main.splashVersionLabel": "버전 정보",
};
