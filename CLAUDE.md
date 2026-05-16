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
    overlay-trigger-source.ts — overlay trigger source contract

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
├── routine/                           # routine v2 (host) — isolated sessions
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

위반 사례 (2026-05-09 Routine v2 PR #626 도입 전): `~/.lvis/routines.json` + `~/.lvis/routine-sessions/` 두 path 가 root 에 분산 → 단일 namespace `~/.lvis/routine/` 로 consolidate. Routine session isolation lock 의 정확한 운영.

## Key Principles

1. **NO plugin-specific code in host** — All plugin integration via HostApi self-registration
2. **Three naming namespaces** — Plugin identifiers come in three forms with **no runtime conversion** between them:
   - **Plugin IDs**: dot or kebab-case (`com.example.meeting-recorder`, generic `foo-bar`)
   - **LLM tool names**: underscore-only (`foo_bar_open`) — declared in this form in the manifest
   - **Plugin event names**: `${manifest.id}.<verb>.<noun>` using the literal manifest id, **no `_`↔`-` normalization**. A plugin with id `foo-bar` (dash) emits `foo-bar.auth.changed`, **not** `foo_bar.auth.changed` (underscore mirroring its tool prefix). Host hooks (`usePluginAuthStatuses`) subscribe via the literal id; tool-prefix mirroring is a real regression class (load-time soft warn enforced by `manifest-validation.ts` cross-field check: `auth` declared ⇒ `${id}.auth.changed ∈ emittedEvents[]`). See `architecture.md §9.4a` and `docs/references/plugin-tool-schema-design.md §2.4`.
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

## Packaging Discipline (REQUIRED)

Packaged app 이 실행 중 Node/Electron resolver 로 직접 로드하는 unbundled runtime 코드에 새 top-level package import 를 추가할 때는 같은 PR 에서 `package.json`의 `dependencies`에 해당 package 를 선언해야 한다. `devDependencies`만으로 통과시키면 electron-builder production bundle 에서 pruning 되어 설치된 앱이 launch 시 `ERR_MODULE_NOT_FOUND`로 crash 할 수 있다.

- 적용 대상: main process, preload, plugin/runtime, packaged app 이 `app.asar`에서 직접 resolve 하는 production runtime import
- 제외 가능: webpack/esbuild 로 dist asset에 번들되는 renderer/UI import, 테스트 파일(`__tests__/**`, `*.test.*`), build/test 전용 script import
- 금지 패턴: unbundled runtime 코드에서 `import x from "pkg"` 추가 후 `pkg`를 `devDependencies`에만 둠
- 허용 패턴: unbundled runtime import 추가와 `dependencies` 선언, lockfile 갱신, packaged launch smoke 검증을 같은 PR에 포함
- 실제 회귀 사례: PR #684에서 `src/plugins/plugin-artifact-store.ts`가 `adm-zip`을 runtime import 했지만 package가 devDependency에만 있어 v0.1.0 Windows installer가 실행 직후 `ERR_MODULE_NOT_FOUND: adm-zip`로 crash. 직접 수정은 PR #692, 재발 방지 CI gap은 issue #693

## Permission Policy (REQUIRED)

Permission policy 구현은 `docs/architecture/permission-policy-design.md` 와 `docs/architecture/architecture.md` §6.3 을 single source of truth 로 따른다.

- Host app 은 plugin 코드를 직접 참조하지 않는다. Plugin 권한/도구/경로 정보는 manifest, SDK schema, HostApi self-registration 으로만 전달한다.
- Plugin tool 의 filesystem path 판정은 `toolSchemas[*].pathFields` 선언이 유일한 SOT 이다. Builtin tool 만 host 내부 default path extraction 을 가질 수 있다.
- Plugin manifest `toolSchemas[*].category` 는 `read | write | shell | network` 만 허용한다. `meta` 는 host builtin category 전용이며 plugin manifest 에서 금지한다.
- Category 미선언 plugin grace 는 boot-warn only 이며 **hard removal date 는 2026-05-23 KST**. 이후 미선언 plugin 은 load/registration hard fail 로 전환한다. 연장은 CLAUDE.md 와 permission policy design 문서에 명시된 공식 결정 없이는 금지한다.
- Hook v1 은 deny-only + slash-based TOFU 이다. Boot 시 new/changed hook 은 실행하지 않고 `.disabled/` 로 격리한다. 신뢰 등록은 사용자가 직접 입력한 `/permission hooks accept <name>` 만 허용하며 renderer fallback prompt/modal 은 만들지 않는다.
- Non-user-origin 입력(plugin overlay, file-content, LLM tool arg)은 slash command 로 dispatch 되면 안 된다. Leading slash 는 plain text 로 sanitize 하고, `/permission` dispatcher 는 `trustOrigin === "user-keyboard"` 만 처리한다.
- Headless/routine 실행은 allow rule/auto mode 로 write/shell/network 를 우회하지 않는다. Mutating tool 은 reviewer layer 를 먼저 통과하고 HIGH 는 deferred queue 로 보낸다.

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

## Cross-Cutting Review Gate (REQUIRED)

같은 sensitive area (permissions / sandbox / audit / IPC trust boundary / boot sequence) 에서 **3건 이상의 PR 이 14일 이내에 머지**되면, 마지막 PR 머지 직후 **3-agent parallel cluster review** (architect + critic + security-reviewer) 를 정규 PR Copilot 루프와 별개로 추가 실행한다.

### Trigger 조건

- **Area 식별**: 다음 디렉토리 트리 중 한 곳을 touch 하는 PR
  - `src/permissions/**`, `src/audit/**`, `src/sandbox/**`
  - `src/ipc/**`, `src/preload*.ts`
  - `src/boot/**`, `src/core/permissions-*`
- **Threshold**: 같은 area 에 **14일 rolling window** 안 ≥3 PR 머지
- **확인 명령**: `gh pr list --state merged --search "merged:>=$(date -v-14d +%Y-%m-%d)" --json number,files` (또는 `git log --since="14 days" --name-only origin/main`)

### Review surface (각 agent 의 1차 책임)

- **architect**: emergent cross-PR interaction — 한 PR 만으로는 보이지 않는 시스템 효과 (예: PR A 가 emit 한 이벤트를 PR B 가 consume 하는 contract 변동)
- **critic**: SOT consolidation 누락 / test coverage gap / fail-closed semantics / 회귀 가드 부재
- **security-reviewer**: trust model 변동 / privilege boundary / fail-permissive default / coerce 의 보안 영향

### 룰

- Cluster review 의 MAJOR finding 은 정규 PR Copilot 루프와 동일하게 처리: **MAJOR=0 도달까지 무한 반복** (CLAUDE.md `Copilot Review Loop`)
- Symptom fix 가 아닌 **root-cause design fix** 우선 — symptom-only PR 은 closed-superseded 처리
- Cluster review 가 발견한 deferred work (test infra, lint rule 등 cluster 외부 작업) 는 follow-up issue 로 명시

### 위반 사례

2026-05-17 PRs #822-#827 (6 PR, permissions/audit area) cluster: single-PR review 6건 모두 통과 → cross-cutting 에서 3 MAJOR 발견 (silent-success banner / SOT residual / fail-permissive `?? "medium"` coerce). 한 사이클 손실 → PR #829 (symptom) closed → PR #832 (root-cause) re-cluster fix.

## Field-Addition Sweep Checklist (REQUIRED)

새 shared type / IPC payload field / 새 enum literal 추가 시 다음을 **같은 PR 안에서** sweep:

1. **SOT 정의**: `src/shared/<area>-events.ts` (또는 types.ts) 에 type/interface 추가 + JSDoc 으로 cross-importer boundary 명시
2. **Inline literal 전수 검색**: 새 type alias 도입 직후 `grep -rn '"<literal-1>"\|"<literal-2>"' src/` 실행 → 발견된 inline 사용처 **모두** SOT import 로 교체
3. **Cross-importer 정합**: type 을 import 하는 모든 module 에 `import type { X } from "../shared/..."` 명시 (`import type` 이어야 runtime cycle 없음)
4. **Lint enforcement (권장)**: ESLint `no-restricted-syntax` 로 inline literal 직접 사용 금지 — 새 callsite 가 추가될 때 자동 차단

### 위반 사례 — R-2 verdict 시리즈 (2026-05-16~17)

- PR #786 — `verdictAtApproval: "low"|"medium"|"high"` 도입 (SOT 없이 inline union)
- PR #802 — 8 사이트 swept (sweep 미완 — grep 누락)
- PR #825 — 5 missed 추가 sweep
- PR #832 — 3 more missed (`permission-manager.ts:587/631` + `sandbox-audit.ts:119`)

누계 **16+ 사이트 across 3 separate PRs**. PR #786 시점에 `grep -rn '"low"\|"medium"\|"high"' src/permissions src/audit` 전수 sweep + SOT 도입 했다면 한 PR 으로 종료. Cluster review 가 발견한 누락분이 매번 follow-up PR 발생 → field 추가 PR 의 *checklist 의무화* 가 process-level 방어선.
