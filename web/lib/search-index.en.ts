import type { SearchEntry } from "./search-index";

export const searchEntriesEn: SearchEntry[] = [
  // Getting Started
  { group: "Getting Started", href: "/en/docs/", title: "LVIS AI Overview", snippet: "Desktop host · plugin runtime · storage · server, 4 layers", keywords: ["overview", "intro"] },
  { group: "Getting Started", href: "/en/docs/getting-started/install", title: "Install & First Launch", snippet: "macOS arm64 / Windows / Linux AppImage · electron-updater · lvis:// registration" },
  { group: "Getting Started", href: "/en/docs/getting-started/login", title: "Login & First Screen", snippet: "Marketplace SSO · ApiKey sha256 · Agent Hub PKCE", keywords: ["sso", "auth"] },
  { group: "Getting Started", href: "/en/docs/getting-started/updates", title: "App Updates", snippet: "electron-updater · autoDownload=false · 4h interval · channel=latest" },

  // Host · Chat
  { group: "Chat", href: "/en/docs/chat/layout", title: "Chat Screen Layout", snippet: "AppShell · Sidebar · MainToolbar · MainContent · ChatView" },
  { group: "Chat", href: "/en/docs/chat/message-queue", title: "Message Queue & TODO", snippet: "MessageQueuePanel + SessionTodoPanel · above the composer · hidden when empty" },
  { group: "Chat", href: "/en/docs/chat/tool-thinking", title: "Tool & Thinking Display", snippet: "Tool Registry · three sources · background shell · view image · tool search" },
  { group: "Chat", href: "/en/docs/chat/question-cards", title: "Question Cards", snippet: "AskUserQuestionItem · choice-only · choice/choices · recommendedIndex · altIndices" },
  { group: "Chat", href: "/en/docs/chat/plugin-panel", title: "Plugin Panel", snippet: "manifest ui[] slots · bundled Skills · pure Tools · regex ^[a-zA-Z_][a-zA-Z0-9_]*$" },
  { group: "Chat", href: "/en/docs/chat/permissions/directory", title: "Permissions — Directory", snippet: "storage sandbox + host grant · ~/.lvis/permissions.json (0o600)" },
  { group: "Chat", href: "/en/docs/chat/permissions/llm-review", title: "Permissions — LLM Autonomous Review", snippet: "Reviewer 4 modes: disabled/rule/llm/strict" },
  { group: "Chat", href: "/en/docs/chat/permissions/risk", title: "Permissions — Risk Management", snippet: "RiskLevel low/medium/high × 5 categories grid · agentApproval" },

  // Host Features
  { group: "Host Features", href: "/en/docs/host/skills", title: "Skills — Ability Packs", snippet: "Invoke frequent tasks with one line. Trigger keywords + tool mapping + risk level", keywords: ["skill", "skills", "keyword", "keywords"] },
  { group: "Host Features", href: "/en/docs/host/agents", title: "Agents — Small Units of Work", snippet: "An autonomous unit that does one task well. Agents spawn sub-agents and resume them", keywords: ["agent", "agents", "subagent"] },
  { group: "Host Features", href: "/en/docs/host/memory", title: "MEMORY — Remembering What You Told It", snippet: "Role · preferences · constraints. Automatic capture is off by default; project AGENTS.md is read too", keywords: ["memory", "AGENTS.md"] },
  { group: "Host Features", href: "/en/docs/host/mcp", title: "MCP — Bringing In External Tools", snippet: "A server's tools, resources, prompts and instructions. External tools ask every time", keywords: ["mcp", "external tools", "resource", "prompt"] },
  { group: "Host Features", href: "/en/docs/host/onboarding", title: "Onboarding — First-Run Guide", snippet: "Short tour on first launch + memory seed input + can be revisited anytime", keywords: ["onboarding", "tour", "start"] },
  { group: "Host Features", href: "/en/docs/host/trust-security", title: "Trust & Security", snippet: "Source verification · version withdrawal · load-failure cards · secrets · audit log · no-fallback", keywords: ["trust", "security", "audit"] },
  { group: "Host Features", href: "/en/docs/host/integration-recipes", title: "Integration Recipes — Combined Scenarios", snippet: "Meeting → action → schedule → reply · research → presentation · meeting room + video call · video call → minutes → team board", keywords: ["recipe", "integration", "scenario"] },

  // Routines
  { group: "Routines", href: "/en/docs/routines/overview", title: "Routine Registration & Trigger Flow", snippet: "RoutineEngine · triggers shutdown | schedule · per-fire fresh loop" },
  { group: "Routines", href: "/en/docs/routines/meeting-end", title: "Meeting End → Automatic Task", snippet: "meeting.summary.created → work-assistant meeting-summary detector" },

  // Plugins
  { group: "Plugins", href: "/en/docs/plugins", title: "Plugins — Overview", snippet: "static manifest · tools declared in the manifest · tool list fixed per server generation" },
  { group: "Plugins", href: "/en/docs/plugins/permission-grant", title: "Permission Grant Flow", snippet: "12 capabilities · tools[] · pluginAccess · agentApprovalScopes" },
  { group: "Plugins", href: "/en/docs/plugins/local-indexer", title: "Local Indexer", snippet: "kiwipiepy Pattern B · pymupdf4llm · FTS5 + LanceDB · chokidar · RRF (K=60)", keywords: ["RAG", "rrf", "fts5", "kiwi"] },
  { group: "Plugins", href: "/en/docs/plugins/ms-graph", title: "Microsoft 365 (Outlook)", snippet: "MSAL OAuth · safeStorage · 31 tools · scopes: User.Read Mail.* Calendars.*", keywords: ["outlook", "calendar", "mail", "ms-graph"] },
  { group: "Plugins", href: "/en/docs/plugins/meeting", title: "Meeting (Recording)", snippet: "OpenAI Whisper · PCM16LE 16kHz/3sec · 18 tools · meeting.ended", keywords: ["stt", "whisper", "audio"] },
  { group: "Plugins", href: "/en/docs/plugins/work-assistant", title: "Work Assistant", snippet: "10 detectors · proactive triggerConversation · daily briefing" },
  { group: "Plugins", href: "/en/docs/plugins/agent-hub", title: "Agent Hub Sidebar", snippet: "ui[] slot=sidebar · 43 tools · 5-min polling · agent-hub.lvisai.xyz" },

  // Servers
  { group: "Servers", href: "/en/docs/servers/marketplace", title: "Marketplace Overview", snippet: "FastAPI + SQLAlchemy 2.0 · single Plugin model + plugin_type · Ed25519" },
  { group: "Servers", href: "/en/docs/servers/marketplace/plugins", title: "Marketplace — Plugins", snippet: "GET /api/v1/catalog · POST /publishes/{id}/approve · lvis:// deeplink" },
  { group: "Servers", href: "/en/docs/servers/marketplace/agents", title: "Marketplace — Agents", snippet: "plugin_type=agent filter · no separate endpoint" },
  { group: "Servers", href: "/en/docs/servers/marketplace/mcp", title: "Marketplace — MCP", snippet: "Model Context Protocol · default RiskLevel medium · ~/.lvis/mcp/" },
  { group: "Servers", href: "/en/docs/servers/marketplace/skills", title: "Marketplace — Skills", snippet: "SKILL.md · references · verified instruction bundles" },
  { group: "Servers", href: "/en/docs/servers/marketplace/publisher", title: "Marketplace — Publisher", snippet: "POST /plugins/{slug}/versions · Ed25519 signature · @lvis-marketplace/cli" },
  { group: "Servers", href: "/en/docs/servers/marketplace/admin", title: "Marketplace — Admin", snippet: "Single-page AdminPage · 4 tabs: Catalog/Approvals/Manage/API Keys" },
  { group: "Servers", href: "/en/docs/servers/agent-hub", title: "Agent Hub Server Overview", snippet: "FastAPI + asyncpg + alembic · HTTPBearer + ApiKey sha256 · React 19 admin" },
  { group: "Servers", href: "/en/docs/servers/agent-hub/workboard", title: "Agent Hub — Workboard", snippet: "work_items + work_logs append-only signed chain" },
  { group: "Servers", href: "/en/docs/servers/agent-hub/inbox", title: "Agent Hub — Inbox", snippet: "DirectMessage · ApprovalRequest · Notification, 3 models" },
  { group: "Servers", href: "/en/docs/servers/agent-hub/report", title: "Agent Hub — Report", snippet: "/reports/personal · /reports/team/{team_code}" },
  { group: "Servers", href: "/en/docs/servers/agent-hub/subscription", title: "Agent Hub — Team Feed Subscription", snippet: "Subscription = team-feed opt-in (no plan/license model)" },

  // Architecture
  { group: "Architecture", href: "/en/docs/architecture/overview", title: "System at a Glance", snippet: "4 layers · plugins · ~/.lvis · servers" },
  { group: "Architecture", href: "/en/docs/architecture/diagrams", title: "Diagrams (Stack · Flow · Decisions)", snippet: "Stack · data flow · permission decision tree · plugin lifecycle SVG", keywords: ["diagram", "visual", "topology"] },
  { group: "Architecture", href: "/en/docs/architecture/host-api", title: "HostApi Contract", snippet: "PluginHostApi surface · child-process boundary · asynchronous secret lookup", keywords: ["hostapi", "isolation", "process"] },
  { group: "Architecture", href: "/en/docs/architecture/storage", title: "Storage — ~/.lvis", snippet: "Domain namespace · 0o700 dir · 0o600 file · audit/<YYYY-MM-DD>.jsonl" },
  { group: "Architecture", href: "/en/docs/architecture/permissions", title: "Permission Model", snippet: "Risk × category × 4 review modes · a sub-agent's asks go to its parent first", keywords: ["permissions", "subagent", "adjudication"] },

  // Roadmap
  { group: "Roadmap", href: "/en/docs/roadmap", title: "Vision & Evolution (v1–v4)", snippet: "Connector · sub-agent · idle utilization · Capability Pack · automation triggers · Hooks", keywords: ["roadmap", "future", "vision", "hook", "sub-agent"] },
];
