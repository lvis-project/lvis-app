// AUTO-GENERATED — i18n migration. Source: src/ui/renderer/constants.ts. Do not edit by hand.
export const en = {
  // SOURCE_BADGE
  "constants.sourceBadgeBuiltin": "Built-in",
  "constants.sourceBadgePlugin": "Plugin",

  // WEB_PROVIDERS placeholders
  "constants.webProviderDuckDuckGoPlaceholder": "No key required",
  "constants.webProviderSerperPlaceholder": "Enter key...",
  "constants.webProviderGooglePlaceholder": "API Key...",

  // VENDOR_UI labels/placeholders
  "constants.vendorAzureFoundryPlaceholder": "Azure API key...",
  "constants.vendorVertexAiPlaceholder": "service account (unused — uses ADC)",
  "constants.vendorOpenAiCompatibleLabel": "Custom (OpenAI-compatible)",
  "constants.vendorOpenAiCompatiblePlaceholder": "API key (or any value if unauthenticated)",

  // EXEC_MODE_OPTIONS
  "constants.execModeDefaultLabel": "Confirm writes",
  "constants.execModeDefaultDesc": "Reads allowed; approval required for write, shell, and network operations",
  "constants.execModeStrictLabel": "Confirm all",
  "constants.execModeStrictDesc": "Approval required for all tools including reads",
  "constants.execModeAutoLabel": "Auto-verify",
  "constants.execModeAutoDesc": "Low-risk operations are processed with an audit trail; automated (headless) execution and interactive chat are both verified by the permission reviewer",
  "constants.execModeAllowLabel": "Allow all",
  "constants.execModeAllowDesc": "Tools outside hard blocks are auto-allowed; access outside allowed directories requires separate approval",

  // REASONING_EFFORT_STEPS
  "constants.reasoningEffortLow": "Low",
  "constants.reasoningEffortMedium": "Medium",
  "constants.reasoningEffortHigh": "High",
  "constants.reasoningEffortMax": "Max",
} as const;
export const ko: Record<keyof typeof en, string> = {
  // SOURCE_BADGE
  "constants.sourceBadgeBuiltin": "내장",
  "constants.sourceBadgePlugin": "플러그인",

  // WEB_PROVIDERS placeholders
  "constants.webProviderDuckDuckGoPlaceholder": "키 불필요",
  "constants.webProviderSerperPlaceholder": "키 입력...",
  "constants.webProviderGooglePlaceholder": "API 키...",

  // VENDOR_UI labels/placeholders
  "constants.vendorAzureFoundryPlaceholder": "Azure API 키...",
  "constants.vendorVertexAiPlaceholder": "서비스 계정 (미사용 — ADC 사용)",
  "constants.vendorOpenAiCompatibleLabel": "사용자 지정 (OpenAI 호환)",
  "constants.vendorOpenAiCompatiblePlaceholder": "API 키 (인증이 없으면 임의 값 가능)",

  // EXEC_MODE_OPTIONS
  "constants.execModeDefaultLabel": "쓰기 확인",
  "constants.execModeDefaultDesc": "읽기 도구는 허용하고 변경·셸·네트워크는 승인 요청",
  "constants.execModeStrictLabel": "전체 확인",
  "constants.execModeStrictDesc": "읽기까지 포함해 모든 도구 실행 전 승인 요청",
  "constants.execModeAutoLabel": "자동 검증",
  "constants.execModeAutoDesc": "저위험 작업은 감사 기록으로 처리하고 자동(헤드리스) 실행과 대화형 채팅 모두를 권한 리뷰어가 검증",
  "constants.execModeAllowLabel": "모두 허용",
  "constants.execModeAllowDesc": "하드 차단 밖 도구는 자동 허용하고 허용 디렉터리 밖 접근은 별도 승인",

  // REASONING_EFFORT_STEPS
  "constants.reasoningEffortLow": "낮음",
  "constants.reasoningEffortMedium": "보통",
  "constants.reasoningEffortHigh": "높음",
  "constants.reasoningEffortMax": "최대",
};
