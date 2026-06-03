// AUTO-GENERATED — i18n migration. Source: src/ui/renderer/components/LoginModalConversational.tsx. Do not edit by hand.
export const en = {
  // errorMessage() — auth IPC error codes
  "loginModalConversational.errInvalidCredentials": "Demo credentials are incorrect.",
  "loginModalConversational.errNoDemoKey": "Demo mode configuration needs to be verified. Set the environment variable `LVIS_DEMO_VENDOR=azure-foundry` and try again. (See docs/onboarding/local-demo-setup.md)",
  "loginModalConversational.errLlmKeyIssuingFailed": "An error occurred while saving the LLM key. Please check disk permissions or Keychain status.",
  "loginModalConversational.errReviewerRewireFailed": "Agent sandbox initialization failed. Please try again.",
  "loginModalConversational.errEndpointUnreachable": "Cannot connect to the internal network endpoint. Please check your VPN or internal network connection.",
  "loginModalConversational.errInvalidFoundryEndpoint": "Demo endpoint format is invalid. Please request a new activation code from the issuer.",
  "loginModalConversational.errMissingFoundryHostMap": "Demo private endpoint host-map is missing. Please request a new activation code from the issuer.",
  "loginModalConversational.errFoundryHostMapMismatch": "Demo endpoint and host-map do not match. Please request a new activation code from the issuer.",
  "loginModalConversational.errInvalidFoundryHostMapTarget": "Demo host-map target is not within the allowed private endpoint range. Please request a new activation code from the issuer.",
  "loginModalConversational.errLoginFailed": "Login failed.",

  // activationErrorMessage() — activation IPC error codes
  "loginModalConversational.activErrInvalidCode": "Activation code is invalid. Please check the single-line code starting with `LVIS-DEMO:v1:` again.",
  "loginModalConversational.activErrNoVendor": "Vendor information is missing from the activation code. Please request it again from the issuer.",
  "loginModalConversational.activErrInvalidVendor": "Vendor information in the activation code is invalid. Please request it again from the issuer.",
  "loginModalConversational.activErrNoDemoKey": "Demo API key is missing from the activation code. Please request a new activation code from the issuer.",
  "loginModalConversational.activErrMissingFoundryEndpoint": "Azure Foundry endpoint information is missing from the activation code. Please request a new activation code from the issuer.",
  "loginModalConversational.activErrInvalidFoundryEndpoint": "Demo endpoint format is invalid. Please request a new activation code from the issuer.",
  "loginModalConversational.activErrMissingFoundryHostMap": "Private endpoint host-map information is missing from the activation code. Please request a new activation code from the issuer.",
  "loginModalConversational.activErrFoundryHostMapMismatch": "Endpoint and host-map in the activation code do not match. Please request a new activation code from the issuer.",
  "loginModalConversational.activErrInvalidFoundryHostMapTarget": "Host-map target in the activation code is not within the allowed private endpoint range. Please request a new activation code from the issuer.",
  "loginModalConversational.activErrPersistFailed": "Failed to save the activation code. Please check disk space or permissions and try again.",
  "loginModalConversational.activErrUnauthorizedFrame": "Invalid request path. Please restart the app and try again.",
  "loginModalConversational.activErrActivationFailed": "Activation failed.",

  // Inline errors from useEffect / callbacks
  "loginModalConversational.relaunchRequestFailed": "Restart request failed. Please restart LVIS manually and try again.",
  "loginModalConversational.relaunchRequestError": "An error occurred during the restart request. Please restart LVIS manually and try again.",
  "loginModalConversational.errLoginProcessError": "An error occurred while processing login.",
  "loginModalConversational.errDemoStatusCheckError": "An error occurred while checking the demo activation status.",
  "loginModalConversational.activErrProcessError": "An error occurred while processing activation.",
  "loginModalConversational.activationRelaunchNotice": "The app will automatically restart in 5 seconds to apply the activation. After restarting, the AI connection status will be verified.",

  // CHECKLIST_LINES labels
  "loginModalConversational.checklistCredentials": "Validating credentials",
  "loginModalConversational.checklistLlmKey": "Issuing LLM key (azure-foundry)",
  "loginModalConversational.checklistSandbox": "Preparing sandbox…",
  "loginModalConversational.checklistSandboxDone": "Sandbox ready",

  // JSX — dialog header / session bar
  "loginModalConversational.sessionStart": "LVIS · Authentication session started",

  // JSX — greeting bubble
  "loginModalConversational.greeting": "Hello.",
  "loginModalConversational.greetingPrompt": "It looks like this is your first time with LVIS. How would you like to get started?",

  // JSX — chip 1 (demo)
  "loginModalConversational.chip1Label": "Try the demo credentials in 30 seconds",
  "loginModalConversational.chip1Sub": "Auto authentication · Auto LLM key issuance",

  // JSX — chip 2 (BYOK)
  "loginModalConversational.chip2Label": "I have my own API key",
  "loginModalConversational.chip2Sub": "Enter in Settings → LLM tab",

  // JSX — chip 3 (SSO)
  "loginModalConversational.chip3Title": "Organization SSO connection coming soon",
  "loginModalConversational.chip3Label": "Connect with organization SSO",
  "loginModalConversational.chip3Sub": "Coming soon",

  // JSX — user turn bubble
  "loginModalConversational.userTurnText": "I'll start with the demo credentials.",

  // JSX — assistant reply bubble states
  "loginModalConversational.assistantSubmitting": "Activation complete · Starting authentication with demo credentials…",
  "loginModalConversational.assistantRelaunching": "Activation complete · Restarting automatically in 5 seconds to apply host settings…",
  "loginModalConversational.assistantCheckingStatus": "Checking demo activation status…",
  "loginModalConversational.assistantPromptActivation": "Have you received a demo activation code? Please paste it as a single line. The format is `LVIS-DEMO:v1:...`.",

  // JSX — activation input
  "loginModalConversational.activationInputAriaLabel": "Demo activation code",

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
  "loginModalConversational.errInvalidCredentials": "데모 자격증명이 올바르지 않습니다.",
  "loginModalConversational.errNoDemoKey": "데모 모드 설정 확인이 필요해요. 환경 변수 `LVIS_DEMO_VENDOR=azure-foundry` 를 설정한 뒤 다시 시도하세요. (docs/onboarding/local-demo-setup.md 참조)",
  "loginModalConversational.errLlmKeyIssuingFailed": "LLM 키 저장 중 오류가 발생했어요. 디스크 권한 또는 Keychain 상태를 확인해주세요.",
  "loginModalConversational.errReviewerRewireFailed": "에이전트 sandbox 초기화에 실패했습니다. 다시 시도해 주세요.",
  "loginModalConversational.errEndpointUnreachable": "내부망 endpoint 에 연결할 수 없어요. VPN 또는 내부망 연결을 확인해주세요.",
  "loginModalConversational.errInvalidFoundryEndpoint": "데모 endpoint 형식이 올바르지 않아요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.errMissingFoundryHostMap": "데모 private endpoint host-map 이 빠져 있어요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.errFoundryHostMapMismatch": "데모 endpoint 와 host-map 이 일치하지 않아요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.errInvalidFoundryHostMapTarget": "데모 host-map 대상이 허용된 private endpoint 대역이 아니에요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.errLoginFailed": "로그인에 실패했습니다.",

  // activationErrorMessage() — activation IPC error codes
  "loginModalConversational.activErrInvalidCode": "활성 코드가 올바르지 않아요. `LVIS-DEMO:v1:` 로 시작하는 한 줄 코드를 다시 확인해 주세요.",
  "loginModalConversational.activErrNoVendor": "활성 코드에 vendor 정보가 빠져 있어요. 발급자에게 다시 요청해 주세요.",
  "loginModalConversational.activErrInvalidVendor": "활성 코드의 vendor 정보가 올바르지 않아요. 발급자에게 다시 요청해 주세요.",
  "loginModalConversational.activErrNoDemoKey": "활성 코드에 데모 API 키가 빠져 있어요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.activErrMissingFoundryEndpoint": "활성 코드에 Azure Foundry endpoint 정보가 빠져 있어요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.activErrInvalidFoundryEndpoint": "데모 endpoint 형식이 올바르지 않아요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.activErrMissingFoundryHostMap": "활성 코드에 private endpoint host-map 정보가 빠져 있어요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.activErrFoundryHostMapMismatch": "활성 코드의 endpoint 와 host-map 이 일치하지 않아요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.activErrInvalidFoundryHostMapTarget": "활성 코드의 host-map 대상이 허용된 private endpoint 대역이 아니에요. 발급자에게 새 활성 코드를 요청해 주세요.",
  "loginModalConversational.activErrPersistFailed": "활성 코드를 저장하지 못했어요. 디스크 공간 또는 권한을 확인한 뒤 다시 시도해 주세요.",
  "loginModalConversational.activErrUnauthorizedFrame": "잘못된 요청 경로입니다. 앱을 재시작한 뒤 다시 시도해 주세요.",
  "loginModalConversational.activErrActivationFailed": "활성에 실패했습니다.",

  // Inline errors from useEffect / callbacks
  "loginModalConversational.relaunchRequestFailed": "재시작 요청에 실패했습니다. LVIS 를 수동으로 재시작한 뒤 다시 시도해 주세요.",
  "loginModalConversational.relaunchRequestError": "재시작 요청 중 오류가 발생했습니다. LVIS 를 수동으로 재시작한 뒤 다시 시도해 주세요.",
  "loginModalConversational.errLoginProcessError": "로그인 처리 중 오류가 발생했습니다.",
  "loginModalConversational.errDemoStatusCheckError": "데모 활성 상태 확인 중 오류가 발생했습니다.",
  "loginModalConversational.activErrProcessError": "활성 처리 중 오류가 발생했습니다.",
  "loginModalConversational.activationRelaunchNotice": "활성화 적용을 위해 5초 후 자동으로 다시 시작합니다. 다시 시작 후 AI 연결 상태를 확인합니다.",

  // CHECKLIST_LINES labels
  "loginModalConversational.checklistCredentials": "자격증명 검증",
  "loginModalConversational.checklistLlmKey": "LLM 키 발급 (azure-foundry)",
  "loginModalConversational.checklistSandbox": "sandbox 준비 중…",
  "loginModalConversational.checklistSandboxDone": "sandbox 준비 완료",

  // JSX — dialog header / session bar
  "loginModalConversational.sessionStart": "LVIS · 인증 세션 시작",

  // JSX — greeting bubble
  "loginModalConversational.greeting": "안녕하세요.",
  "loginModalConversational.greetingPrompt": "LVIS 는 처음이시군요. 어떤 방식으로 시작할까요?",

  // JSX — chip 1 (demo)
  "loginModalConversational.chip1Label": "데모 자격증명으로 30초 안에 체험",
  "loginModalConversational.chip1Sub": "자동 인증 · LLM 키 자동 발급",

  // JSX — chip 2 (BYOK)
  "loginModalConversational.chip2Label": "제가 발급받은 API 키가 있어요",
  "loginModalConversational.chip2Sub": "설정 → LLM 탭에서 입력",

  // JSX — chip 3 (SSO)
  "loginModalConversational.chip3Title": "조직 SSO 연결은 곧 지원 예정입니다",
  "loginModalConversational.chip3Label": "조직 SSO 로 연결",
  "loginModalConversational.chip3Sub": "곧 지원 예정",

  // JSX — user turn bubble
  "loginModalConversational.userTurnText": "데모 자격증명으로 시작할게요.",

  // JSX — assistant reply bubble states
  "loginModalConversational.assistantSubmitting": "활성 완료 · 데모 자격증명으로 인증을 시작합니다…",
  "loginModalConversational.assistantRelaunching": "활성 완료 · 호스트 적용을 위해 5초 후 자동으로 재시작합니다…",
  "loginModalConversational.assistantCheckingStatus": "데모 활성 상태를 확인합니다…",
  "loginModalConversational.assistantPromptActivation": "데모 활성 코드를 받으셨나요? 한 줄로 붙여넣어 주세요. 형식은 `LVIS-DEMO:v1:...` 입니다.",

  // JSX — activation input
  "loginModalConversational.activationInputAriaLabel": "데모 활성 코드",

  // JSX — activation buttons
  "loginModalConversational.btnWaitingRelaunch": "재시작 대기…",
  "loginModalConversational.btnActivating": "활성 중…",
  "loginModalConversational.btnActivate": "활성 →",
  "loginModalConversational.btnCancel": "취소",

  // JSX — footer hint
  "loginModalConversational.footerHintPre": "위 선택지를 클릭하거나 ",
  "loginModalConversational.footerHintPost": " 키로 빠른 선택",
};
