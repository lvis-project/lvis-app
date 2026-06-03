// AUTO-GENERATED — i18n migration. Source: src/ui/renderer/components/LoginModalConversational.tsx. Do not edit by hand.
// User-facing copy uses the enterprise "activation key" framing and deliberately
// avoids exposing internal mechanics (env var names, host-map, vendor/endpoint
// internals, wire-format prefixes) so company-provided values stay opaque.
export const en = {
  // errorMessage() — auth IPC error codes
  "loginModalConversational.errInvalidCredentials": "Your activation key was not accepted.",
  "loginModalConversational.errNoDemoKey": "Activation is not configured yet. Please contact your administrator for an activation key.",
  "loginModalConversational.errLlmKeyIssuingFailed": "An error occurred while saving your credentials. Please check disk permissions or Keychain status.",
  "loginModalConversational.errReviewerRewireFailed": "Agent sandbox initialization failed. Please try again.",
  "loginModalConversational.errEndpointUnreachable": "Cannot reach the service endpoint. Please check your VPN or network connection.",
  "loginModalConversational.errInvalidFoundryEndpoint": "The activation key's service endpoint is invalid. Please request a new key from your administrator.",
  "loginModalConversational.errMissingFoundryHostMap": "The activation key is missing required network settings. Please request a new key from your administrator.",
  "loginModalConversational.errFoundryHostMapMismatch": "The activation key's network settings are inconsistent. Please request a new key from your administrator.",
  "loginModalConversational.errInvalidFoundryHostMapTarget": "The activation key's network target is not allowed. Please request a new key from your administrator.",
  "loginModalConversational.errLoginFailed": "Sign-in failed.",

  // activationErrorMessage() — activation IPC error codes
  "loginModalConversational.activErrInvalidCode": "The activation key is invalid. Please re-check the single-line key your administrator provided.",
  "loginModalConversational.activErrNoVendor": "The activation key is incomplete. Please request a new key from your administrator.",
  "loginModalConversational.activErrInvalidVendor": "The activation key is invalid. Please request a new key from your administrator.",
  "loginModalConversational.activErrNoDemoKey": "The activation key is missing its credentials. Please request a new key from your administrator.",
  "loginModalConversational.activErrMissingFoundryEndpoint": "The activation key is missing its service endpoint. Please request a new key from your administrator.",
  "loginModalConversational.activErrInvalidFoundryEndpoint": "The activation key's service endpoint is invalid. Please request a new key from your administrator.",
  "loginModalConversational.activErrMissingFoundryHostMap": "The activation key is missing required network settings. Please request a new key from your administrator.",
  "loginModalConversational.activErrFoundryHostMapMismatch": "The activation key's network settings are inconsistent. Please request a new key from your administrator.",
  "loginModalConversational.activErrInvalidFoundryHostMapTarget": "The activation key's network target is not allowed. Please request a new key from your administrator.",
  "loginModalConversational.activErrPersistFailed": "Could not save the activation key. Please check disk space or permissions and try again.",
  "loginModalConversational.activErrUnauthorizedFrame": "Invalid request path. Please restart the app and try again.",
  "loginModalConversational.activErrActivationFailed": "Activation failed.",

  // Inline errors from useEffect / callbacks
  "loginModalConversational.relaunchRequestFailed": "Restart request failed. Please restart LVIS manually and try again.",
  "loginModalConversational.relaunchRequestError": "An error occurred during the restart request. Please restart LVIS manually and try again.",
  "loginModalConversational.errLoginProcessError": "An error occurred while signing in.",
  "loginModalConversational.errDemoStatusCheckError": "An error occurred while checking the activation status.",
  "loginModalConversational.activErrProcessError": "An error occurred while processing the activation.",
  "loginModalConversational.activationRelaunchNotice": "The app will automatically restart in 5 seconds to apply your activation. After restarting, the connection status will be verified.",

  // CHECKLIST_LINES labels
  "loginModalConversational.checklistCredentials": "Validating activation key",
  "loginModalConversational.checklistLlmKey": "Issuing credentials",
  "loginModalConversational.checklistSandbox": "Preparing sandbox…",
  "loginModalConversational.checklistSandboxDone": "Sandbox ready",

  // JSX — dialog header / session bar
  "loginModalConversational.sessionStart": "LVIS · Authentication session started",

  // JSX — greeting bubble
  "loginModalConversational.greeting": "Hello.",
  "loginModalConversational.greetingPrompt": "It looks like this is your first time with LVIS. How would you like to get started?",

  // JSX — chip 1 (activation key)
  "loginModalConversational.chip1Label": "Activate with your activation key in 30 seconds",
  "loginModalConversational.chip1Sub": "Automatic authentication · Credentials set up for you",

  // JSX — chip 2 (BYOK)
  "loginModalConversational.chip2Label": "I have my own API key",
  "loginModalConversational.chip2Sub": "Enter in Settings → LLM tab",

  // JSX — chip 3 (SSO)
  "loginModalConversational.chip3Title": "Organization SSO connection coming soon",
  "loginModalConversational.chip3Label": "Connect with organization SSO",
  "loginModalConversational.chip3Sub": "Coming soon",

  // JSX — user turn bubble
  "loginModalConversational.userTurnText": "I'll use my activation key.",

  // JSX — assistant reply bubble states
  "loginModalConversational.assistantSubmitting": "Activation complete · Starting authentication…",
  "loginModalConversational.assistantRelaunching": "Activation complete · Restarting automatically in 5 seconds to apply settings…",
  "loginModalConversational.assistantCheckingStatus": "Checking activation status…",
  "loginModalConversational.assistantPromptActivation": "Do you have an activation key from your administrator? Please paste it as a single line.",

  // JSX — activation input
  "loginModalConversational.activationInputAriaLabel": "Activation key",

  // JSX — activation buttons
  "loginModalConversational.btnWaitingRelaunch": "Waiting for restart…",
  "loginModalConversational.btnActivating": "Activating…",
  "loginModalConversational.btnActivate": "Activate →",
  "loginModalConversational.btnCancel": "Cancel",

  // JSX — footer hint
  "loginModalConversational.footerHintPre": "Click a choice above or press ",
  "loginModalConversational.footerHintPost": " key for quick selection",
} as const;
export const ko: Record<keyof typeof en, string> = {
  // errorMessage() — auth IPC error codes
  "loginModalConversational.errInvalidCredentials": "활성화 키가 승인되지 않았습니다.",
  "loginModalConversational.errNoDemoKey": "활성화가 아직 설정되지 않았습니다. 관리자에게 활성화 키를 요청해 주세요.",
  "loginModalConversational.errLlmKeyIssuingFailed": "자격증명 저장 중 오류가 발생했어요. 디스크 권한 또는 Keychain 상태를 확인해주세요.",
  "loginModalConversational.errReviewerRewireFailed": "에이전트 sandbox 초기화에 실패했습니다. 다시 시도해 주세요.",
  "loginModalConversational.errEndpointUnreachable": "서비스 엔드포인트에 연결할 수 없어요. VPN 또는 네트워크 연결을 확인해주세요.",
  "loginModalConversational.errInvalidFoundryEndpoint": "활성화 키의 서비스 엔드포인트가 올바르지 않아요. 관리자에게 새 활성화 키를 요청해 주세요.",
  "loginModalConversational.errMissingFoundryHostMap": "활성화 키에 필요한 네트워크 설정이 빠져 있어요. 관리자에게 새 활성화 키를 요청해 주세요.",
  "loginModalConversational.errFoundryHostMapMismatch": "활성화 키의 네트워크 설정이 일치하지 않아요. 관리자에게 새 활성화 키를 요청해 주세요.",
  "loginModalConversational.errInvalidFoundryHostMapTarget": "활성화 키의 네트워크 대상이 허용되지 않아요. 관리자에게 새 활성화 키를 요청해 주세요.",
  "loginModalConversational.errLoginFailed": "로그인에 실패했습니다.",

  // activationErrorMessage() — activation IPC error codes
  "loginModalConversational.activErrInvalidCode": "활성화 키가 올바르지 않아요. 관리자가 전달한 한 줄짜리 키를 다시 확인해 주세요.",
  "loginModalConversational.activErrNoVendor": "활성화 키가 완전하지 않아요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrInvalidVendor": "활성화 키가 올바르지 않아요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrNoDemoKey": "활성화 키에 자격증명이 빠져 있어요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrMissingFoundryEndpoint": "활성화 키에 서비스 엔드포인트가 빠져 있어요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrInvalidFoundryEndpoint": "활성화 키의 서비스 엔드포인트가 올바르지 않아요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrMissingFoundryHostMap": "활성화 키에 필요한 네트워크 설정이 빠져 있어요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrFoundryHostMapMismatch": "활성화 키의 네트워크 설정이 일치하지 않아요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrInvalidFoundryHostMapTarget": "활성화 키의 네트워크 대상이 허용되지 않아요. 관리자에게 새 키를 요청해 주세요.",
  "loginModalConversational.activErrPersistFailed": "활성화 키를 저장하지 못했어요. 디스크 공간 또는 권한을 확인한 뒤 다시 시도해 주세요.",
  "loginModalConversational.activErrUnauthorizedFrame": "잘못된 요청 경로입니다. 앱을 재시작한 뒤 다시 시도해 주세요.",
  "loginModalConversational.activErrActivationFailed": "활성화에 실패했습니다.",

  // Inline errors from useEffect / callbacks
  "loginModalConversational.relaunchRequestFailed": "재시작 요청에 실패했습니다. LVIS 를 수동으로 재시작한 뒤 다시 시도해 주세요.",
  "loginModalConversational.relaunchRequestError": "재시작 요청 중 오류가 발생했습니다. LVIS 를 수동으로 재시작한 뒤 다시 시도해 주세요.",
  "loginModalConversational.errLoginProcessError": "로그인 처리 중 오류가 발생했습니다.",
  "loginModalConversational.errDemoStatusCheckError": "활성화 상태 확인 중 오류가 발생했습니다.",
  "loginModalConversational.activErrProcessError": "활성화 처리 중 오류가 발생했습니다.",
  "loginModalConversational.activationRelaunchNotice": "활성화 적용을 위해 5초 후 자동으로 다시 시작합니다. 다시 시작 후 연결 상태를 확인합니다.",

  // CHECKLIST_LINES labels
  "loginModalConversational.checklistCredentials": "활성화 키 검증",
  "loginModalConversational.checklistLlmKey": "자격증명 발급",
  "loginModalConversational.checklistSandbox": "sandbox 준비 중…",
  "loginModalConversational.checklistSandboxDone": "sandbox 준비 완료",

  // JSX — dialog header / session bar
  "loginModalConversational.sessionStart": "LVIS · 인증 세션 시작",

  // JSX — greeting bubble
  "loginModalConversational.greeting": "안녕하세요.",
  "loginModalConversational.greetingPrompt": "LVIS 는 처음이시군요. 어떤 방식으로 시작할까요?",

  // JSX — chip 1 (activation key)
  "loginModalConversational.chip1Label": "활성화 키로 30초 안에 시작",
  "loginModalConversational.chip1Sub": "자동 인증 · 자격증명 자동 설정",

  // JSX — chip 2 (BYOK)
  "loginModalConversational.chip2Label": "제가 발급받은 API 키가 있어요",
  "loginModalConversational.chip2Sub": "설정 → LLM 탭에서 입력",

  // JSX — chip 3 (SSO)
  "loginModalConversational.chip3Title": "조직 SSO 연결은 곧 지원 예정입니다",
  "loginModalConversational.chip3Label": "조직 SSO 로 연결",
  "loginModalConversational.chip3Sub": "곧 지원 예정",

  // JSX — user turn bubble
  "loginModalConversational.userTurnText": "활성화 키로 시작할게요.",

  // JSX — assistant reply bubble states
  "loginModalConversational.assistantSubmitting": "활성화 완료 · 인증을 시작합니다…",
  "loginModalConversational.assistantRelaunching": "활성화 완료 · 설정 적용을 위해 5초 후 자동으로 재시작합니다…",
  "loginModalConversational.assistantCheckingStatus": "활성화 상태를 확인합니다…",
  "loginModalConversational.assistantPromptActivation": "관리자에게 받은 활성화 키가 있으신가요? 한 줄로 붙여넣어 주세요.",

  // JSX — activation input
  "loginModalConversational.activationInputAriaLabel": "활성화 키",

  // JSX — activation buttons
  "loginModalConversational.btnWaitingRelaunch": "재시작 대기…",
  "loginModalConversational.btnActivating": "활성화 중…",
  "loginModalConversational.btnActivate": "활성화 →",
  "loginModalConversational.btnCancel": "취소",

  // JSX — footer hint
  "loginModalConversational.footerHintPre": "위 선택지를 클릭하거나 ",
  "loginModalConversational.footerHintPost": " 키로 빠른 선택",
};
