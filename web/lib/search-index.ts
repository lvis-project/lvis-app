import { searchEntriesEn } from "./search-index.en";

export interface SearchEntry {
  href: string;
  title: string;
  group: string;
  snippet: string;
  keywords?: string[];
}

export const searchIndex: SearchEntry[] = [
  // Getting Started
  { group: "시작하기", href: "/docs/", title: "LVIS AI 개요", snippet: "데스크톱 호스트 · 플러그인 런타임 · 스토리지 · 서버 4 레이어", keywords: ["overview", "intro"] },
  { group: "시작하기", href: "/docs/getting-started/install", title: "설치 & 첫 실행", snippet: "macOS arm64 / Windows / Linux AppImage · electron-updater · lvis:// 등록" },
  { group: "시작하기", href: "/docs/getting-started/login", title: "로그인 & 첫 화면", snippet: "Marketplace SSO · ApiKey sha256 · Agent Hub PKCE", keywords: ["sso", "auth"] },
  { group: "시작하기", href: "/docs/getting-started/updates", title: "앱 업데이트", snippet: "electron-updater · autoDownload=false · 4h interval · channel=latest" },

  // Host · Chat
  { group: "채팅", href: "/docs/chat/layout", title: "채팅 화면 구성", snippet: "App.tsx · MainToolbar · ChatView · MessageQueuePanel · SessionTodoPanel" },
  { group: "채팅", href: "/docs/chat/message-queue", title: "메시지 큐 & TODO", snippet: "MessageQueuePanel + SessionTodoPanel · emitEvent → host UI 렌더" },
  { group: "채팅", href: "/docs/chat/tool-thinking", title: "Tool & Thinking 표시", snippet: "Tool Registry · ToolSource builtin/plugin/mcp · Category 5종" },
  { group: "채팅", href: "/docs/chat/question-cards", title: "질문 카드", snippet: "AskUserQuestionItem · choices · recommendedIndex · altIndices · allowFreeText" },
  { group: "채팅", href: "/docs/chat/plugin-panel", title: "플러그인 패널", snippet: "manifest ui[] 슬롯 · 번들 Skill · 순수 Tool · 정규식 ^[a-zA-Z_][a-zA-Z0-9_]*$" },
  { group: "채팅", href: "/docs/chat/permissions/directory", title: "권한 — 디렉토리", snippet: "storage sandbox + 호스트 grant · ~/.lvis/permissions.json (0o600)" },
  { group: "채팅", href: "/docs/chat/permissions/llm-review", title: "권한 — LLM 자율검토", snippet: "Reviewer 4모드 disabled/rule/llm/strict" },
  { group: "채팅", href: "/docs/chat/permissions/risk", title: "권한 — 위험 관리", snippet: "RiskLevel low/medium/high × Category 5종 격자 · agentApproval" },

  // Host Features
  { group: "호스트 기능", href: "/docs/host/skills", title: "Skills — 능력 꾸러미", snippet: "플러그인 번들 지침 · Host 선택 범위 · tool_search 기반 Tool 발견", keywords: ["skill", "skills", "지침", "instruction"] },
  { group: "호스트 기능", href: "/docs/host/agents", title: "Agents — 작은 작업 단위", snippet: "하나의 작업을 잘 해내는 자율 단위. 단축키 / Hub 메시지 / 자동화로 시작", keywords: ["agent", "agents", "에이전트"] },
  { group: "호스트 기능", href: "/docs/host/memory", title: "MEMORY — 알려준 사실 기억", snippet: "역할 · 선호 · 자주 만나는 사람 · 안 했으면 하는 것. 내 PC 안에만 보관", keywords: ["memory", "메모리", "기억"] },
  { group: "호스트 기능", href: "/docs/host/mcp", title: "MCP — 외부 도구 가져오기", snippet: "Model Context Protocol 외부 서버 등록. 사용자 동의 후 도구 목록 합류", keywords: ["mcp", "외부 도구"] },
  { group: "호스트 기능", href: "/docs/host/onboarding", title: "온보딩 — 처음 시작 안내", snippet: "첫 실행 시 짧은 투어 + 메모리 시드 입력 + 다시 보기 가능", keywords: ["onboarding", "투어", "시작"] },
  { group: "호스트 기능", href: "/docs/host/trust-security", title: "Trust & Security", snippet: "출처 검증 · 비밀값 보호 · 동의 chain · 내 PC 안에만 · 감사 기록 · No-fallback", keywords: ["trust", "security", "보안", "신뢰", "감사"] },
  { group: "호스트 기능", href: "/docs/host/integration-recipes", title: "Integration Recipes — 결합 시나리오", snippet: "회의→액션→일정→답장 · 자료검색→발표용 · 회의실+화상회의 · 화상회의→회의록→팀보드", keywords: ["recipe", "integration", "결합", "시나리오"] },

  // Routines
  { group: "루틴", href: "/docs/routines/overview", title: "루틴 등록과 트리거 흐름", snippet: "RoutineEngineV2 · 트리거 shutdown | schedule · per-fire fresh loop" },
  { group: "루틴", href: "/docs/routines/meeting-end", title: "미팅 종료 → 자동 작업", snippet: "meeting.summary.created → work-assistant meeting-summary detector" },

  // Plugins
  { group: "플러그인", href: "/docs/plugins", title: "플러그인 — 개요", snippet: "6 active plugins · 정적 manifest · runtime register 없음" },
  { group: "플러그인", href: "/docs/plugins/permission-grant", title: "권한 허용 흐름", snippet: "capabilities 12종 · tools[] · pluginAccess · agentApprovalScopes" },
  { group: "플러그인", href: "/docs/plugins/local-indexer", title: "Local Indexer", snippet: "kiwipiepy Pattern B · pymupdf4llm · FTS5 + LanceDB · chokidar · RRF (K=60)", keywords: ["RAG", "rrf", "fts5", "kiwi"] },
  { group: "플러그인", href: "/docs/plugins/ms-graph", title: "Microsoft 365 (Outlook)", snippet: "MSAL OAuth · safeStorage · 31개 도구 · scopes: User.Read Mail.* Calendars.*", keywords: ["outlook", "calendar", "mail"] },
  { group: "플러그인", href: "/docs/plugins/meeting", title: "Meeting (회의 녹음)", snippet: "OpenAI Whisper · PCM16LE 16kHz/3sec · 18개 도구 · meeting.ended", keywords: ["stt", "whisper", "audio"] },
  { group: "플러그인", href: "/docs/plugins/work-assistant", title: "Work Assistant (업무도우미)", snippet: "10 detectors · proactive triggerConversation · daily briefing" },
  { group: "플러그인", href: "/docs/plugins/agent-hub", title: "Agent Hub Sidebar", snippet: "ui[] slot=sidebar · 43 tools · 5분 polling · agent-hub.lvisai.xyz" },
  { group: "플러그인", href: "/docs/plugins/lge-api", title: "LGE EP (이피)", snippet: "24 tools · 6 domain · openAuthWindow 세션 · 사내망 DNS 게이트", keywords: ["lge", "ep", "lgenie"] },

  // Servers
  { group: "서버", href: "/docs/servers/marketplace", title: "Marketplace 개요", snippet: "FastAPI + SQLAlchemy 2.0 · 단일 Plugin 모델 + plugin_type · Ed25519" },
  { group: "서버", href: "/docs/servers/marketplace/plugins", title: "Marketplace — 플러그인", snippet: "GET /api/v1/catalog · POST /publishes/{id}/approve · lvis:// deeplink" },
  { group: "서버", href: "/docs/servers/marketplace/agents", title: "Marketplace — Agents", snippet: "plugin_type=agent 필터 · 별도 endpoint 없음" },
  { group: "서버", href: "/docs/servers/marketplace/mcp", title: "Marketplace — MCP", snippet: "Model Context Protocol · 기본 RiskLevel medium · ~/.lvis/mcp/" },
  { group: "서버", href: "/docs/servers/marketplace/skills", title: "Marketplace — Skills", snippet: "SKILL.md · references · 검증된 지침 번들" },
  { group: "서버", href: "/docs/servers/marketplace/publisher", title: "Marketplace — 퍼블리셔", snippet: "POST /plugins/{slug}/versions · Ed25519 sig · @lvis-marketplace/cli" },
  { group: "서버", href: "/docs/servers/marketplace/admin", title: "Marketplace — 어드민", snippet: "AdminPage 단일 페이지 · 4 탭 Catalog/Approvals/Manage/API Keys" },
  { group: "서버", href: "/docs/servers/agent-hub", title: "Agent Hub 서버 개요", snippet: "FastAPI + asyncpg + alembic · HTTPBearer + ApiKey sha256 · React 19 admin" },
  { group: "서버", href: "/docs/servers/agent-hub/workboard", title: "Agent Hub — Workboard", snippet: "work_items + work_logs append-only signed chain" },
  { group: "서버", href: "/docs/servers/agent-hub/inbox", title: "Agent Hub — Inbox", snippet: "DirectMessage · ApprovalRequest · Notification 3 모델" },
  { group: "서버", href: "/docs/servers/agent-hub/report", title: "Agent Hub — Report", snippet: "/reports/personal · /reports/team/{team_code}" },
  { group: "서버", href: "/docs/servers/agent-hub/subscription", title: "Agent Hub — 팀 피드 구독", snippet: "Subscription = team-feed opt-in (플랜/라이선스 모델 없음)" },

  // Architecture
  { group: "아키텍처", href: "/docs/architecture/overview", title: "시스템 한 눈에 보기", snippet: "4 layers · 6 active plugins · ~/.lvis · servers" },
  { group: "아키텍처", href: "/docs/architecture/diagrams", title: "다이어그램 (스택 · 흐름 · 의사결정)", snippet: "Stack · data flow · permission decision tree · plugin lifecycle SVG", keywords: ["diagram", "visual", "topology"] },
  { group: "아키텍처", href: "/docs/architecture/host-api", title: "HostApi 컨트랙트", snippet: "PluginHostApi 표면 · storage / config / callTool / agentApproval / triggerConversation" },
  { group: "아키텍처", href: "/docs/architecture/storage", title: "스토리지 — ~/.lvis", snippet: "도메인 namespace · 0o700 dir · 0o600 file · audit/<YYYY-MM-DD>.jsonl" },
  { group: "아키텍처", href: "/docs/architecture/permissions", title: "권한 모델", snippet: "RiskLevel × Category × Reviewer 4 모드 격자" },

  // Roadmap
  { group: "로드맵", href: "/docs/roadmap", title: "비전과 진화 흐름 (v1~v4)", snippet: "Connector · Sub-agent · Idle 활용 · Capability Pack · 자동화 트리거 · Hooks", keywords: ["roadmap", "future", "vision", "hook", "sub-agent"] },
];

export function searchEntries(query: string): SearchEntry[] {
  if (!query.trim()) return searchIndex;
  const q = query.toLowerCase();
  return searchIndex.filter((e) =>
    e.title.toLowerCase().includes(q) ||
    e.snippet.toLowerCase().includes(q) ||
    e.group.toLowerCase().includes(q) ||
    (e.keywords ?? []).some((k) => k.toLowerCase().includes(q))
  );
}

export function getSearchEntries(locale: "ko" | "en") {
  return locale === "en" ? searchEntriesEn : searchIndex;
}
