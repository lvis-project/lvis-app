/** Human-readable display names for LLM tool identifiers. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Knowledge / Document
  knowledge_search: "문서 검색",
  document_structure: "문서 구조 파악",
  document_page_content: "페이지 내용 읽기",
  document_list: "문서 목록",
  chat_preview: "문서 미리보기",
  render_html: "HTML 렌더링",
  search_memory: "기억 검색",

  // Index / PageIndex
  index_scan: "인덱스 스캔",
  index_scan_status: "스캔 상태 확인",
  index_scan_cancel: "스캔 취소",
  index_add_folder: "폴더 추가",
  index_remove_folder: "폴더 제거",
  index_folders: "폴더 목록",
  index_documents: "문서 목록",
  index_refresh_folder: "폴더 새로고침",
  index_folders_purge_orphans: "고아 폴더 정리",
  pageindex_scan: "파일 인덱싱",

  // Meeting
  meeting_start: "회의 녹음 시작",
  meeting_stop: "회의 녹음 종료",
  meeting_push_chunk: "오디오 청크 전송",
  meeting_transcript: "회의 전사 조회",
  meeting_sessions: "회의 목록",

  // MS Graph / Calendar / Email
  msgraph_auth: "Microsoft 인증",
  msgraph_status: "Microsoft 연결 상태",
  msgraph_signout: "Microsoft 로그아웃",
  msgraph_set_environment: "Microsoft 환경 설정",
  msgraph_list_environments: "Microsoft 환경 목록",
  msgraph_calendar_list: "일정 목록",
  msgraph_calendar_get: "일정 조회",
  msgraph_calendar_today: "오늘 일정",
  msgraph_calendar_create: "일정 생성",
  msgraph_calendar_update: "일정 수정",
  msgraph_calendar_delete: "일정 삭제",
  msgraph_calendar_detect_patterns: "반복 패턴 감지",
  msgraph_calendar_open_url: "일정 링크 열기",
  msgraph_calendar_start_watcher: "일정 모니터 시작",
  msgraph_calendar_stop_watcher: "일정 모니터 종료",
  msgraph_email_list: "이메일 목록",
  msgraph_email_read: "이메일 읽기",
  msgraph_email_analyze: "이메일 분석",
  msgraph_email_reply: "이메일 답장",
  msgraph_email_get_notifications: "이메일 알림 조회",
  msgraph_email_get_sent_reply: "발송 답장 조회",
  msgraph_email_get_sent_replies: "발송 답장 목록",
  msgraph_email_create_event: "이메일로 일정 생성",
  msgraph_email_start_watcher: "이메일 모니터 시작",
  msgraph_email_stop_watcher: "이메일 모니터 종료",

  // Tasks
  task_add: "할 일 추가",
  task_list: "할 일 목록",
  task_update: "할 일 수정",
  task_delete: "할 일 삭제",
  task_today: "오늘 할 일",
  task_overdue: "기한 지난 할 일",
  todo_session_write: "세션 메모 저장",
  remind_at: "알림 설정",

  // Agent Hub
  agent_hub_status: "허브 상태 확인",
  agent_hub_list_inbox: "수신함 목록",
  agent_hub_check_inbox: "수신함 확인",
  agent_hub_dismiss_notifications: "알림 닫기",
  agent_hub_post_work_log: "작업 로그 기록",
  agent_hub_my_recent_logs: "최근 작업 로그",
  agent_hub_subscribe_team: "팀 구독",
  agent_hub_generate_weekly_report: "주간 보고서 생성",
  agent_hub_generate_team_weekly_report: "팀 주간 보고서",
  agent_spawn: "서브에이전트 실행",

  // LGE
  lge_login: "LGE 로그인",
  lge_status: "LGE 연결 상태",
  lge_facility_list: "시설 목록",
  lge_facility_availability_day: "시설 일별 예약 현황",
  lge_facility_suggest: "시설 추천",

  // Web / Search
  web_search: "웹 검색",
  web_fetch: "웹 페이지 가져오기",

  // System
  bash: "터미널 명령",
  request_plugin: "플러그인 실행",

  // Memory (boot/tools)
  memory_save: "기억 저장",
  memory_search: "기억 검색",
  memory_list: "기억 목록",

  // Misc
  skill_load: "스킬 로드",
  ask_user_question: "사용자에게 질문",
  work_proactive_generate_daily_briefing: "일일 브리핑 생성",
  noop: "대기",
};

export function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName];
  // Smart fallback: unknown tool names rendered as readable text (underscores → spaces)
  return toolName.replace(/_/g, " ");
}
