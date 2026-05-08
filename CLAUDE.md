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
  ipc-bridge.ts               — Compatibility re-export shim. Real handlers
                                live under `src/ipc/domains/*` and are wired
                                from `src/ipc/index.ts`.
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

## Storage Namespace per Feature (REQUIRED)

LVIS host + plugin 의 모든 user-data storage 는 **`~/.lvis/<feature>/`** 디렉토리 namespace 로 격리한다. *feature* 는 host 도메인 (chat sessions, routine, audit log 등) 또는 plugin id (`work-proactive`, `meeting`, `local-indexer` 등).

### 정합 패턴

```
~/.lvis/
├── sessions/                          # main chat (host)
│   └── <sessionId>.jsonl
├── routine/                           # routine v2 (host) — Q9 isolation
│   ├── routines.json
│   └── sessions/<routineId>/<firedAt>.jsonl
├── settings.json                      # cross-cutting host settings
├── audit.log                          # cross-cutting audit
├── secrets/                           # cross-cutting secrets (encrypted)
└── plugins/<pluginId>/                # plugin per-namespace
    ├── data.json
    └── ...
```

### 룰

- **단일 도메인 = 단일 디렉토리**. 같은 도메인의 설정 + session + cache + state 모두 그 디렉토리 하위에 모은다.
- **디렉토리 권한**: 0o700 (디렉토리), 0o600 (파일). secrets 는 추가 암호화 의무.
- **Cross-cutting 자원** (`settings.json`, `audit.log`, `secrets/`) 만 `~/.lvis/` 직속. 도메인 specific 자원이 root 에 흩어지면 안 됨.
- **Plugin 자체 data** 는 `~/.lvis/plugins/<pluginId>/` 만 사용. host 의 다른 디렉토리 (`~/.lvis/routine/` 등) 직접 read/write 금지 — host API (예: `hostApi.addTask`, `hostApi.saveNote`) 통한 access 만.
- **Backup / clear**: 도메인 단위 (`rm -rf ~/.lvis/<feature>/`) 가능해야 함.

### 효과

1. **Operational ergonomics** — 도메인 단위 backup/restore/clear
2. **Permission boundary** — plugin namespace 밖 access 시 host capability check 자연 trigger
3. **Architectural visibility** — 디렉토리 구조 자체가 도메인 격리 표현
4. **Plugin extensibility 정합** — `plugins/<id>/` convention 이 host 도메인과 동등 위계

### 위반 패턴

- `~/.lvis/<feature>.json` (root 에 도메인 specific 파일) → `~/.lvis/<feature>/<feature>.json`
- plugin 이 host 의 `~/.lvis/sessions/` 직접 read → host API 통한 access
- 새 feature 추가 시 root 에 새 파일 추가 → `~/.lvis/<new-feature>/` 신설

위반 사례 (2026-05-09 Routine v2 PR #626 도입 전): `~/.lvis/routines.json` + `~/.lvis/routine-sessions/` 두 path 가 root 에 분산 → 단일 namespace `~/.lvis/routine/` 로 consolidate. Q9 isolation lock 의 정확한 운영.

## Key Principles

1. **NO plugin-specific code in host** — All plugin integration via HostApi self-registration
2. **Two naming namespaces** — Plugin IDs use dot format (`com.lge.meeting-recorder`); LLM tool names use underscore-only (`meeting_start`). No runtime conversion — methods must be declared in underscore form in the manifest.
3. **Multi-vendor LLM** — GenericMessage abstraction, never vendor-specific in core logic
4. **Config wildcard** — `configOverrides["*"]` passes API keys to all plugins

## Information Source Hierarchy

LVIS 사설 자산 정보는 *공개 검색 엔진에 인덱스 없음*. 아래 순서로 lookup:

| 정보 유형 | 1순위 source | 2순위 source | ❌ 사용 금지 |
|---|---|---|---|
| 마켓플레이스 plugin 최신 버전 | `curl https://marketplace.lvisai.xyz/api/v1/plugins/<slug>` | `git -C lvis-plugin-<slug> tag --sort=-creatordate` | WebSearch |
| 설치된 plugin 버전 | `cat ~/.lvis/plugins/<slug>/plugin.json \| jq .version` | `cat lvis-plugin-<slug>/plugin.json` | WebSearch |
| 호스트 LVIS 자체 버전 | `cat lvis-app/package.json \| jq .version` | `git -C lvis-app log --oneline -1` | WebSearch |
| LVIS 내부 SDK / 의존성 | repo 의 `package.json` + git tag | — | WebSearch (사설 패키지 미인덱스) |
| LVIS 내부 이슈 / PR 상태 | `gh -R lvis-project/<repo> pr list` | `gh -R lvis-project/<repo> issue list` | WebSearch |

**실제 실패 사례 (2026-05-07)**: `lvis-plugin-agent-hub` 최신 버전 확인 작업에서 agent 가 `WebSearch("lvis plugin-agent-hub 0.2.17 release")` 를 반복 → blackmagicdesign.com 등 무관 결과만 반환 → 28 step 후 결론 없이 종료. 정답은 marketplace API 1회 호출.

**Loop escape clause**: 동일 카테고리 도구로 *3회 연속 zero-relevance 결과* 시 즉시 다른 카테고리로 전환 (e.g. WebSearch → `Bash + curl`).

**Why**: 외부 검색은 공개 인덱스 가정. 사설/내부/on-machine 정보는 인덱스 부재 → 무한 재시도해도 결과 없음. 도메인 인식이 도구 선택의 첫 step.

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
