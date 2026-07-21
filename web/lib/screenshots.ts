export interface Shot {
  slug: string;
  caption: string;
  captionEn: string;
  topic: string;
}

export const shots: Record<string, Shot> = {
  // 채팅 (host app)
  "chat-todo-queue": {
    slug: "chat-todo-queue.png",
    topic: "chat",
    caption: "메시지 큐와 TODO 리스트가 채팅 본문 위에 떠 있는 상태",
    captionEn: "Message queue and TODO list floating above the chat body",
  },
  "chat-tool-thinking": {
    slug: "chat-tool-thinking.png",
    topic: "chat",
    caption: "LLM 도구 실행 + thinking 토큰 스트리밍 표시",
    captionEn: "LLM tool execution plus streaming thinking tokens",
  },
  "chat-permission-llm-review": {
    slug: "chat-permission-llm-review.png",
    topic: "chat",
    caption: "LLM 자율 검토 모드 권한 카드",
    captionEn: "Permission card for LLM autonomous review mode",
  },
  "chat-permission-directory": {
    slug: "chat-permission-directory.png",
    topic: "chat",
    caption: "디렉토리 단위 read/write 권한 부여",
    captionEn: "Granting read/write permission at the directory level",
  },
  "chat-permission-risk": {
    slug: "chat-permission-risk.png",
    topic: "chat",
    caption: "위험도 기반 자동/수동 승인 분기",
    captionEn: "Risk-based branching between automatic and manual approval",
  },
  "chat-app-update": {
    slug: "chat-app-update.png",
    topic: "chat",
    caption: "앱 자동 업데이트 알림과 재시작 흐름",
    captionEn: "Automatic app update notification and restart flow",
  },
  "chat-question-card": {
    slug: "chat-question-card.png",
    topic: "chat",
    caption: "에이전트가 사용자에게 되묻는 인터랙티브 질문 카드",
    captionEn: "Interactive question card the agent uses to ask the user back",
  },
  "chat-plugin-panel": {
    slug: "chat-plugin-panel.png",
    topic: "chat",
    caption: "채팅에서 호출 가능한 플러그인 패널 (skills, tools)",
    captionEn: "Plugin panel callable from chat (skills, tools)",
  },

  // 플러그인 공통
  "plugin-permission-grant": {
    slug: "plugin-permission-grant.png",
    topic: "plugins",
    caption: "플러그인 최초 활성 시 권한 허용 다이얼로그",
    captionEn: "Permission grant dialog shown the first time a plugin activates",
  },

  // local-indexer
  "local-indexer-home": {
    slug: "local-indexer-home.png",
    topic: "local-indexer",
    caption: "Local Indexer 기본 화면 — 인덱싱 폴더 / 통계",
    captionEn: "Local Indexer home screen — indexed folders / stats",
  },
  "local-indexer-indexing": {
    slug: "local-indexer-indexing.png",
    topic: "local-indexer",
    caption: "인덱싱 진행 중 — 청크/임베딩 progress",
    captionEn: "Indexing in progress — chunk/embedding progress",
  },
  "local-indexer-add-folder": {
    slug: "local-indexer-add-folder.png",
    topic: "local-indexer",
    caption: "폴더 추가 다이얼로그 — include/exclude 패턴",
    captionEn: "Add folder dialog — include/exclude patterns",
  },
  "local-indexer-search": {
    slug: "local-indexer-search.webp",
    topic: "local-indexer",
    caption: "자료 검색 ① — 키워드 → 파일 후보 + 근거 (다른 파일 비교 인용)",
    captionEn: "Document search 1 — keyword to candidate files with evidence (citing comparisons across files)",
  },
  "local-indexer-search-2": {
    slug: "local-indexer-search-2.webp",
    topic: "local-indexer",
    caption: "자료 검색 ② — 정확한 NAS 경로 + 같은 경로 기반 핵심 구조 요약",
    captionEn: "Document search 2 — exact NAS path plus a structural summary based on that same path",
  },
  "local-indexer-search-3": {
    slug: "local-indexer-search-3.webp",
    topic: "local-indexer",
    caption: "자료 검색 ③ — 같은 컨텐츠를 한 장짜리 발표용 포맷으로 재변환",
    captionEn: "Document search 3 — the same content reformatted into a one-page presentation",
  },
  "local-indexer-index-search": {
    slug: "local-indexer-index-search.png",
    topic: "local-indexer",
    caption: "인덱스 검색 — 자연어 질문에 후보 문서 + 인용 근거를 함께 표시",
    captionEn: "Index search — shows candidate documents and cited evidence for a natural-language question",
  },

  // meeting 확장
  "meeting-upcoming": {
    slug: "meeting-upcoming.png",
    topic: "meeting",
    caption: "예정 회의 — 다음 회의와 안건 미리보기, 클릭 한 번에 녹음 준비",
    captionEn: "Upcoming meeting — preview of the next meeting and its agenda, ready to record in one click",
  },
  "meeting-minutes": {
    slug: "meeting-minutes.png",
    topic: "meeting",
    caption: "회의록 — 종료 직후 자동 생성된 한 페이지 요약",
    captionEn: "Meeting minutes — a one-page summary auto-generated right after the meeting ends",
  },
  "meeting-minutes-2": {
    slug: "meeting-minutes-2.png",
    topic: "meeting",
    caption: "회의록 상세 — 발화자 단위 transcript + 액션 아이템",
    captionEn: "Meeting minutes detail — per-speaker transcript plus action items",
  },
  "meeting-minutes-3": {
    slug: "meeting-minutes-3.png",
    topic: "meeting",
    caption: "회의록 후속 — 메모 / 공유 / 검색을 한 화면에서",
    captionEn: "Meeting minutes follow-up — notes, sharing, and search all on one screen",
  },

  // 연동 — meeting + outlook
  "meeting-outlook-mail": {
    slug: "meeting-outlook-mail.png",
    topic: "integration",
    caption: "회의록 → Outlook 메일 초안 ① — 참석자 대상으로 공유 메일 자동 작성",
    captionEn: "Minutes to Outlook draft 1 — automatically drafts a share email addressed to attendees",
  },
  "meeting-outlook-mail-2": {
    slug: "meeting-outlook-mail-2.png",
    topic: "integration",
    caption: "회의록 → Outlook 메일 초안 ② — 사용자 확인 후 발송",
    captionEn: "Minutes to Outlook draft 2 — sent after the user confirms",
  },

  // ms-graph (Outlook)
  "outlook-login-trigger": {
    slug: "outlook-login-trigger.png",
    topic: "ms-graph",
    caption: "OAuth 로그인 트리거",
    captionEn: "OAuth login trigger",
  },
  "outlook-login-window": {
    slug: "outlook-login-window.png",
    topic: "ms-graph",
    caption: "MS OAuth 로그인 창",
    captionEn: "Microsoft OAuth login window",
  },
  "outlook-login-after": {
    slug: "outlook-login-after.png",
    topic: "ms-graph",
    caption: "로그인 성공 — 메일/캘린더 권한 정리",
    captionEn: "Login succeeded — summary of mail/calendar permissions",
  },
  "outlook-logout": {
    slug: "outlook-logout.png",
    topic: "ms-graph",
    caption: "로그아웃 / 토큰 폐기 화면",
    captionEn: "Logout / token revocation screen",
  },

  // meeting
  "meeting-record": {
    slug: "meeting-record.png",
    topic: "meeting",
    caption: "회의 녹음 시작 — 미니 위젯",
    captionEn: "Starting meeting recording — mini widget",
  },
  "meeting-record-stt": {
    slug: "meeting-record-stt.png",
    topic: "meeting",
    caption: "STT 청크가 실시간으로 흘러오는 화면",
    captionEn: "Screen showing STT chunks streaming in in real time",
  },

  // work-assistant
  "work-assistant-conflict": {
    slug: "work-assistant-conflict.png",
    topic: "work-assistant",
    caption: "일정 겹침 감지 — 카드형 알림",
    captionEn: "Schedule conflict detected — card-style notification",
  },
  "work-assistant-conflict-2": {
    slug: "work-assistant-conflict-2.png",
    topic: "work-assistant",
    caption: "겹친 일정 정리 — 사용자 선택지",
    captionEn: "Resolving the overlapping schedule — options for the user",
  },
  "work-assistant-reminder": {
    slug: "work-assistant-reminder.png",
    topic: "work-assistant",
    caption: "일정 알림 — 15분 전 사전 안내",
    captionEn: "Schedule reminder — a heads-up 15 minutes ahead",
  },
  "work-assistant-reminder-2": {
    slug: "work-assistant-reminder-2.png",
    topic: "work-assistant",
    caption: "알림 후속 — 회의실/링크 바로 열기",
    captionEn: "Reminder follow-up — jump straight to the meeting room/link",
  },
  "work-assistant-meeting-end-trigger": {
    slug: "work-assistant-meeting-end-trigger.png",
    topic: "work-assistant",
    caption: "미팅 종료 트리거 — 액션 아이템 자동 추출",
    captionEn: "Meeting-end trigger — action items extracted automatically",
  },
  "work-assistant-meeting-end-trigger-2": {
    slug: "work-assistant-meeting-end-trigger-2.png",
    topic: "work-assistant",
    caption: "추출된 액션 아이템을 TODO/메일로 변환",
    captionEn: "Converting extracted action items into TODOs/emails",
  },

  // lge-api (이피)
  "ep-login": {
    slug: "ep-login.png",
    topic: "lge-api",
    caption: "이피 (EP) 사내 포털 로그인",
    captionEn: "Login to the internal EP portal",
  },
  "ep-attendance": {
    slug: "ep-attendance.png",
    topic: "lge-api",
    caption: "근태 조회",
    captionEn: "Attendance lookup",
  },
  "ep-attendance-2": {
    slug: "ep-attendance-2.png",
    topic: "lge-api",
    caption: "근태 상세",
    captionEn: "Attendance detail",
  },
  "ep-attendance-3": {
    slug: "ep-attendance-3.png",
    topic: "lge-api",
    caption: "근태 — 월간 뷰",
    captionEn: "Attendance — monthly view",
  },
  "ep-approval": {
    slug: "ep-approval.png",
    topic: "lge-api",
    caption: "전자결재 — 결재함",
    captionEn: "E-approval — approval inbox",
  },
  "ep-parking": {
    slug: "ep-parking.png",
    topic: "lge-api",
    caption: "주차 — 예약/확인",
    captionEn: "Parking — reserve/confirm",
  },
  "ep-meeting-room": {
    slug: "ep-meeting-room.png",
    topic: "lge-api",
    caption: "회의실 검색",
    captionEn: "Meeting room search",
  },
  "ep-meeting-room-2": {
    slug: "ep-meeting-room-2.png",
    topic: "lge-api",
    caption: "회의실 — 가용 시간",
    captionEn: "Meeting room — available times",
  },
  "ep-meeting-room-3": {
    slug: "ep-meeting-room-3.png",
    topic: "lge-api",
    caption: "회의실 예약 확인",
    captionEn: "Meeting room booking confirmation",
  },
  "ep-meeting-room-4": {
    slug: "ep-meeting-room-4.png",
    topic: "lge-api",
    caption: "회의실 — 다중 슬롯",
    captionEn: "Meeting room — multiple slots",
  },
  "ep-meeting-room-5": {
    slug: "ep-meeting-room-5.png",
    topic: "lge-api",
    caption: "예약 완료",
    captionEn: "Booking complete",
  },
  "ep-video-call": {
    slug: "ep-video-call.png",
    topic: "lge-api",
    caption: "화상회의 진입",
    captionEn: "Entering a video call",
  },
  "ep-video-call-2": {
    slug: "ep-video-call-2.png",
    topic: "lge-api",
    caption: "화상회의 — 참가자",
    captionEn: "Video call — participants",
  },
  "ep-video-call-3": {
    slug: "ep-video-call-3.png",
    topic: "lge-api",
    caption: "화상회의 옵션",
    captionEn: "Video call options",
  },
  "ep-video-call-4": {
    slug: "ep-video-call-4.png",
    topic: "lge-api",
    caption: "화상회의 — 종료/녹화",
    captionEn: "Video call — end/record",
  },
  "ep-lgenie": {
    slug: "ep-lgenie.png",
    topic: "lge-api",
    caption: "lgenie 사내 검색 진입",
    captionEn: "Entering lgenie internal search",
  },
  "ep-lgenie-2": {
    slug: "ep-lgenie-2.png",
    topic: "lge-api",
    caption: "lgenie 결과 인용",
    captionEn: "lgenie result citation",
  },

  // agent-hub plugin (host sidebar)
  "agent-hub-my-work": {
    slug: "agent-hub-my-work.png",
    topic: "agent-hub-plugin",
    caption: "My Work — 개인 업무 보드",
    captionEn: "My Work — personal task board",
  },
  "agent-hub-team-board": {
    slug: "agent-hub-team-board.png",
    topic: "agent-hub-plugin",
    caption: "Team Board — 팀 단위 업무 카드",
    captionEn: "Team Board — team-level task cards",
  },

  // marketplace server
  "mp-login": {
    slug: "mp-login.png",
    topic: "marketplace",
    caption: "마켓플레이스 — 로그인",
    captionEn: "Marketplace — login",
  },
  "mp-plugin": {
    slug: "mp-plugin.png",
    topic: "marketplace",
    caption: "플러그인 카탈로그",
    captionEn: "Plugin catalog",
  },
  "mp-agents": {
    slug: "mp-agents.png",
    topic: "marketplace",
    caption: "Agents 카탈로그",
    captionEn: "Agents catalog",
  },
  "mp-mcp": {
    slug: "mp-mcp.png",
    topic: "marketplace",
    caption: "MCP 서버 카탈로그",
    captionEn: "MCP server catalog",
  },
  "mp-skills": {
    slug: "mp-skills.png",
    topic: "marketplace",
    caption: "Skills 카탈로그",
    captionEn: "Skills catalog",
  },
  "mp-publisher": {
    slug: "mp-publisher.png",
    topic: "marketplace",
    caption: "퍼블리셔 대시보드",
    captionEn: "Publisher dashboard",
  },
  "mp-publisher-2": {
    slug: "mp-publisher-2.png",
    topic: "marketplace",
    caption: "퍼블리셔 — 업로드 흐름",
    captionEn: "Publisher — upload flow",
  },
  "mp-admin": {
    slug: "mp-admin.png",
    topic: "marketplace",
    caption: "어드민 — 전체 통계",
    captionEn: "Admin — overall stats",
  },
  "mp-admin-2": {
    slug: "mp-admin-2.png",
    topic: "marketplace",
    caption: "어드민 — 게시 승인",
    captionEn: "Admin — publish approval",
  },
  "mp-admin-3": {
    slug: "mp-admin-3.png",
    topic: "marketplace",
    caption: "어드민 — 사용자/조직",
    captionEn: "Admin — users/organizations",
  },
  "mp-admin-4": {
    slug: "mp-admin-4.png",
    topic: "marketplace",
    caption: "어드민 — 패키지 검증",
    captionEn: "Admin — package verification",
  },
  "mp-admin-5": {
    slug: "mp-admin-5.png",
    topic: "marketplace",
    caption: "어드민 — 메트릭/감사",
    captionEn: "Admin — metrics/audit",
  },

  // agent-hub server
  "ah-dashboard": {
    slug: "ah-dashboard.png",
    topic: "agent-hub",
    caption: "Agent Hub — 대시보드",
    captionEn: "Agent Hub — dashboard",
  },
  "ah-workboard": {
    slug: "ah-workboard.png",
    topic: "agent-hub",
    caption: "Workboard — 팀 단위 업무",
    captionEn: "Workboard — team-level tasks",
  },
  "ah-worklog": {
    slug: "ah-worklog.png",
    topic: "agent-hub",
    caption: "Work Log — 처리 이력",
    captionEn: "Work Log — processing history",
  },
  "ah-inbox": {
    slug: "ah-inbox.png",
    topic: "agent-hub",
    caption: "Inbox — 직접 메시지/승인",
    captionEn: "Inbox — direct messages/approvals",
  },
  "ah-report": {
    slug: "ah-report.png",
    topic: "agent-hub",
    caption: "Report — 운영 리포트",
    captionEn: "Report — operations report",
  },
  "ah-subscription": {
    slug: "ah-subscription.png",
    topic: "agent-hub",
    caption: "구독 관리",
    captionEn: "Subscription management",
  },
};

export function shotUrl(key: keyof typeof shots): string {
  return `/screenshots/${shots[key].slug}`;
}

export function shotCaption(key: string, locale: "ko" | "en") {
  const s = shots[key];
  return locale === "en" ? (s?.captionEn ?? s?.caption ?? "") : (s?.caption ?? "");
}
