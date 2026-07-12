# LVIS App (Host) — Claude Code Directives

## Architecture Reference

This is the Electron host app. ALL implementation follows `docs/architecture/architecture.md` (v4 Final).
Always check `../TODO.md` for current status across all components.

## Project Structure

See `docs/architecture/architecture.md` §4.6 and `docs/blueprints/phase3-folder-refactor-plan.md` for the canonical layout and module boundary rules.

```
src/
  main.ts                     — thin Electron entry (single-instance/whenReady/main());
                                setup extracted to src/main/* (C17)
  boot.ts                     — §4.2 thin bootstrap orchestrator — BootContext + ordered
                                steps + assembleAppServices (C18)
  boot/                       — context.ts, assemble-services.ts, steps/* (sandbox-init,
                                network-fetch-setup, mcp-setup, conversation-wiring, …;
                                plugin-runtime.ts barrel + plugin-runtime/* host-api-factory)
  ipc/                        — index.ts + domains/* (thin ipcMain.handle wrappers) +
                                handlers/* (transport-agnostic pure impls, C10) + gated.ts
  ipc-bridge.ts               — Compatibility re-export shim. Real handlers
                                live under `src/ipc/domains/*` and are wired
                                from `src/ipc/index.ts`.
  preload.ts / preload.cjs    — Electron preload; preload.ts composes
                                preload/{gesture-intent,public-surface,internal-surface} (C11)
  renderer.tsx                — minimal entry mounting ui/renderer/App.tsx
  plugin-ui-host.tsx          — Dynamic plugin UI mounting

  ui/renderer/                — Renderer composition root (App/ChatView decomposed into roots + hooks)
    App.tsx                   — composition root: wires domain hooks + renders
                                AppProviders > AppShell(children) + AppDialogs (C16)
    AppProviders.tsx · AppShell.tsx · AppDialogs.tsx  — App presentational split
    ChatView.tsx              — composition root: ChatView hooks + ChatTranscript +
                                ChatComposerDock (C15) · Sidebar.tsx · SettingsDialog.tsx · MainToolbar.tsx
    context/                  — ChatContext (state provider for ChatView subtree)
    state/                    — chat-scroll-store (module scroll singletons)
    hooks/                    — domain hooks: 14 original + extracted App/ChatView hooks
                               (use-app-mode, use-routine-overlay, use-send-message,
                                use-plugin-view-routing, use-onboarding-chain-controller,
                                use-chat-scroll, use-message-queue, use-attachment-picker,
                                use-permission-toasts, use-checkpoint-view, use-transcript-entries, …)
    components/               — BriefingCard, AssistantCard, UserMessageEditor,
                               ReasoningCard, ToolApprovalDialog, ToolGroupCard,
                               ChatTranscript, ChatComposerDock, ImportedTriggerCard,
                               AskUserAnswerBubble, ChatSearchOverlay, Sparkline, UsageDashboard,
                               HtmlPreview (partition lvis-render-html, webRequest block A5),
                               StarredView, MarketplaceUpdateBanner
    dialogs/                  — ApprovalDialog, PluginInstallDialog,
                               PluginUninstallDialog, CommandPaletteDialog
    tabs/                     — RolesTab, PermissionsTab, AuditTab,
                               PluginPerfTab, PrivacyTab
    utils/                    — cost-format, html-preview, history, compose,
                               action-panel-activity, plugin-auth-error, read-initial-app-mode,
                               chat-entry-revision, korea-date-key, classify-turn-entries
    types.ts · constants.ts · api-client.ts

  engine/                     — Agent loop + LLM providers (was src/agent/)
    conversation-loop.ts      — §4.5 thin class shell + assembler + re-export facade (C9)
    turn/                     — turn units (C9): types · trust-origin · context-carrier ·
                                tool-exposure · tool-scope · provider · lifecycle-hooks ·
                                compaction · session · commands · loop-context · run-turn · query-loop
    conversation-history.ts   — In-memory message management
    auto-compact.ts           — Token-aware history compression
    llm/
      types.ts                — Vendor-agnostic LLM interfaces
      provider-factory.ts     — Vendor selection factory (routes to VercelUnifiedProvider)
      vercel/                 — VercelUnifiedProvider — single LLM adapter for all vendors

  tools/                      — 1-file-per-tool (Tier S3 BaseTool pattern)
    executor.ts               — §4.5.6 ToolExecutor facade + executeAll/executeOne orchestrator
    executor-ceiling.ts       — runWithCeiling AbortController helper (owns ToolCeiling* SOT)
    pipeline/                 — pipeline units (C7/C8): path-extraction · approval-purpose ·
                                audit-entries · display-mask · rate-limiter ·
                                reviewer-authorization-store · reviewer-dispatch ·
                                approval-memory-skip · risk-classification · audit-writer ·
                                invocation-context
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

  contract/                   — #1409 public wire contract SOT: app-contract.ts
                                (channel names + PUBLIC_CHANNELS allowlist +
                                gesture classification + session addressing +
                                INTERNAL_HOST_CHANNELS out-of-tree classification),
                                trust-origin.ts.

  api/                        — #1409 external surface (#1436): local-api.ts
                                dispatch({channel,args,origin}) over the same
                                contract as the renderer (fail-closed); http-server.ts
                                loopback node:http transport (127.0.0.1, Bearer secret,
                                POST /v1/dispatch + GET /v1/events SSE + /v1/health);
                                stream-broadcaster.ts (chat-stream fan-out). Opt-in
                                lifecycle: src/main/local-api-server.ts (Settings
                                system.localApiServer or LVIS_LOCAL_API=1, default OFF;
                                discovery ~/.lvis/local-api/server.json via
                                openFeatureNamespace; closed in app-shutdown).
                                External mutations are ApprovalGate-mediated, not
                                token-authorized: the Bearer secret authenticates the
                                caller, the user's in-app "Allow" click authorizes the
                                mutation. contract/app-contract.ts's
                                EXTERNAL_MUTATION_CHANNELS is the only widening point
                                (today: PERMISSIONS.setMode only) — any addition MUST
                                route through the same consent path, never a token bypass.
  sdk/                        — #1409 narrow typed LvisClient facade over any
                                LocalApi<string> (read+send only; mutating ops omitted).
  cli/                        — #1409 CLI (#1436): commands.ts table + http-client.ts
                                HTTP transport; entry scripts/lvis-cli.ts
                                (`bun run cli -- <command>`). Thin client, zero agent logic.

  mcp/                        — Model Context Protocol client (unchanged)

  plugins/                    — Plugin runtime (was plugin-runtime/)
    types.ts                  — PluginManifest, HostApi, RuntimePlugin
    runtime.ts                — re-export shim (verbatim surface)
    runtime/                  — PluginRuntime class + collaborators (C4): index (orchestrator),
                                perf-stats, config-overrides, preparation, lifecycle-timeout,
                                access-control, cards, plugin-loader, manifest-validation
    marketplace.ts            — Install/remove plugins
    registry.ts               — Plugin registry file management
    deployment-guard.ts       — Deployment mode enforcement

  data/
    settings-store.ts         — Multi-vendor settings + encrypted API keys

  main/                       — Electron main-process helpers + C17 entry modules
                                (app-state, main-window, app-menu, app-tray, settings-window,
                                lvis-deep-link, corp-ca-runtime, bootstrap-splash, early-boot-env,
                                app-shutdown, main-paths, python-runtime, ...)
  lib/                        — Pure TS utilities (approval-queue-reducer, utils)
  components/ui/              — shadcn
  ui/                         — LVIS-custom UI components/views
```

## Storage Namespace per Feature (REQUIRED)

LVIS host + plugin 의 모든 user-data storage 는 **`~/.lvis/<feature>/`** 디렉토리 namespace 로 격리한다. *feature* 는 host 도메인 (chat sessions, routine, audit log 등) 또는 plugin id (`work-assistant`, `meeting`, `local-indexer` 등).

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

### Canonical entry point — `openFeatureNamespace`

새 `~/.lvis/<feature>/` namespace 는 **반드시** `src/main/storage/feature-namespace.ts` 의 `openFeatureNamespace(featureId)` 핸들 API 를 통해 access 한다. `mkdirSync(..., { mode: 0o700 })` / `writeFile(..., { mode: 0o600 })` / tmpfile+rename / JSON parse-with-fallback 를 call site 에서 직접 재구현하지 **말 것** — 한 곳에서 mode 비트를 빠뜨리면 namespace 가 조용히 world-readable 가 된다.

```ts
import { openFeatureNamespace } from "./storage/feature-namespace.js";

const ns = openFeatureNamespace("onboarding"); // ~/.lvis/onboarding/
await ns.writeJson("tour-state.json", state);   // 0o700 dir + 0o600 file + atomic
const loaded = await ns.readJson("tour-state.json", DEFAULT);  // parse-with-fallback
const sessionsDir = await ns.childDir("sessions");             // 0o700 subdir
```

- `dir` 는 매 access 마다 `lvisHome()` 로 lazily 재해석 → module-level 핸들이라도 `LVIS_HOME` 테스트 override 를 존중.
- 비-JSON raw 파일 (예: markdown) 은 `writeFileAtomicAtPath(absPath, body)` 사용 — 같은 0o700/0o600/atomic 보장.
- Path 가 dependency-injected 되는 store (테스트가 temp path 주입) 는 `writeFileAtomicAtPath` 로 contract 만 위임하고 `filePath` 는 그대로 유지 (예: `routines-store.ts`).

### 룰

- **단일 도메인 = 단일 디렉토리**. 같은 도메인의 설정 + session + cache + state 모두 그 디렉토리 하위에 모은다.
- **디렉토리 권한**: 0o700 (디렉토리), 0o600 (파일). secrets 는 추가 암호화 의무. **이 mode 보장은 `openFeatureNamespace` 가 단일 출처로 강제** — 새 store 가 직접 mkdir 하면 안 됨.
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
- Plugin tool 의 filesystem path 판정은 tool 객체의 `_meta["lvisai/pathFields"]` 선언이 유일한 SOT 이다 (유일하게 남은 LVIS 전용 manifest 키). Builtin tool 만 host 내부 default path extraction 을 가질 수 있다.
- Per-tool category 는 manifest 필드가 아니다 (#885 Phase R 에서 제거) — effective category 는 host-side `inspectHostRisk`/executor policy 가 invocation 별로 `read | write | shell | network | meta` 로 산출한다. Plugin manifest 는 category 를 스스로 선언하지 않는다.
- Hook v1 은 deny-only + slash-based TOFU 이다. Boot 시 new/changed hook 은 실행하지 않고 `.disabled/` 로 격리한다. 신뢰 등록은 사용자가 직접 입력한 `/permission hooks accept <name>` 만 허용하며 renderer fallback prompt/modal 은 만들지 않는다.
- Non-user-origin 입력(plugin overlay, file-content, LLM tool arg)은 slash command 로 dispatch 되면 안 된다. Leading slash 는 plain text 로 sanitize 하고, `/permission` dispatcher 는 `trustOrigin === "user-keyboard"` 만 처리한다.
- Headless/routine 실행은 allow rule/auto mode 로 write/shell/network 를 우회하지 않는다. Mutating tool 은 reviewer layer 를 먼저 통과하고 HIGH 는 deferred queue 로 보낸다.

### OS Execution Sandbox — ASRT (현행)

OS 수준 실행 격리는 **ASRT (`@anthropic-ai/sandbox-runtime`)** 가 단일 백엔드다. 레거시 per-OS 러너 레지스트리(host 가 bubblewrap / sandbox-exec / AppContainer 를 직접 호출하던 구조)는 제거되었다 (PR #1358). 상세는 architecture.md §6.3.9 / §9.1.

- **백엔드**: macOS = Seatbelt, Linux = bwrap, Windows = srt-win (capability SOT 에서 단일 `kind: "asrt"`, substrate 별 `confines` 로 구분). macOS/Linux 는 filesystem + process + **network egress** 를 전부 격리한다. **Windows (srt-win, ASRT 0.0.64) 는 filesystem ACL + network egress partial confinement** 를 제공하지만 process 격리는 제공하지 않는다 (`confines = { fs:✓, net:✓, proc:✗ }`).
- **Network floor**: deny-by-default. boot 에서 로드된 모든 plugin manifest `networkAccess.allowedDomains` 의 UNION + `strictAllowlist: true` 를 ASRT SHARED config 로 설정 (loopback proxy strict-union 바닥). per-worker 격리가 아니라 UNION allow-list — 1st-party 신뢰 모델 하 허용.
- **Gate**: `osToolSandbox` flag (Settings → 권한) 또는 `LVIS_SANDBOX_ENABLED=1`. **STAGED default (macOS-first)**: `osToolSandbox` 기본값은 **`darwin` = ON / `linux`+`win32` = OFF(opt-in)** — C/D-series 샌드박스 QA 가 green 될 때까지 Linux/Windows 는 Settings 에서 opt-in. **Convergence plan**: C/D QA 통과 시 `src/data/settings-store.ts` DEFAULT_SETTINGS 의 `osToolSandbox: process.platform === "darwin"` 단일 표현식을 `true` 로 flip. `hostClassifiesRisk` 는 **전 플랫폼 ON** — non-sandbox 플랫폼에서도 안전한 이유는 foreground plugin read-relaxation 이 **sandbox-active 와 커플링**되어 있어(아래 Interlock) sandbox 비활성 호스트에서는 pre-exec ask 로 fallback 하기 때문. boot 에서 한 번만 결정, runtime 변경 채널 없음. boot gate (`boot/steps/sandbox-gate.ts` 의 `decideSandboxGate`) 가 **on-signal 출처**를 구분한다:
  - **EXPLICIT** (`LVIS_SANDBOX_ENABLED=1`, 의도적 power-user/CI 신호): 샌드박스 활성화 불가 시 **fail-closed abort** 유지 (no-fallback — unsandboxed plain spawn 금지).
  - **DEFAULT / Settings 토글**: 샌드박스 활성화 불가(Linux deps 부재 / init 실패 / Windows 미설치) 시 **graceful degrade** — abort 하지 않고 LOUD warn + unsandboxed(isolation=none, sandbox-OFF 와 동일 posture) 로 boot 계속 (non-bricking). 기본 ON 인데 deps 없는 Linux host 를 brick 시키지 않기 위함.
- **Windows (srt-win)**: 동일 gate 에 합류 (`LVIS_SANDBOX_WINDOWS` opt-in 제거). srt-win.exe 는 **번들** (asarUnpack vendor/**, **다운로드 없음**) 이고 활성화는 명시적 consent 버튼이 호출하는 1회 self-elevating UAC install 뿐이다. ASRT 0.0.64 는 전용 `srt-sandbox` 사용자 ACL backend 로 filesystem rules 를 적용하고 WFP + loopback proxy 로 network egress 를 제한한다. **Windows 계정 로그아웃은 요구하지 않음**; 설치 후 앱 재시작으로 재조회한다. **win32-not-ready 시 hard-throw 안 함** (first-run brick 방지) — `isAsrtSandboxActive()` FALSE 유지(호스트 셸 도구 비격리) + "NO OS isolation until setup completes" loud 신호. ready 면 fs+network partial capability (`confines.filesystem === true`, `confines.network === true`, `confines.process === false`) 를 발행한다.
- **Windows readiness UX**: Settings → 권한 토글 ON → `sandboxWindowsStatus` IPC (read-only, UAC 없음) 로 readiness 조회. WFP enum 이 `cannot-read` 를 반환하면 이는 BFE enumeration 이 admin-gated 된 상태이므로 ASRT `verifyWindowsWfpEgress()` behavioral proof 로 준비 상태를 판정한다. `ready === false` 면 명시적 consent 패널 (경고 + verbatim install instructions + "Install now" 버튼). **auto-UAC 금지** — 버튼만이 `sandboxWindowsInstall` IPC (MUTATING, sender-frame-guarded) 를 호출하고 이것이 ASRT `installWindowsSandbox` 의 단일 self-elevating UAC 를 트리거하는 유일한 privilege-escalation 진입점. UAC 거부 → `{cancelled:true}` → 토글 revert + 배너. 성공 → 앱 재시작/상태 재조회 안내.
- **Asymmetric reviewer relaxation**: win32 fs+network partial `confines` 가 reviewer 를 비대칭으로 relax — `network` 및 filesystem-bearing category(`read`/`write`/`meta`) 는 relax 가능하지만 `shell` 은 process 격리가 없으므로 relax 안 함. ToolApprovalDialog 라벨도 confines-aware ("[net:✓ fs:✓ proc:✗]", display-only).
- **Per-platform packaging prune**: 최상위 `asarUnpack: vendor/**` 유지 + per-target `files` negation (mac → srt-win/seccomp 제외, linux → srt-win 제외, win → seccomp 제외). `scripts/electron-after-pack.cjs` 의 `assertSandboxVendorBinaries` 가 KEPT present+executable / PRUNED absent 를 hard-assert.
- **Linux deps-missing (mac/linux 만)**: gate ON 인데 bwrap/socat/ripgrep 부재 시 branch 는 on-signal 출처에 따름 — **EXPLICIT `LVIS_SANDBOX_ENABLED=1`** 면 no-fallback 룰에 따라 boot fail-closed abort (unsandboxed plain spawn 금지); **DEFAULT/settings-on** 이면 graceful degrade (LOUD warn + unsandboxed, non-bricking). init 실패도 동일 규칙(같은 "활성화 불가" 조건으로 `depsOk:false` 재판정). Windows 는 항상 non-bricking degrade.
- **Relaxation ↔ plugin effect-boundary FILESYSTEM-CONTAINMENT 커플링 (hard gate, confines-aware)**: foreground plugin read-relaxation (`src/tools/executor.ts` executeOne) 은 `hostClassifiesRisk` ON **AND `sandboxFsContainedProvider(tool)` (= `isActiveSandboxFilesystemContainedForPluginEffects(tool)`) true** 일 때만 발화. relaxation 은 pre-exec ask (off-hostApi `node:fs` WRITE residual 을 gate 하는 것 포함) 를 제거하고 effect-boundary 에 의존하므로, 해당 `Tool.workerId` 가 host-owned `spawnWorker` 경로로 ASRT-wrapped 상태일 때만 허용된다. macOS/Linux plugin workers 는 ASRT-wrapped UDS path 를 쓰고, Windows plugin workers 는 UDS 대신 TCP control channel 을 유지하되 ASRT 0.0.64 의 공개 `grantWindowsAcl`/`revokeWindowsAcl` primitive 를 worker 별 holder PID 로 적용한 뒤 srt-win wrapped command 로 실행한다. 결과: matching wrapped worker-backed plugin effects → relax; ordinary plugin tools/degraded/sandbox-off/egress-only synthetic substrate → pre-exec ask 또는 fail-closed. reviewer SOT `sandboxRelaxesCategory` 는 host-shell ASRT capability 기준이고, plugin read-relaxation provider 는 worker effect-boundary 현실을 반영해 더 좁다.
- **Interlock warning (degraded state 포함)**: 위 hard-coupling 에 더해, `hostClassifiesRisk` ON 인데 OS 샌드박스가 **active 아님**(gate off, 또는 default/settings degrade 로 inactive) 이면 boot 가 LOUD warn — degrade 경로에서도 실제 sandbox-active 상태를 기준으로 발화(`shouldWarnHostClassifyInterlock`).
- **Activation telemetry**: boot 의 샌드박스 gate 가 **boot 당 1건**의 구조화 audit 이벤트를 발행 — platform / on-signal 출처(explicit-env vs default-settings vs off) / outcome(activate · degrade · abort · skip). `AuditLogger.logSandboxGate()` 가 전용 채널 `~/.lvis/audit/<date>.sandbox-gate.jsonl` 에 append (hand-rolled file write 금지 — AuditLogger 경유). Linux/Windows 기본값 flip 전에 실세계 activation 성공/degrade 율 모니터링용. **Rollback**: Settings → 권한 'OS 도구 샌드박스' 토글로 per-host opt-out, `hostClassifiesRisk` 토글로 relaxation off.
- **Plugin egress SOT**: `local-indexer` 의 long-lived Python worker provider egress 는 broker + `hostApi.hostFetch` chokepoint 로 수렴한다. `ep` 는 Python worker 가 없고 Playwright 브라우저 SSO + 사내망 HTTP/HTTPS endpoint 를 직접 다루는 예외이므로, 허용 호스트는 `lvis-plugin-ep/plugin.json` 의 `networkAccess.allowedDomains` 가 SOT 이다. 새 direct egress 는 manifest allow-list 없이 추가하지 않는다.
- **라이선스**: ASRT 는 Apache-2.0 — attribution 은 repo 루트 `THIRD-PARTY-NOTICES.md` 에 유지. LVIS 자체 라이선스는 MIT 로 불변.

## IPC Error Message Language Convention (REQUIRED)

LVIS 는 IPC layer 와 UI layer 의 i18n 책임을 분리한다.

### Layer 별 언어 규칙

| Layer | 표시 대상 | 언어 | 예시 |
|---|---|---|---|
| **IPC handler return** (`{ok:false, error, message}`) | 개발자 (logs, audit, dev tools) | **English** | `"permission manager not initialized"` |
| **`throw new Error()` from main process** | 개발자 (stack trace, crash log) | **English** | `"[security] dev mode not unlocked"` |
| **`dialog.showOpenDialog` / `showMessageBox` 의 `title`/`message`** | 최종 사용자 | **Korean** | `"로컬 플러그인 설치 (개발자)"` |
| **Renderer toast / banner / alert text** | 최종 사용자 | **Korean** | `"권한 메모리가 복구되어 새 승인이 필요합니다."` |

### 룰

- IPC handler 의 `message` 필드는 **English** 로 작성한다. 사용자에게 보여지는 i18n 은 renderer 의 mapping 함수 (예: `formatRevokeError`) 가 책임진다.
- `error` 코드는 항상 **kebab-case English** (`invalid-pattern`, `user-keyboard-required`, `no-permission-manager`). UI 측 mapper 는 이 코드만으로 분기 가능해야 한다.
- Renderer 에서 IPC error 를 그대로 노출하지 않는다 — code → user-facing Korean 으로 항상 변환.
- 새 IPC handler 추가 시 Korean error message 발견되면 PR review 차단.

### 위반 사례 (2026-05-17 이전)

`src/ipc/domains/permissions.ts` 가 10+ 사이트에서 Korean error message 사용 (`"패턴은 문자열이어야 합니다."`, `"권한 매니저가 초기화되지 않았습니다."` 등). 같은 파일의 더 최근 추가 handler 들은 English 사용 (`"mode must be a string"`, `"durable mode command must require modal confirmation"`). 컨벤션 부재로 mixed surface. **Root cause**: layer 분리 미명시 → 작성자별 임의 선택. Fix: convention 명시 + sweep + UI mapper SOT (issue #830 - `formatIpcError`) 가 enforcement 보조.

## UI Component Editing Discipline (REQUIRED)

UI 컴포넌트 (settings / dialog / window / sidebar 류) 수정 시 다음 4가지 룰 지킬 것.

### 1. SOT 검증 — edit 전 `grep -rn <ComponentName>` 1줄 필수

수정 직전 컴포넌트 이름으로 import 그래프 trace:

```bash
grep -rn "<ComponentName>" src/ | head
```

결과가 wrapper-only / re-export 만이면 **SOT divergence 신호** — 진짜 consumer (BrowserWindow entry 또는 다른 dialog) 부터 찾아 그쪽 수정.

### 2. shadcn primitive 확장 시 default override 명시

`TabsList`, `DialogContent`, `Card` 등 shadcn primitive 를 default 방향과 **다르게** (vertical sidebar, transparent bg, borderless 등) 쓸 때:

- `components/ui/<name>.tsx` 의 default className 한 번 확인
- override 키워드 명시: `justify-*`, `items-*`, `flex-*`, `rounded-*`, `bg-*`
- `cn()` 의 tailwind-merge 는 **conflicting utility** 만 병합. 명시 안 한 utility 는 primitive default 가 생존
- 같은 변형을 2회 이상 쓰면 wrapper 만들어 재사용 (`<VerticalTabsList>` 등)

### 3. Component naming convention

- `*Window.tsx` — BrowserWindow entry only
- `*Content.tsx` — body shared by Window + (옵션) in-app Dialog
- `*Dialog.tsx` — **오직** in-app Dialog 한정. wrapper-only 금지
- wrapper-only 파일 발견 시 즉시 collapse + 파일 rename

### 4. 변경이 화면에 안 보일 때 — build cache 의심은 최후

진단 우선순위:
1. **SOT divergence** (위 #1) — 가장 자주 발생
2. **Production import path 미스** — BrowserWindow vs in-app Dialog 같은 entry 분기
3. **IPC / window routing** — 새 IPC handler 등록 / window message subscription 누락
4. dev server reload 실패 (`tail -f` 로 확인)
5. **최후의 최후로** build / chunk cache

위 1~4 다 검증 안 한 채 build cache 핑계로 rebuild 반복 금지. 사용자 명시 룰: **"코드 패치인데 빌드가 꼬일 일이 뭐가 있어, 처음부터 올바르게 하자."**

### 위반 사례 (2026-05-17 PR #890 — settings UI redesign)

- `SettingsDialog.tsx` 수정했으나 production path 는 `SettingsWindow → SettingsContent`. 변경 안 보여 build cache 의심으로 3-4 round 손실. 첫 grep 1줄이면 즉시 발견됐을 사고. → 이후 SOT collapse + 파일 rename 으로 영구 해소.
- `TabsList` 가 vertical sidebar 인데 primitive default `justify-center` 가 override 없이 생존 → 모든 trigger 가 vertical 중앙 정렬 → 사이드바 ~수백px 빈공간. Fix: `justify-start rounded-none bg-transparent` 명시.

## Tool Execution Timeout Policy (REQUIRED)

모든 tool 호출 timeout 은 `src/shared/tool-timeout-policy.ts` 의 `TOOL_TIMEOUT_POLICY` 객체가 단일 SOT. 새 tool / executor 변경 / MCP 통합 시 timeout 값을 직접 hardcode 하지 말고 이 객체에서 import. 자세한 매트릭스는 `docs/architecture/architecture.md` §6.4.Y.

### 핵심 룰

- **사용자 무한 대기 0**: `tools/executor.ts` Step 6 (Execute) 의 `runWithCeiling(...)` (`tools/executor-ceiling.ts`) wrap 우회 금지. 모든 tool path 가 이 step 거치며, ceiling fire 시 AbortController 가 tool 의 abortSignal 을 actually abort.
- **사용자-facing 최대 cap 120_000ms**: `shellMaxMs=120_000` / `globalCeilingMs=120_000` / `mcpRequestMaxMs=120_000`. 모든 SOT 값이 ms 단위로 통일 — 직접 비교 가능. 어떤 경로로도 이 cap 위는 허용 안 됨. `subAgentCeilingMs=600_000` 은 *sub-agent inner loop 전용* 예외 — 일반 tool 에 적용 금지.
- **MCP timeout 은 dispatch + ingestion 두 단 모두 clamp**: `mcp-client.ts` 의 `Math.min(..., MAX_REQUEST_TIMEOUT_MS)` 는 dispatch 단; `mcp-governance.ts` `validateConnectionSecurity` 는 ingestion 단에서 `connectionTimeoutMs > mcpRequestMaxMs` approval 을 reject. 한쪽만 적용하면 settings UI / 감사 로그가 unsafe 값을 표시할 위험.
- **MCP SSE absolute deadline**: streaming activity reset 이 per-chunk window 를 update 해도 *최초 dispatch 시점에 잡힌 절대 deadline* 을 넘기지 못한다. 한 byte 흘리며 영원히 잡고 있는 hostile server 패턴 방어.
- **LLM judging — cap 안에서 자율**: model 이 long-running (bun install, large build 등) 으로 판단하면 shell tool 의 `timeoutSeconds` input 으로 최대 `shellMaxMs / 1000 = 120` 까지 명시 가능. SOT 자체는 ms, schema 가 `/ 1000` 변환해 model 에 노출. *host-enforced hard ceiling + per-call model override* 패턴.
- **사용자 입력 대기는 별도 surface**: `approvalGateUserWaitMs=300_000` 은 *사용자가 느린 케이스* 라 globalCeiling 의 cap 대상 아님. tool 실행 cap 과 의미 다름.
- **외부 평균 변경 시 SOT 만 수정**: 외부 OSS agent runtime 의 평균 timeout 정책이 변동하면 `tool-timeout-policy.ts` 만 update — inline literal 흩어지면 회귀 보장.

### 위반 패턴

- 새 tool 의 schema 에 `.default(120)` 직접 → `TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000` (SOT 는 ms, schema 가 변환)
- 새 MCP 통합에 `connectionTimeoutMs: 30_000` hardcode → `mcpRequestDefaultMs`
- `setTimeout(..., 600_000)` 같은 inline literal → SOT 추가하고 import
- timeout-bypass 분기 (예: `if (trustedTool) { skipTimeout }`) — 신뢰 가정으로도 우회 금지
- ceiling 에 Promise.race 만 쓰고 AbortController 안 wire — tool 의 실제 작업이 ceiling 후에도 계속 돌아 detached side effect 위험

### 위반 사례 (2026-05-18 이전)

`tools/bash.ts:42` + `tools/powershell.ts:33` 의 `timeoutSeconds.default(600).max(600)` 가 사용자가 *10분까지 무한 대기* 하는 원인. `tools/executor.ts` 8-step pipeline 에 글로벌 ceiling 부재. `mcp-client.ts` 의 `DEFAULT_REQUEST_TIMEOUT_MS=30_000` 만 있고 max ceiling 없어 server 가 임의 큰 값 줄 수 있던 상태. `plugin runtime/index.ts` 의 `if (hardTimeoutMs > 0) ... else { instance.start() }` 분기로 미선언 plugin 은 startup 무한 대기 가능.

후속 (cluster review post-merge) 에서 Promise.race-only ceiling 이 *tool 의 작업을 실제로 stop 못 하는* 회귀 발견, SSE streaming activity reset 이 새 MCP cap 무력화, `pluginCallToolCeilingMs` 가 dead key (callTool 이 invoker→executor 거쳐 globalCeiling 자연 cover). Fix: `runWithCeiling` AbortController helper 추출 + SSE absolute deadline + governance ingestion clamp + dead key 삭제 + `subAgentCeilingMs`/`pluginStartupMaxMs`/`networkFetchDefaultMs`/`approvalGateUserWaitMs` SOT 통합 + `executor-ceiling.test.ts` / `mcp-governance.test.ts` / `startup-timeout.test.ts` runtime test 추가.

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
- **Bundle PR 처리**: 한 PR 안에 ≥3 commit 이 sensitive area 를 touch 하면 **N PR-equivalent** 로 카운트하여 그 PR 머지 직전 cluster review 실행. PR 가 분리되어 있어도 머지 후 14일 window 에 같이 들어가면 동일하게 트리거.
- **확인 명령**: `gh pr list --state merged --search "merged:>=$(date -v-14d +%Y-%m-%d)" --json number,files` (또는 `git log --since="14 days" --name-only origin/main`)

### Review surface (각 agent 의 1차 책임)

- **architect**: emergent cross-PR interaction — 한 PR 만으로는 보이지 않는 시스템 효과 (예: PR A 가 emit 한 이벤트를 PR B 가 consume 하는 contract 변동)
- **critic**: SOT consolidation 누락 / test coverage gap / fail-closed semantics / 회귀 가드 부재
- **security-reviewer**: trust model 변동 / privilege boundary / fail-permissive default / coerce 의 보안 영향

### 룰

- Cluster review 의 MAJOR finding 은 정규 PR Copilot 루프와 동일하게 처리: **MAJOR=0 도달까지 무한 반복** (CLAUDE.md `Copilot Review Loop`)
- Symptom fix 가 아닌 **root-cause design fix** 우선 — symptom-only PR 은 closed-superseded 처리
- Cluster review 가 발견한 deferred work (test infra, lint rule 등 cluster 외부 작업) 는 follow-up issue 로 명시

### 해소 신호 — `cluster-review-passed` label

`.github/workflows/cluster-detector.yml` 는 트리거 조건만 자동 감지하고, **해소 (manual cluster review 완료)** 신호는 PR 의 `cluster-review-passed` label 로 받는다. 이 label 이 없는 PR 은 cluster-detector 가 `state=failure` 로 머지를 차단한다.

- 적용 절차:
  1. 트리거 PR 머지 *직전* 에 3-agent cluster review 실행 (architect / critic / security-reviewer)
  2. 모든 reviewer 가 MAJOR=0 으로 GO 평결
  3. `gh pr edit <PR#> --add-label cluster-review-passed` (label 미존재 시 `gh label create cluster-review-passed --color FBCA04 --description "Cluster review attested (CLAUDE.md §Cross-Cutting Review Gate)"` 로 생성)
  4. cluster-detector 재실행 — exempt 분기로 `state=success` 작성 후 머지 가능
- Label 적용은 **사람이 직접** (orchestrator agent 의 명시 결정). 자동 적용 금지 — 의도된 audit trail.
- 같은 label 이 *bundle* (3+ sensitive commits in single PR) 트리거에도 동일 적용. trigger 종류 무관.

### 운영 가이드 (PR description 권장)

cluster review GO 받은 PR 의 description 끝에 다음 형식의 attestation 블록 추가 (audit / 후일 검증 용):

```
## Cluster Review (CLAUDE.md §Cross-Cutting Review Gate)
- architect: GO — <one-line finding summary>
- critic: GO — <one-line finding summary>
- security-reviewer: GO — <one-line finding summary>
- Label applied: cluster-review-passed
- Round: N (final)
```

### 위반 사례

2026-05-17 PRs #822-#827 (6 PR, permissions/audit area) cluster: single-PR review 6건 모두 통과 → cross-cutting 에서 3 MAJOR 발견 (silent-success banner / SOT residual / fail-permissive `?? "medium"` coerce). 한 사이클 손실 → PR #829 (symptom) closed → PR #832 (root-cause) re-cluster fix.

## Field-Addition Sweep Checklist (REQUIRED)

새 shared type / IPC payload field / 새 enum literal 추가 시 다음을 **같은 PR 안에서** sweep:

1. **SOT 정의**: `src/shared/<area>-events.ts` (또는 types.ts) 에 type/interface 추가 + JSDoc 으로 cross-importer boundary 명시
2. **Inline literal 전수 검색**: 새 type alias 도입 직후 `grep -rn '"<literal-1>"\|"<literal-2>"' src/` 실행 → 발견된 inline 사용처 **모두** SOT import 로 교체
3. **Cross-importer 정합**: type 을 import 하는 모든 module 에 `import type { X } from "../shared/..."` 명시 (`import type` 이어야 runtime cycle 없음)
4. **Lint enforcement (권장)**: ESLint `no-restricted-syntax` 로 inline literal 직접 사용 금지 — 새 callsite 가 추가될 때 자동 차단

### 위반 사례 — verdictAtApproval union sweep (2026-05-16~17)

- PR #786 — `verdictAtApproval: "low"|"medium"|"high"` 도입 (SOT 없이 inline union)
- PR #802 — 8 사이트 swept (sweep 미완 — grep 누락)
- PR #825 — 5 missed 추가 sweep
- PR #832 — 3 more missed (`permission-manager.ts:587/631` + `sandbox-audit.ts:119`)

누계 **16+ 사이트 across 3 separate PRs**. PR #786 시점에 `grep -rn '"low"\|"medium"\|"high"' src/permissions src/audit` 전수 sweep + SOT 도입 했다면 한 PR 으로 종료. Cluster review 가 발견한 누락분이 매번 follow-up PR 발생 → field 추가 PR 의 *checklist 의무화* 가 process-level 방어선.

## Release Process

Release 발행 절차는 `docs/development/release-process.md` 가 SOT.

- **Main 직접 push 금지** — `[DEFAULT_BRANCH_DIRECT_PUSH]` guard (dev-tools PR #14) 가 release commit 도 거부. `chore/release-vX.Y.Z` branch + PR 머지 강제.
- **Squash 금지** — `gh pr merge --merge` 만. tag 가 가리키는 commit SHA 보존 위해.
- **Partial release 복구** — electron-builder publisher race 로 일부 asset 누락 시 workflow artifact (`gh run download`) 다운로드 후 `gh release upload` 수동 보충. re-run 만으로는 skip-if-exists 때문에 미보충.
- **Mac x64 (Intel) 미산출** — intentional. CI runner = macOS arm64, Apple Silicon 만 공식 지원.
- **`git -C <abs-path>` 강제** — multi-repo workspace 에서 Bash session cwd drift 로 다른 sibling repo 에 명령 적용되는 사고 방어. `cd` 누적 금지.
