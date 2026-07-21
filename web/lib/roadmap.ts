/**
 * LVIS 비전 — 버전별 묶음 (v1 → v4).
 * 일정 (연도 / 분기) 은 문서에 노출하지 않습니다.
 */

export type Status = "shipping" | "in-progress" | "planned" | "exploring";

export interface Milestone {
  title: string;
  titleEn: string;
  status: Status;
  detail: string;
  detailEn: string;
  /** optional anchor on /architecture/diagrams page that visualizes this milestone */
  diagramAnchor?: string;
}

export interface VersionPlan {
  /** v1, v2, ... */
  version: string;
  theme: string;
  themeEn: string;
  vibe: "foundation" | "autonomous" | "open" | "frontier";
  milestones: Milestone[];
}

export const versions: VersionPlan[] = [
  {
    version: "v1",
    theme: "Foundation — 플러그인을 Connector 수준으로",
    themeEn: "Foundation — Elevating plugins to connector status",
    vibe: "foundation",
    milestones: [
      {
        title: "Plugin Workspace — 풍부한 UI",
        titleEn: "Plugin Workspace — richer UI",
        status: "in-progress",
        detail:
          "지금까지 플러그인은 사이드바 안의 작은 영역 하나만 가질 수 있었습니다. 다음 단계에서는 자체 워크스페이스 · 멀티 패널 · 드래그 가능한 위젯을 가질 수 있도록 확장합니다.",
        detailEn:
          "Until now, a plugin could only have one small area inside the sidebar. The next step expands this so plugins can have their own workspace, multiple panels, and draggable widgets.",
      },
      {
        title: "Capability Pack — 한 묶음 발행",
        titleEn: "Capability Pack — publish as a single bundle",
        status: "planned",
        detail:
          "지금은 플러그인 · Agent · MCP · Skill 네 가지가 따로 발행/설치됩니다. 한 발행자가 한 패키지로 묶어 내보내면 사용자는 한 번에 설치합니다.",
        detailEn:
          "Today, plugins, agents, MCP, and skills are each published and installed separately. Once a publisher bundles them into one package, users can install everything in a single step.",
        diagramAnchor: "future",
      },
      {
        title: "더 풍부한 자동화 트리거",
        titleEn: "Richer automation triggers",
        status: "exploring",
        detail:
          "지금은 ‘종료 시점’ 과 ‘예약 시간’ 두 가지 트리거만 있습니다. 메일 / 회의 / 캘린더 이벤트를 조합한 조건부 자동화로 확장합니다.",
        detailEn:
          "Right now there are only two triggers: \"on end\" and \"scheduled time.\" This expands into conditional automation combining email, meeting, and calendar events.",
      },
      {
        title: "플러그인 생명주기 단계 확장",
        titleEn: "Expanding plugin lifecycle stages",
        status: "planned",
        detail:
          "플러그인이 설치되었을 때 / 활성화되었을 때 / 토큰이 만료되었을 때 등 더 많은 시점에 자기 동작을 정의할 수 있도록 합니다.",
        detailEn:
          "Lets plugins define their own behavior at more points in time — when installed, when activated, when a token expires, and more.",
        diagramAnchor: "future",
      },
    ],
  },
  {
    version: "v2",
    theme: "Autonomous — 플러그인이 작은 에이전트로",
    themeEn: "Autonomous — plugins become small agents",
    vibe: "autonomous",
    milestones: [
      {
        title: "Plugin = Sub-agent (자율 실행)",
        titleEn: "Plugin = Sub-agent (autonomous execution)",
        status: "exploring",
        detail:
          "지금 플러그인은 호출이 들어올 때만 응답합니다. 다음 단계에서는 사용자의 동의를 받으면 플러그인이 자기 판단으로 여러 도구를 차례로 호출하는 작은 에이전트가 됩니다.",
        detailEn:
          "Plugins currently only respond when called. In the next step, once the user consents, a plugin becomes a small agent that calls multiple tools in sequence on its own judgment.",
        diagramAnchor: "future",
      },
      {
        title: "Idle 시간 활용",
        titleEn: "Making use of idle time",
        status: "exploring",
        detail:
          "사용자가 LVIS를 안 보고 있을 때 인덱싱 · 요약 · 미리 준비 같은 일을 조용히 처리하고, 사용자가 돌아오면 즉시 양보합니다.",
        detailEn:
          "While the user isn't looking at LVIS, it quietly handles work like indexing, summarizing, and preparing ahead of time, then yields immediately once the user returns.",
      },
      {
        title: "살아 있는 위젯",
        titleEn: "Live widgets",
        status: "planned",
        detail:
          "정적 카드를 넘어, 채팅 본문 안에 실시간으로 갱신되는 위젯을 띄울 수 있습니다 — 예: 회의 transcript 위젯이 STT 결과를 실시간 표시.",
        detailEn:
          "Beyond static cards, widgets that update in real time can appear inside the chat body — for example, a meeting transcript widget showing STT results live.",
      },
      {
        title: "호스트 흐름에 끼어드는 표준 접점 (Hooks)",
        titleEn: "Standard hook points into the host flow",
        status: "exploring",
        detail:
          "도구 실행 직전/직후, 권한 부여 시점 등 호스트 흐름의 표준 지점에 플러그인이 안전하게 개입할 수 있는 접점을 노출합니다.",
        detailEn:
          "Exposes standard points in the host flow — right before/after tool execution, when permission is granted, and more — where plugins can safely hook in.",
        diagramAnchor: "future",
      },
    ],
  },
  {
    version: "v3",
    theme: "Open — 외부 세계와 연결",
    themeEn: "Open — connecting to the outside world",
    vibe: "open",
    milestones: [
      {
        title: "로컬 LLM 대체 경로",
        titleEn: "Local LLM fallback path",
        status: "exploring",
        detail:
          "네트워크가 끊겨도 핵심 흐름이 동작하도록, 온디바이스 LLM (Ollama 등) 으로 자동 전환할 수 있습니다.",
        detailEn:
          "Can automatically switch to an on-device LLM (such as Ollama) so core flows keep working even when the network is down.",
      },
      {
        title: "Federation — 다른 호스트와 연결",
        titleEn: "Federation — connecting to other hosts",
        status: "exploring",
        detail:
          "지금은 한 조직 안에서만 동작합니다. 다른 LVIS 사용자에게 작업을 위임하거나 메시지를 주고받을 수 있도록 확장합니다.",
        detailEn:
          "Currently this only works within a single organization. This expands it so work can be delegated to, or messages exchanged with, other LVIS users.",
        diagramAnchor: "future",
      },
      {
        title: "외부 MCP 서버 자동 분류",
        titleEn: "Automatic classification of external MCP servers",
        status: "planned",
        detail:
          "외부 MCP 서버의 도구를 자동으로 위험도 평가하고, 운영자가 빠르게 승인할 수 있도록 합니다.",
        detailEn:
          "Automatically assesses the risk of tools from external MCP servers so operators can approve them quickly.",
      },
    ],
  },
  {
    version: "v4",
    theme: "Frontier — 더 안전하고, 더 가까이",
    themeEn: "Frontier — safer, and closer at hand",
    vibe: "frontier",
    milestones: [
      {
        title: "더 단단한 플러그인 격리",
        titleEn: "Stronger plugin isolation",
        status: "exploring",
        detail:
          "외부 발행자의 패키지를 더 안전하게 실행할 수 있도록 메모리 / CPU / 네트워크 사용량 한도를 부여하는 샌드박스를 도입합니다.",
        detailEn:
          "Introduces a sandbox that caps memory, CPU, and network usage so third-party publisher packages can run more safely.",
      },
      {
        title: "사용자 자동화 성과 보드",
        titleEn: "User automation performance board",
        status: "planned",
        detail:
          "내가 받은 제안 중 얼마나 수락했는지, 어떤 자동화가 시간을 가장 많이 절약했는지 한 화면에서 봅니다.",
        detailEn:
          "See on one screen how many of the suggestions you received you accepted, and which automations saved the most time.",
      },
      {
        title: "모바일 · 외부 도구 컴패니언",
        titleEn: "Mobile and external-tool companions",
        status: "exploring",
        detail:
          "보드 / 인박스 / 승인 응답만 빠르게 처리할 수 있는 모바일 앱과 IDE / 런처 확장을 제공합니다.",
        detailEn:
          "Provides a mobile app and IDE/launcher extensions for quickly handling just the board, inbox, and approval responses.",
      },
    ],
  },
];

export const axes = [
  {
    id: "connector",
    title: "플러그인 → Connector + UI",
    titleEn: "Plugin to Connector + UI",
    summary:
      "단순 도구 호출에 머무르지 않고, 자체 워크스페이스와 살아있는 위젯까지 제공하는 1급 connector 로 자랍니다.",
    summaryEn:
      "Grows beyond simple tool-calling into a first-class connector that also provides its own workspace and live widgets.",
    accent: "teal",
  },
  {
    id: "sub-agent",
    title: "플러그인 = Sub-agent",
    titleEn: "Plugin = Sub-agent",
    summary:
      "플러그인이 자기 판단으로 여러 도구를 연달아 호출하는 작은 에이전트가 됩니다. 위임 범위는 사용자가 정해줍니다.",
    summaryEn:
      "Plugins become small agents that call multiple tools in a row on their own judgment. The user sets the scope of delegation.",
    accent: "coral",
  },
  {
    id: "idle",
    title: "Idle 시간 활용",
    titleEn: "Making use of idle time",
    summary:
      "사용자가 안 보고 있을 때 인덱싱 / 요약 / 준비 작업을 조용히 처리하고, 돌아오면 즉시 양보합니다.",
    summaryEn:
      "Quietly handles indexing, summarizing, and prep work while the user isn't looking, then yields immediately once they return.",
    accent: "citron",
  },
  {
    id: "capability",
    title: "Capability Pack",
    titleEn: "Capability Pack",
    summary:
      "지금 따로 발행되는 플러그인 · Agent · MCP · Skill 을 한 묶음으로 합쳐 한 번에 발행 / 한 번에 설치할 수 있게 합니다.",
    summaryEn:
      "Combines plugins, agents, MCP, and skills — currently published separately — into one bundle for single-step publish and install.",
    accent: "ink",
  },
  {
    id: "trigger",
    title: "더 풍부한 자동화",
    titleEn: "Richer automation",
    summary:
      "단순한 시간 / 종료 트리거를 넘어, 메일 · 회의 · 캘린더 이벤트를 조합한 조건부 자동화로 확장합니다.",
    summaryEn:
      "Expands beyond simple time/end triggers into conditional automation that combines email, meeting, and calendar events.",
    accent: "teal",
  },
  {
    id: "hooks",
    title: "Hooks — 끼어들 수 있는 표준 접점",
    titleEn: "Hooks — standard points to plug into",
    summary:
      "도구 실행 / 권한 부여 / 라우틴 발사 등 호스트 흐름의 표준 지점에 플러그인이 안전하게 개입할 수 있는 접점을 노출합니다.",
    summaryEn:
      "Exposes standard points in the host flow — tool execution, permission grants, routine firing, and more — where plugins can safely step in.",
    accent: "coral",
  },
] as const;
