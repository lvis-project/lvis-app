# LVIS App (Host) — Claude Code Directives

## Architecture Reference

This is the Electron host app. ALL implementation follows `docs/architecture/architecture.md` (v4 Final).
Always check `../TODO.md` for current status across all components.

## Project Structure

See `docs/architecture/architecture.md` §4.6 and `docs/blueprints/phase3-folder-refactor-plan.md` for the canonical layout and module boundary rules.

```
src/
  main.ts                     — Electron entry point
  boot.ts                     — §4.2 Boot Sequence (service init, plugin loading)
  ipc-bridge.ts               — All IPC handlers (settings, chat, memory, plugins)
  preload.ts / preload.cjs    — Electron preload scripts
  renderer.tsx                — minimal entry mounting ui/renderer/App.tsx
  plugin-ui-host.tsx          — Dynamic plugin UI mounting

  ui/renderer/                — Renderer composition root (Phase 1~4.6 split 완료)
    App.tsx                   — composition root (<300 lines)
    ChatView.tsx · Sidebar.tsx · SettingsDialog.tsx · MainToolbar.tsx
    context/                  — ChatContext (state provider for ChatView subtree)
    hooks/                    — 14 domain hooks (settings, chat-state, briefing,
                               approval, search, context-budget, cost-estimate,
                               sessions, starred, plugin-marketplace, role-presets,
                               app-bootstrap, indexed-docs, marketplace-updates)
                               ProactiveTriggerCoordinator — 5 signals (idle/schedule/meeting/task-deadline/post-turn)
    components/               — BriefingCard, AssistantCard, UserMessageEditor,
                               ReasoningCard, ToolApprovalDialog, ToolGroupCard,
                               ChatSearchOverlay, Sparkline, UsageDashboard,
                               HtmlPreview (partition lvis-render-html, webRequest block A5),
                               StarredView, MarketplaceUpdateBanner
    dialogs/                  — ApprovalDialog, PluginInstallDialog,
                               PluginUninstallDialog, CommandPaletteDialog
    tabs/                     — RolesTab, PermissionsTab, AuditTab,
                               PluginPerfTab, PrivacyTab
    utils/                    — cost-format, html-preview, history, compose
    types.ts · constants.ts · api-client.ts

  engine/                     — Agent loop + LLM providers (was src/agent/)
    conversation-loop.ts      — §4.5 Core agentic cycle (stream + tool loop)
    conversation-history.ts   — In-memory message management
    auto-compact.ts           — Token-aware history compression
    llm/
      types.ts                — Vendor-agnostic LLM interfaces
      provider-factory.ts     — Vendor selection factory (routes to VercelUnifiedProvider)
      vercel/                 — VercelUnifiedProvider — single LLM adapter for all vendors

  tools/                      — 1-file-per-tool (Tier S3 BaseTool pattern)
    executor.ts               — §4.5.6 8-step pipeline with hooks (was tool-executor.ts)
    knowledge-search.ts       — LLM agentic knowledge search (was knowledge-search-tool.ts)

  prompts/                    — System prompt assembly
    system-prompt-builder.ts  — §4.5.9 12-source prompt assembly

  hooks/                      — PreTool / PostTool interception
    hook-runner.ts            — Pre/Post tool execution hooks
    post-turn-hook-chain.ts   — compact → save → extract → audit → idle-poke

  permissions/                — Full permission stack (was partly in core/, partly in agent/)
    permission-manager.ts     — §6.3 Source-aware permission model
    permissions-store.ts      — ~/.lvis/permissions.json persistence
    policy-store.ts           — Admin policy + governance rules
    approval-gate.ts          — §8 Layer 3 ask-user modal gate
    agent-action-requester.ts — §8 Agent Hub approval caller skeleton

  sandbox/                    — Path boundary enforcement (Tier A3 — placeholder)

  memory/                     — §5 File-based memory (~/.lvis/)
    memory-manager.ts

  audit/                      — Audit logger + DLP filter (was in agent/)
    audit-logger.ts
    dlp-filter.ts

  core/                       — Remaining cross-cutting engines
    keyword-engine.ts         — §6.1 Input classification
    route-engine.ts           — §6.2 Routing resolution
    tool-registry.ts          — §6.4 Unified tool registry (deprecated by tools/base.ts eventually)
    proactive-engine.ts       — §7 Proactive briefing

  mcp/                        — Model Context Protocol client (unchanged)

  plugins/                    — Plugin runtime (was plugin-runtime/)
    types.ts                  — PluginManifest, HostApi, RuntimePlugin
    runtime.ts                — Plugin loading, HostApi injection
    marketplace.ts            — Install/remove plugins
    registry.ts               — Plugin registry file management
    deployment-guard.ts       — Deployment mode enforcement

  data/
    settings-store.ts         — Multi-vendor settings + encrypted API keys

  main/                       — Electron main-process helpers (corp-ca, python-runtime, ...)
  lib/                        — Pure TS utilities (approval-queue-reducer, utils)
  components/ui/              — shadcn
  ui/                         — LVIS-custom UI components/views
```

## Key Principles

1. **NO plugin-specific code in host** — All plugin integration via HostApi self-registration
2. **Two naming namespaces** — Plugin IDs use dot format (`com.lge.meeting-recorder`); LLM tool names use underscore-only (`meeting_start`). No runtime conversion — methods must be declared in underscore form in the manifest.
3. **Multi-vendor LLM** — GenericMessage abstraction, never vendor-specific in core logic
4. **Config wildcard** — `configOverrides["*"]` passes API keys to all plugins

## Playwright Verification (REQUIRED for app changes)

UI/렌더러 변경은 **반드시 Playwright e2e 검증** 거친 후 머지. 빌드/typecheck/단위 테스트만으로는 시각적 회귀를 잡을 수 없음 — 실제 사용자 플로우가 깨지지 않았는지 마지막에 한 번 더 확인.

- **테마/색상/투명도**, **dialog/modal**, **floating panel**, **chat 흐름** 변경 → e2e 필수
- 단순 타입 정의, 백엔드 모듈, 도구 레이어 등 렌더러 영향 없는 변경 → 면제 가능
- CI 의 `ui-e2e.yml` / `e2e.yml` / `m4-e2e.yml` 가 자동 실행. 로컬 검증은 `bunx playwright test`
- e2e 가 빨간 채로 머지하면 안 됨 — admin merge 로 우회 시 즉시 후속 fix PR 의무

위반 시 시각적 회귀 (예: 2026-04-30 styles.css conflict marker 잔존 가설 — typecheck/단위 통과했지만 PostCSS 가 silent fail 하면 e2e 만 잡을 수 있음) 가 production 까지 흘러갈 수 있음.

## No Fallback Code (REQUIRED)

루트 CLAUDE.md `No Fallback Code` 룰 그대로 적용 — 처음부터 올바른 코드 작성. 본 레포 specific 사례:

- 플러그인 manifest 에 새 필드 추가 시: schema 와 SDK 타입을 **같은 PR 에서 함께** 업데이트. "schema 만 먼저 추가하고 type 은 나중에" 식의 단계적 접근 금지 — AJV strict 가 deny 하거나 type-cast 가 필요한 fallback 강요됨
- 새 IPC 채널 추가 시: handler / preload bridge / renderer 타입 / 호출 사이트가 한 PR 에 모두 있어야 함. 일부만 있으면 호출 측에 `if (typeof api.x === "function") { api.x() } else { fallback }` 같은 우회 코드 강요됨
- HostApi 변경 시: 모든 플러그인 dep 도 같은 PR 에서 sdk 새 버전으로 bump. 누락하면 plugin 코드가 `(hostApi as any).newMethod?.()` 우회 작성
- 가시적 회귀 (theme/transparency/animation) 발견 시: 우선순위 SEV-1 fix, hotfix branch 로 즉시 처리 — fallback 토큰 추가로 가리지 말 것

## Build

This repo uses **bun** as the default package manager + script runner.
The Electron runtime itself still launches via Node (`scripts/run-electron.mjs`
invokes the `electron` binary which uses its embedded Node). Bun is NOT used to
execute the Electron process.

> **Node CLI required:** Even though bun is the default runner, the `postinstall`
> script (`node scripts/fetch-uv.mjs`) and the Electron launcher
> (`scripts/run-electron.mjs`) invoke the system `node` binary directly.
> Electron's embedded Node is **not** a `node` executable on PATH, so a
> standalone **Node.js ≥ 18** installation is required on the developer machine.

```bash
bun install            # Install deps (runs electron-rebuild + fetch-uv postinstall)
bun run build          # TypeScript + esbuild renderer + Tailwind CSS
bun run start          # build + Electron launch (Electron runs on Node)
bunx vitest run        # Run tests
```

## TODO Tracking

Always update `../TODO.md` when completing or discovering work items.
Relevant sections: 1 (Boot), 2 (ConversationLoop), 6 (Core Engines), 9 (Plugin System), 10 (LLM), 11 (Memory), 12 (UI).

## Team Discipline (Multi-Worker)

멀티 워커 환경에서 textual conflict 없이 발생하는 semantic regression 방어 — 자세한 사례/체크리스트/플레이북은 `docs/development/multi-worker-discipline.md` 참조.

- **Main 항상 green**: rebase-then-merge + branch protection + post-merge smoke. 깨지면 즉시 revert PR (책임자 = 마지막 머지자).
- **SoT 이동은 한 PR 안에서 sweep**: validator + 파생 TS const + 테스트 fixture lockstep. `grep -rn "<old>"` 0건 + `bun run test` pass 확인 후 머지.
- **State-A↔B sync race 는 한 flushSync**: derived-state cleanup useEffect 가 있으면 두 state 의 모든 call site 가 한 commit 안에 batch 되었는지 확인 (anti-pattern: `flushSync(setA); B();`).
- **Cross-repo contract sync**: host ↔ SDK ↔ plugin repos ↔ template ↔ marketplace 변경은 같은 세션 안에 모든 dependent repo sweep. PR description 에 companion PR 명시.
