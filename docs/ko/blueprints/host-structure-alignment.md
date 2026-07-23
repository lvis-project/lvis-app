# Host Structure Alignment (#1409 SDK/API/CLI boundary + #1411 mega-file decomposition)

> Status: **Landed** (single-PR, atomic commits C0–C19, branch `refactor/host-structure-alignment`).
> Supersedes the "first refactor target" framing of #1411 with a full, dependency-ordered
> decomposition, and lands the #1409 contract firewall that makes both safe in one PR.
> Extends (does not replace) `docs/architecture/architecture.md` §4.6 and
> `docs/blueprints/phase3-folder-refactor-plan.md`.
>
> **Result (mega-file LOC, before → after thin orchestrator):**
> conversation-loop 4328→836 · executor 3277→2251 (+11 pipeline units) ·
> plugins/runtime/index 2381→2060 (+7 collaborators) · boot/steps/plugin-runtime 2203→549 ·
> App 2338→796 · ChatView 2190→700 · main 1987→392 · boot 1795→402.
> All public contracts byte-identical; `contract/` + `api|cli|sdk/` added. Every discovered
> issue was handled inline (no backlog).
>
> **Follow-up landed (#1436):** the loopback local API server — `api/http-server.ts`
> (node:http, 127.0.0.1-only, per-boot Bearer secret with constant-time compare,
> `POST /v1/dispatch` + `GET /v1/events` SSE + `GET /v1/health`),
> `api/stream-broadcaster.ts` (chat-stream fan-out), opt-in lifecycle in
> `src/main/local-api-server.ts` (Settings `system.localApiServer` / `LVIS_LOCAL_API=1`,
> default OFF; discovery file `~/.lvis/local-api/server.json` via `openFeatureNamespace`;
> closed in app-shutdown), and the runnable CLI (`cli/http-client.ts` +
> `scripts/lvis-cli.ts`, `bun run cli -- <command>`) over the same contract.
>
> **Follow-up landed (external mutation authz):** approval-gate-mediated external
> mutation for the one channel in `contract/app-contract.ts`'s
> `EXTERNAL_MUTATION_CHANNELS` allowlist (`PERMISSIONS.setMode`) — the loopback
> Bearer secret authenticates the caller, but the mutation itself is authorized
> only by the user's own "Allow" click on the in-app `ApprovalGate` modal
> (`buildExternalMutationApprover` in `src/main/local-api-server.ts`, wired
> through `src/api/local-api.ts`); a decline/timeout resolves as
> `external-mutation-denied` (HTTP 403). `src/permissions/permission-mode-apply.ts`
> accepts the resulting `PermissionModeApprovalBypass` (`source:
> "local-api-approval"`) so the approved change applies without a second modal.
> `LvisClient.setPermissionMode` (SDK) and `permission:set-mode <mode>` (CLI,
> exit 0 approved / 1 denied / 2 usage) are the external entry points. Default
> posture without a wired approver is unchanged (fail-closed). Remote access and
> multi-user authorization stay out of scope for Epic #1409.
>
> Remaining follow-ups (still deferred): authenticated non-renderer authz for
> the rest of the gesture-gated surface, remote/multi-user exposure beyond
> loopback, and thinning App.tsx further toward <300.

## 1. Why (both issues, one root problem)

- **#1411** — Seven orchestration mega-files (~19k LOC combined) concentrate maintenance cost
  and regression risk: `engine/conversation-loop.ts` (4327), `tools/executor.ts` (3277),
  `plugins/runtime/index.ts` (2381), `boot/steps/plugin-runtime.ts` (2203),
  `ui/renderer/App.tsx` (2338), `ui/renderer/ChatView.tsx` (2190), `main.ts` (1986) + `boot.ts` (1795).
- **#1409** — The plugin runtime is a strong public contract, but the **app itself** has no stable,
  transport-agnostic contract. Its logic is only reachable through Electron IPC + a renderer-only
  preload surface. There is no CLI, no local API, no SDK — and no boundary that separates
  "renderer-internal" channels from "safe-to-expose-externally" ones.

These are the same root problem: **the core agent logic and its transport/consumer surfaces are
not separated.** Fixing the boundary (#1409) creates the *refactor firewall* that lets the
internals (#1411) be restructured freely, and decomposing the internals (#1411) is what makes a
clean boundary expressible. So they are executed together.

## 2. Reference host analysis (goose / gemini-cli / codex / hermes / opencode / cherry-studio / cline / claude)

The comparison converges on **one pattern across every mature host**:

> **One transport-agnostic core, many thin surfaces.** The agent loop, tool execution, and
> plugin/extension lifecycle live in a core with **zero UI/transport imports**. CLI, local API,
> desktop renderer, and SDK are all *thin adapters* over the *same* published contract — never
> parallel reimplementations.

| Host | Core | Surfaces | Contract SOT | Key lesson for LVIS |
|---|---|---|---|---|
| **goose** (Block, Rust) | `crates/goose` | `goose-cli` (in-proc), `goose-server`/`goosed` (HTTP+SSE daemon), `ui/desktop` (Electron → HTTP client of goosed), `goose-sdk` (uniffi) | `utoipa` → `openapi.json` → `@hey-api/openapi-ts` → typed TS client | Desktop talks to core via a **local daemon (HTTP+SSE)**, not bespoke IPC; the same contract then serves CLI + remote + automation. Agent file split: `agents/agent.rs` (turn loop) / `tool_execution.rs` / `tool_confirmation_router.rs` + `permission/` / `extension_manager.rs` / `mcp_client.rs` / `subagent_*`. |
| **gemini-cli** (Google, TS) | `packages/core` | `packages/cli`, `packages/sdk` (narrow facade) | `core` exports a **narrow, curated public API**; `Turn.run()` is an async-generator event stream | Two-tier: broad internal core + **narrow SDK facade** (not a broad barrel). Interactive vs non-interactive both over one core. |
| **codex** (OpenAI, Rust) | `codex-core` | `codex-cli`, `codex-tui`, `codex-mcp-server/client`, `codex-exec` | **`codex-protocol` crate** = the shared contract; front-ends depend only on it | The protocol crate is a **firewall**: internals can churn as long as the protocol holds. TUI depends only on protocol, never on core internals. |
| **hermes** (desktop MCP host) | core services | `electron/` (~25 tested `.cjs` units), `plugins/<name>/` | `turn_context` / `turn_finalizer` seams | Small, individually-tested main-process units; plugin-per-directory. |
| **opencode** (sst, TS) | `session/` | generated SDK, TUI | **OpenAPI-as-SOT** → generated SDK | `session/{prompt,processor,llm,compaction}` module split mirrors our turn concerns. |
| **cherry-studio** (Electron) | services | renderer, **two API layers** (internal-IPC vs external-gateway) | `LifecycleManager` phased DI | Explicit **internal-IPC vs external-gateway** split — exactly #1409's renderer-vs-external distinction. |
| **cline** (VS Code) | core | `HostProvider` abstraction | host-provider interface | Abstract the host surface so the same core runs under different shells. |
| **claude / single-npm agent CLIs** | one package | CLI + programmatic SDK | internal module boundaries | Even without a monorepo, a single package stays maintainable via strict internal module seams (registry / streaming-executor / permissions) and exposes an SDK alongside the CLI. |

**Adopted for LVIS (this PR):** the *seam*, not a monorepo migration. We introduce a
`src/contract/` firewall and thin `src/api|cli|sdk/` scaffolds that consume the *same*
transport-agnostic handlers the renderer uses — proving the pattern without breaking the esbuild
entry contract or blowing the atomic-PR budget. Full daemon/network/publish hardening
(goose-style `goosed`) is the explicit **#1409 follow-up**.

## 3. Canonical target structure

See §4.6.1 update landing in this PR. Summary tree (new/changed nodes marked):

```
src/
├── contract/                 # NEW (#1409) — single source of truth for the PUBLIC app contract
│   ├── app-contract.ts       #   PUBLIC_CHANNELS allowlist (versioned) + per-surface req/resp types
│   │                         #   + per-channel classification: mutating-gesture-gated vs non-gated
│   ├── events.ts             #   discriminated-union EVENT STREAM schema (chat:stream, permissions.*, …)
│   ├── trust-origin.ts       #   TrustOrigin: renderer | local-api | cli | plugin-frame  (≠ user-keyboard gesture)
│   └── __tests__/            #   channel-inventory snapshot + preload-shape snapshot + domain-export snapshot + version-freeze
│
├── engine/turn/              # EXTEND (has stream-collector/plugin-expansion/tool-search/knowledge-cap)
│   └── + types/trust-origin/context-carrier/tool-exposure/tool-scope/provider/lifecycle-hooks/
│         compaction/session/commands/loop-context/run-turn/query-loop
│   conversation-loop.ts      #   STAYS as class shell + assembler + re-export facade (byte-identical exports)
│
├── tools/
│   ├── executor.ts           #   안정적인 public barrel 유지 (ToolExecutor + executor contracts)
│   ├── executor-contract.ts  #   public invocation/result/callback contracts
│   ├── executor-implementation.ts # constructor + batch/resume facade; 단일 invocation 위임
│   ├── invocation-runner.ts  #   preparation, path policy, ordered stage orchestration
│   ├── invocation-authorization.ts # permission/reviewer/rationale stage
│   ├── invocation-execution.ts # rate-limit, execution, post-hook, DLP, terminal audit stage
│   ├── invocation-services.ts # stage가 공유하는 명시적 host service boundary
│   ├── executor-ceiling.ts   #   UNCHANGED — owns runWithCeiling/ToolCeilingOutcome/ToolCeilingTerminationReason
│   └── pipeline/             #   NEW — per-responsibility §4.5.6 pipeline units (path-extraction/approval-purpose/
│                             #     audit-entries/display-mask/rate-limiter/reviewer-dispatch/
│                             #     approval-memory-skip/risk-classification/audit-writer/invocation-context)
│
├── plugins/runtime/          # FINISH split (index/manifest-validation/origin-chain/sandbox/snapshots/types exist)
│   └── + lifecycle-timeout/cards/perf-stats/config-overrides/access-control/preparation/plugin-loader
│
├── boot/
│   ├── context.ts            #   NEW — BootContext accumulator threaded through ordered step(ctx) calls
│   ├── assemble-services.ts  #   NEW — assembleAppServices(ctx): AppServices (snapshot-tested key set)
│   └── steps/
│       ├── plugin-runtime.ts #   STAYS as barrel (path + all 26 exports preserved)
│       ├── plugin-runtime/   #   NEW subdir (manifest/approval-gating/app-preference/external-url/trigger-gate/
│       │                     #     types/registry-cache/shutdown-registry/lifecycle/host-api-factory/init)
│       └── + sandbox-init/network-fetch-setup/audit-notification/mcp-setup/marketplace-setup/
│             reviewer-permission-wiring/work-board-setup/routines-wiring/conversation-wiring/plugin-tool-executor
│
├── ipc/
│   ├── handlers/             #   NEW — transport-agnostic pure impls handleX(deps,args): Promise<Result>
│   └── domains/              #   STAYS — thin ipcMain.handle wrappers (validateSender + register + call handlers/*)
│
├── api/local-api.ts          #   NEW scaffold — in-process dispatch, TrustOrigin='local-api'
├── cli/commands.ts           #   NEW scaffold — minimal multitool over the SAME contract
├── sdk/index.ts              #   NEW scaffold — narrow typed facade (gemini two-tier)
│
├── preload.ts                #   STAYS; recomposed. window.* names byte-identical
├── preload/
│   ├── gesture-intent.ts     #   SHARED — userKeyboardIntentTokens + ipc/consumeUserKeyboardIntent (ONE module)
│   ├── public-surface.ts     #   chat/session, plugin-status, permission, marketplace, usage
│   └── internal-surface.ts   #   window controls, theme, dev tools, attach, tour/demo/auth mockup, plugin-frame
│
└── ui/renderer/
    ├── App.tsx               #   composition root (realize <300-line intent; AppProviders/AppShell/AppDialogs)
    ├── ChatView.tsx          #   STAYS as composition root re-exporting ChatView + ChatViewProps
    ├── hooks/  utils/  state/  components/   # extended per per-file plan
```

## 4. #1409 boundary map

- **`src/contract/` is the firewall.** `PUBLIC_CHANNELS` is a *versioned allowlist* of channel
  strings that external consumers may touch (chat send / session list+history / plugin status /
  permission mode / marketplace list / usage). Everything else is renderer-internal.
- **Trust origin is explicit.** `validateSender` today trusts `http://localhost` — so a local API
  would be indistinguishable from the dev renderer. `contract/trust-origin.ts` introduces
  `TrustOrigin = renderer | local-api | cli | plugin-frame`, distinct from the 5s user-keyboard
  **gesture** token. **Mutating gesture-gated channels** (permission/policy/sandbox-install) are
  **classified in `PUBLIC_CHANNELS` and excluded** from the api/cli-exposed subset until an
  authenticated non-renderer authz replaces the gesture token — that authenticated authz is the
  #1409 follow-up (documented, not silently weakened here).
- **One streaming contract.** `lvis:chat:stream` fan-out is abstracted behind an emitter in C10 so
  api/cli consumers get an SSE/emitter bridge (goose `/reply` SSE pattern) instead of a rewrite later.
- **Session addressing is defined even though the impl stays singleton.** Session-scoped channels
  (get-history/session-history/checkpoint/continue-last-user) take a `sessionId` in the contract and
  **fail closed** (`session-not-active` error) when `sessionId !== active` — never silently retarget.
- **api/cli/sdk are thin.** They consume `ipc/handlers/*` in-process; they never reimplement logic.

## 5. Per-file decomposition plan

Each file's exact preserved-export set, extraction variant, and danger zones are in
`per_file_plan` (mirrored below in brief). **The extract-and-reexport slogan is literal for only
4/8 files**; the rest use the correct variant:

| File | Variant | Danger zones (test-gated) |
|---|---|---|
| conversation-loop.ts | extract-to-free-fn + class stays assembler | Wave-4 `run-turn`/`query-loop` implicit `lastRound*/lastContext*` token-projection contract + turn-local closures migrate as one turn-context |
| executor.ts | stable barrel + staged invocation runner | `invocation-runner`가 preparation/path policy를, `invocation-authorization`이 permission/reviewer/rationale 결정을, `invocation-execution`이 rate-limit/execute/finalize를 소유한다. 서로 배타적인 두 sandbox-relaxation 블록은 authorization에 함께 유지하며, `runWithCeiling`/`ToolCeiling*`은 executor-ceiling.ts 소유를 유지하고 Step 6은 Tool-Timeout SOT를 보존한다. |
| plugins/runtime/index.ts | collaborator-CLASS composition + free helpers | 40 private fields → collaborators expose `clear()` in exact `resetLoadedState` order; `PreparationTracker` monotonic generation counter |
| boot/steps/plugin-runtime.ts | barrel reexport + ref-boxes | `host-api-factory`/`lifecycle` capture `let pluginRuntime`/`let loopbackManager` by **mutable binding, lazy read** → pass getters/ref-boxes; preserve `enforceMutatingEffects(instrumentEffectsByPath(...))` nesting + hostFetch single-verb snapshot |
| boot.ts | BootContext threading | `bootstrap()` has ZERO integration test → add electron-mocked test asserting `Object.keys(AppServices)` + construction order FIRST |
| main.ts | extract-and-re-invoke (0 exports) | **KEEP** single-instance/whenReady/`main()` in place; repoint 5 source-pinned regex tests per-move in the same commit |
| App.tsx | extract-and-KEEP (named export stays) | `handleAskRef ↔ handlePluginPrimaryAction` forward-ref cycle; `addFireRef` populated-during-render by `OverlayContextProvider` (must stay inside AppProviders) |
| ChatView.tsx | extract-and-reexport | module-level scroll singletons move WITH the hook in one commit; `handleAttach` flushSync atomic commit must not be split; all data-testids + i18n keys byte-identical |

## 6. Migration sequence (21 atomic commits, dependency-ordered)

`bun run test:vitest -- run <affected-tests>` while iterating; each push runs the full
typecheck/test/build hook once. Renderer changes run only the affected Playwright flow locally.
Doc/SOT (§4.6.1 + CLAUDE.md) is updated **in the same commit that creates each new
top-level dir** (contract/api/cli/sdk), not trailed to the end.

- **C0** `test(ipc)` — channel-inventory + preload-shape + **domain-export** snapshots + chat send/sessions/history handler tests. (Locks the #1409 wire; rename/leak is silent today.)
- **C1** `test(engine,tools,plugins,boot)` — pre-extraction gap locks (handlePermissionCommand branches; ping/generateText errors; branchFromCheckpoint throws; **RateLimiter token-bucket**; executeOne happy-path uiPayload/rawResult; 4-path plugin instantiation parity + perfStats accounting + removePlugin-clears-override; evaluateTriggerSpec deny-branches + Trigger RateLimiter/Dedupe/DenyThrottle + hostFetch closure + openAuth*/clearAuthPartition + config get/set + emit/onEvent).
- **C2** `feat(contract)` — `src/contract/{app-contract,events,trust-origin}.ts` (+ §4.6.1/CLAUDE.md doc-add); sweep inline `lvis:*` literals into `PUBLIC_CHANNELS` (no renames); grep-enforced inline-literal ban in CI.
- **C3** `test(boot)` — electron-mocked `bootstrap()` integration test (AppServices key set + construction-order invariants). Only behavior lock for boot wiring.
- **C4** `refactor(plugins)` — finish runtime split (lifecycle-timeout/cards → perf-stats/config-overrides/access-control → preparation/plugin-loader).
- **C5** `refactor(boot)` — plugin-runtime pure/self-contained clusters into subdir behind the barrel.
- **C6** `refactor(boot)` — plugin-runtime `lifecycle`+`host-api-factory` via ref-boxes; slim `init.ts`. (HIGH; needs C1+C5.)
- **C7** `refactor(tools)` — executor pure helpers → rate-limiter (w/ C1 test) → stateful collaborators → audit-writer.
- **C8** `refactor(tools)` — `invocation-context` (executeOne closures + sandbox-relaxation blocks → explicit per-invocation object). HIGHEST tools risk; needs C1+C7.
- **C9** `refactor(engine)` — conversation-loop Waves 1→4 into `engine/turn/`; class stays assembler.
- **C10** `refactor(ipc)` — split public handlers into pure impl (`ipc/handlers/*`) + thin wrapper (`ipc/domains/*`); move per-registrar state; emitter behind `chat:stream`.
- **C11** `refactor(preload)` — `preload/{gesture-intent,public-surface,internal-surface}.ts`; recompose `preload.ts` (window.* byte-identical).
- **C12** `feat(api,cli,sdk)` — scaffold thin in-process consumers with distinct TrustOrigin; reconcile the 3 out-of-tree handler sites; classify mutating channels (+ doc-add).
- **C13** `test(renderer)` — App renderApp tests + ChatView queue/attach-5-cap/Cmd+K locks + pure-util unit tests; confirm e2e green.
- **C14** `refactor(renderer)` — App+ChatView PURE utils + ImportedTriggerCard/AskUserAnswerBubble.
- **C15** `refactor(renderer)` — ChatView scroll-store+use-chat-scroll (singletons same commit) → permission-toasts → checkpoint-view → message-queue+attachment-picker → transcript-entries+ChatTranscript+ChatComposerDock; e2e.
- **C16** `refactor(renderer)` — App AppProviders/AppShell/AppDialogs then hooks one-at-a-time; realize <300-line root; e2e after each.
- **C17** `refactor(main)` — `main/app-state.ts` then extract modules bottom-up; repoint source-pinned tests per-move; KEEP single-instance/whenReady+main() in `main.ts`.
- **C18** `refactor(boot)` — thread BootContext + assembleAppServices; carve steps easiest-first; C3 gates key-set+order.
- **C19** `docs(architecture)` — final reconcile of §4.6.1 + CLAUDE.md with reality.

## 7. Risks & mitigations (summary)

Full list in the PR description. Highest: executor `invocation-context` closure/sandbox-relaxation
inversion; boot/main weak locks (mitigated by C1/C3 + per-move test repoint); renderer forward-ref/
render-order coupling; module-singleton lifetime (move with consumer); **Cross-Cutting Review Gate**
(permissions/audit/sandbox/ipc/boot touched across C5–C12 → 3-agent cluster review before merge);
No-Fallback rule (each surface moves whole); esbuild entry + `boot.ts` export shape must not change.

## 8. Discovered issues — handled INLINE in this PR (not deferred to backlog)

1. No channel-inventory / preload-shape snapshot exists → **C0** adds them + inline-literal ban.
2. `validateSender` localhost trust leak → **C2** distinct authenticated `TrustOrigin`.
3. Singleton session addressing → **C2** contract-level `sessionId` addressing + fail-closed.
4. `RateLimiter` (tools) + Trigger RateLimiter/Dedupe/DenyThrottle (boot) zero coverage → **C1**.
5. 3 out-of-tree handler sites (main.ts settings-window, window-manager detached, auto-updater) → **C12** contract classification.
6. 5 source-pinned regex tests break on any move → repointed per-move in **C17/C18**.
7. architecture.md §4.6.1 stale (App.tsx <300 vs 2338; plugins/ vs runtime/ dir; hooks list) + CLAUDE.md → updated in-PR.

## 9. Provenance

Derived from a 17-agent analysis workflow (goose/gemini-cli/codex/hermes/opencode/cherry-studio/
cline/claude host analysis + deep-read of all 8 target files + IPC/preload surface + existing
architecture intent), a lead-architect synthesis, and an adversarial completeness critique
(verdict: GO with 7 corrections, all folded in above).
