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
    // The panel has no include/exclude dialog: folders are picked through the
    // OS picker and the scan set is fixed by the supported document formats,
    // which the card lists as chips. The caption now says that.
    caption: "폴더 추가 — 지원 문서 형식과 스캔 대기 상태",
    captionEn: "Adding a folder — supported document formats and the pending-scan state",
  },
  "local-indexer-search": {
    slug: "local-indexer-search.png",
    topic: "local-indexer",
    caption: "자료 검색 ① — 한 번의 index_search 결과에서 두 문서를 골라 답변",
    captionEn: "Document search 1 — one index_search call, answered from the two documents it turned up",
  },
  "local-indexer-search-2": {
    slug: "local-indexer-search-2.png",
    topic: "local-indexer",
    caption: "자료 검색 ② — 문서의 정확한 경로와 그 문서가 정한 단계 요약",
    captionEn: "Document search 2 — the document's exact path, and the steps that document lays out",
  },
  "local-indexer-search-3": {
    slug: "local-indexer-search-3.png",
    topic: "local-indexer",
    caption: "자료 검색 ③ — 같은 답변을 한 장짜리 발표 자료 형식으로 재정리",
    captionEn: "Document search 3 — the same answer reformatted into a one-page handout",
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

};

export function shotUrl(key: keyof typeof shots): string {
  return `/screenshots/${shots[key].slug}`;
}

export function shotCaption(key: string, locale: "ko" | "en") {
  const s = shots[key];
  return locale === "en" ? (s?.captionEn ?? s?.caption ?? "") : (s?.caption ?? "");
}
