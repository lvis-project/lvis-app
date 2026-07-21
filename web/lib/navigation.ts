import { navigationEn } from "./navigation.en";

export type NavLink = { title: string; href: string; badge?: string };
export type NavGroup = { title: string; eyebrow?: string; items: NavLink[] };

export const navigation: NavGroup[] = [
  {
    title: "시작하기",
    eyebrow: "Getting Started",
    items: [
      { title: "LVIS AI 개요", href: "/docs/" },
      { title: "설치 & 첫 실행", href: "/docs/getting-started/install" },
      { title: "로그인 & 첫 화면", href: "/docs/getting-started/login" },
      { title: "앱 업데이트", href: "/docs/getting-started/updates" },
    ],
  },
  {
    title: "데스크톱 채팅",
    eyebrow: "Host · Chat",
    items: [
      { title: "채팅 화면 구성", href: "/docs/chat/layout" },
      { title: "메시지 큐 & TODO", href: "/docs/chat/message-queue" },
      { title: "Tool & Thinking 표시", href: "/docs/chat/tool-thinking" },
      { title: "질문 카드", href: "/docs/chat/question-cards" },
      { title: "플러그인 패널", href: "/docs/chat/plugin-panel" },
      { title: "권한 — 디렉토리", href: "/docs/chat/permissions/directory" },
      { title: "권한 — LLM 자율검토", href: "/docs/chat/permissions/llm-review" },
      { title: "권한 — 위험 관리", href: "/docs/chat/permissions/risk" },
    ],
  },
  {
    title: "호스트 기능",
    eyebrow: "Host Features",
    items: [
      { title: "Skills — 능력 꾸러미", href: "/docs/host/skills", badge: "NEW" },
      { title: "Agents — 작은 작업 단위", href: "/docs/host/agents", badge: "NEW" },
      { title: "MEMORY — 알려준 사실", href: "/docs/host/memory", badge: "NEW" },
      { title: "MCP — 외부 도구 가져오기", href: "/docs/host/mcp", badge: "NEW" },
      { title: "온보딩 — 처음 시작 안내", href: "/docs/host/onboarding", badge: "NEW" },
      { title: "신뢰 & 보안", href: "/docs/host/trust-security", badge: "NEW" },
      { title: "플러그인 결합 시나리오", href: "/docs/host/integration-recipes", badge: "NEW" },
    ],
  },
  {
    title: "루틴 & 워크플로",
    eyebrow: "Routines",
    items: [
      { title: "루틴 등록과 트리거 흐름", href: "/docs/routines/overview" },
      { title: "미팅 종료 → 자동 작업", href: "/docs/routines/meeting-end" },
    ],
  },
  {
    title: "플러그인",
    eyebrow: "Plugins",
    items: [
      { title: "플러그인이란?", href: "/docs/plugins" },
      { title: "권한 허용 흐름", href: "/docs/plugins/permission-grant" },
      { title: "Local Indexer", href: "/docs/plugins/local-indexer", badge: "RAG" },
      { title: "Microsoft 365 (Outlook)", href: "/docs/plugins/ms-graph" },
      { title: "Meeting (회의 녹음)", href: "/docs/plugins/meeting" },
      { title: "Work Assistant (업무도우미)", href: "/docs/plugins/work-assistant" },
      { title: "Agent Hub", href: "/docs/plugins/agent-hub" },
      { title: "LGE EP", href: "/docs/plugins/lge-api", badge: "사내" },
    ],
  },
  {
    title: "서버",
    eyebrow: "Servers",
    items: [
      { title: "Marketplace 개요", href: "/docs/servers/marketplace" },
      { title: "Marketplace — 플러그인", href: "/docs/servers/marketplace/plugins" },
      { title: "Marketplace — Agents", href: "/docs/servers/marketplace/agents" },
      { title: "Marketplace — MCP", href: "/docs/servers/marketplace/mcp" },
      { title: "Marketplace — Skills", href: "/docs/servers/marketplace/skills" },
      { title: "Marketplace — 퍼블리셔", href: "/docs/servers/marketplace/publisher" },
      { title: "Marketplace — 어드민", href: "/docs/servers/marketplace/admin" },
      { title: "Agent Hub 서버 개요", href: "/docs/servers/agent-hub" },
      { title: "Agent Hub — 워크보드", href: "/docs/servers/agent-hub/workboard" },
      { title: "Agent Hub — 인박스", href: "/docs/servers/agent-hub/inbox" },
      { title: "Agent Hub — 리포트", href: "/docs/servers/agent-hub/report" },
      { title: "Agent Hub — 팀 피드 구독", href: "/docs/servers/agent-hub/subscription" },
    ],
  },
  {
    title: "아키텍처",
    eyebrow: "Architecture",
    items: [
      { title: "시스템 한 눈에 보기", href: "/docs/architecture/overview" },
      { title: "다이어그램 (스택 · 흐름)", href: "/docs/architecture/diagrams", badge: "NEW" },
      { title: "HostApi 컨트랙트", href: "/docs/architecture/host-api" },
      { title: "스토리지 — ~/.lvis", href: "/docs/architecture/storage" },
      { title: "권한 모델", href: "/docs/architecture/permissions" },
    ],
  },
  {
    title: "로드맵",
    eyebrow: "Roadmap",
    items: [
      { title: "비전과 진화 흐름", href: "/docs/roadmap", badge: "NEW" },
    ],
  },
];

export function flattenNav(): NavLink[] {
  return navigation.flatMap((g) => g.items);
}

export function getNavigation(locale: "ko" | "en") {
  return locale === "en" ? navigationEn : navigation;
}

export function flattenNavFor(locale: "ko" | "en") {
  return getNavigation(locale).flatMap((g) => g.items);
}
