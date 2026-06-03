// AUTO-GENERATED — i18n migration. Source: src/ui/renderer/constants.ts. Do not edit by hand.
export const en = {
  // SOURCE_LABEL
  "constants.sourceLabelEmail": "Mail",
  "constants.sourceLabelMeeting": "Meeting",
  "constants.sourceLabelCalendar": "Calendar",
  "constants.sourceLabelManual": "Manual",

  // SOURCE_BADGE
  "constants.sourceBadgeBuiltin": "Built-in",
  "constants.sourceBadgePlugin": "Plugin",

  // WEB_PROVIDERS placeholders
  "constants.webProviderDuckDuckGoPlaceholder": "No key required",
  "constants.webProviderSerperPlaceholder": "Enter key...",

  // EXEC_MODE_OPTIONS
  "constants.execModeDefaultLabel": "Default",
  "constants.execModeDefaultDesc": "Reads allowed; approval required for write, shell, and network operations",
  "constants.execModeStrictLabel": "Ask for everything",
  "constants.execModeStrictDesc": "Approval required for all tools including reads",
  "constants.execModeAutoLabel": "Auto-verify",
  "constants.execModeAutoDesc": "Low-risk operations are processed with an audit trail; automated (headless) execution and interactive chat are both verified by the permission reviewer",
  "constants.execModeAllowLabel": "Allow all",
  "constants.execModeAllowDesc": "Tools outside hard blocks are auto-allowed; access outside allowed directories requires separate approval",
} as const;
export const ko: Record<keyof typeof en, string> = {
  // SOURCE_LABEL
  "constants.sourceLabelEmail": "메일",
  "constants.sourceLabelMeeting": "미팅",
  "constants.sourceLabelCalendar": "일정",
  "constants.sourceLabelManual": "직접",

  // SOURCE_BADGE
  "constants.sourceBadgeBuiltin": "내장",
  "constants.sourceBadgePlugin": "플러그인",

  // WEB_PROVIDERS placeholders
  "constants.webProviderDuckDuckGoPlaceholder": "키 불필요",
  "constants.webProviderSerperPlaceholder": "키 입력...",

  // EXEC_MODE_OPTIONS
  "constants.execModeDefaultLabel": "기본",
  "constants.execModeDefaultDesc": "읽기 도구는 허용하고 변경·셸·네트워크는 승인 요청",
  "constants.execModeStrictLabel": "전체 물어보기",
  "constants.execModeStrictDesc": "읽기까지 포함해 모든 도구 실행 전 승인 요청",
  "constants.execModeAutoLabel": "자동 검증",
  "constants.execModeAutoDesc": "저위험 작업은 감사 기록으로 처리하고 자동(헤드리스) 실행과 대화형 채팅 모두를 권한 리뷰어가 검증",
  "constants.execModeAllowLabel": "전체 허용",
  "constants.execModeAllowDesc": "하드 차단 밖 도구는 자동 허용하고 허용 디렉터리 밖 접근은 별도 승인",
};
