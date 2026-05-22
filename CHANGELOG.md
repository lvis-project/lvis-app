# Changelog

## v0.2.8 — 2026-05-22

### 안정성 / 네트워크

- **Sub-agent Azure Foundry private endpoint 정렬** (PR #1083) — `agent_spawn` 으로 생성된 child conversation loop 도 parent 와 같은 guarded Electron `net.fetch` 기반 LLM fetch 를 상속해 public Azure endpoint 로 우회하지 않도록 했다.
- **macOS 프록시/PAC 환경 private endpoint 고정** — demo host-map 에 포함된 Azure Foundry LLM/web_fetch URL 은 전용 Electron session 을 `direct` proxy mode 로 사용해 시스템 프록시/PAC 가 Chromium host resolver mapping 을 우회하지 못하게 했다.
- **Builtin internet tools resolver 정렬** (PR #1089) — `web_search` / `web_fetch` 같은 builtin network tools 도 Electron `net.fetch` 를 주입받아 demo host resolver/private endpoint mapping 을 공유한다.
- **Demo host-map mapped `web_fetch` 승인 경계 보강** (PR #1089) — demo host map 에 의해 private endpoint 로 해석되는 URL 은 public DNS 상 public IP 로 보이더라도 private-network approval category/cache key 를 사용한다.
- **LLM/Marketplace combined health 안정화** (PR #1083) — background refresh 중 상태가 `online → checking → online` 으로 깜빡이지 않도록 마지막 concrete 상태를 유지한다.

### 개발 / 패키징

- **Dev/start launch SOT 통합** (PR #1081/#1089) — `bun run dev`, `bun run start`, packaged smoke, Windows NSIS smoke 가 같은 Electron launch env/arg helper 를 사용한다. `.env.demo`, Windows-safe GPU flags, `--no-sandbox`, `--user-data-dir`, UTF-8 env, `LVIS_WIN_NO_SANDBOX` 정책이 한 경로에서 적용된다.
- **Package footprint guard 정렬** (PR #1089) — runtime script packaging checks 를 `BUILD_ASSETS` SOT 에서 파생해 dev/build/watch 자산 목록과 drift 나지 않도록 했다.
- **Sequential status toast 안정화** (PR #1081) — install/update toast burst 에서 뒤쪽 toast 가 앞쪽 toast 만료 시간 때문에 즉시 사라지는 queue expiry 문제를 수정했다.

### 검증

- PR #1081: focused `useStatusBar` Vitest 23 pass, repeated focused run 5/5 pass, targeted Vitest 5 files / 73 pass, `bun run typecheck`, `bun run build`.
- PR #1083: focused Vitest 4 files / 42 pass, `bun run typecheck`, `bun run build`, `git diff --check`.
- PR #1089: launcher/package `node --check`, electron launch helper node tests 7 pass, focused host-resolver/web-fetch/launch Vitest 4 files / 47 pass, full Vitest 443 files / 5841 pass / 13 skipped, `bun run typecheck`, `bun run build`, remote CI success, cluster review Critical=0/Major=0.
- macOS 프록시/PAC private endpoint fix: focused Vitest 5 files / 93 pass, `bun run typecheck`, `bun run build`, full Vitest 443 files / 5849 pass / 13 skipped, Electron direct-session probe `200` vs system proxy path `403 ThrowExceptionDueToTrafficDenied`.

---

## v0.2.7 — 2026-05-22

### 안정성 / 패키징

- **Windows uninstall 실제 삭제 검증** (PR #1080) — NSIS uninstall 이 확인 다이얼로그 후 조용히 종료되는 대신 설치 폴더와 핵심 앱 파일 잔존 여부를 검증한다. 삭제 실패 시 실패 exit/error 로 보고하고, GUI uninstall 은 관리자 권한 재시도 1회만 제공한다.
- **사용자 데이터 보존 경로 유지** (PR #1080) — `/KEEP_APP_DATA` 와 update uninstall (`--updated`) 경로는 기존처럼 사용자 데이터를 삭제하지 않으며, 관리자 권한 재시도도 앱 파일 제거 범위로 제한한다.
- **Windows installer smoke 확장** (PR #1080) — Windows setup.exe smoke 가 silent install, installed app launch, `/S /KEEP_APP_DATA` uninstall, full `/S` uninstall, 설치 폴더 제거, user data cleanup 을 disposable Windows runner 에서 검증한다.

### 배포

- `latest` release 에 Windows/macOS/Linux versioned installer 와 stable `LVIS-latest-*` alias asset 을 함께 포함한다.

### 검증

- PR #1080: focused desktop packaging Vitest 6 pass, `bun run typecheck`, `bun run build`, remote CI success.
- Build Installers run `26239492691`: Windows NSIS smoke verified `/S /KEEP_APP_DATA` and full `/S` uninstall both remove the install directory; full uninstall removes LVIS user data paths.

---

## v0.2.6 — 2026-05-21

### 개선

- **도구 입력/출력 pretty JSON 표시** (PR #1075) — 일반 도구 카드와 compacted/verbatim 원문 확장 UI 가 공통 payload formatter 를 사용해 JSON 입력/출력을 보기 쉬운 pretty JSON 으로 표시한다.
- **Azure Foundry private endpoint LLM fetch 정렬** (PR #1077) — packaged build 의 Azure Foundry SDK 호출이 Electron `net.fetch` 기반 safe fetch 를 사용해 Chromium host resolver/private endpoint mapping 을 공유한다. 적용 범위는 검증된 Azure Foundry HTTPS host 로 제한하고, non-Azure provider 는 기존 fetch 경로를 유지한다.

### 안정성 / 패키징

- **Windows NSIS installer smoke 추가** (PR #1075/#1076) — Build Installers Windows job 이 `win-unpacked` 실행뿐 아니라 setup.exe silent install, installed `LVIS.exe` launch, silent uninstall 을 검증한다.
- **Windows update uninstall 데이터 보존** (PR #1075) — update uninstall 경로의 `${isUpdated}` / `/KEEP_APP_DATA` / `--updated` 신호를 custom NSIS uninstall hook 이 존중해 사용자 데이터를 보존한다.
- **Windows smoke cleanup race 안정화** (PR #1076) — Chromium temp cleanup EBUSY 와 NSIS uninstall 완료 직후 파일 제거 race 를 smoke 실패로 오인하지 않도록 외부 cleanup 경계를 기다리거나 best-effort 로 처리한다.

### 검증

- PR #1075: focused ToolGroupCard/CompactedToolResult Vitest 2 files / 41 pass, `bun run typecheck`, `bun run build:renderer`, remote CI success.
- PR #1076: PR CI success, Build Installers PR-head run success across macOS/Linux/Windows including Windows NSIS install/launch/uninstall smoke.
- PR #1077: safe LLM fetch / provider fetch injection focused Vitest, `bun run typecheck`, `bun run build`, remote CI success.

---

## v0.2.5 — 2026-05-21

### 개선

- **Local Indexer update lifecycle 정렬** (PR #1073) — Marketplace update button 과 `lvis://` install path 가 공통 lifecycle helper 를 사용한다. catalog/runtime 에서 기존 설치 상태를 확인한 뒤 artifact patch 전에 실행 중인 플러그인을 먼저 중지하고, install/start 실패 시 기존 runtime 또는 이전 artifact 로 복구한다.
- **마켓플레이스 플러그인 업데이트 확인 주기 단축** (PR #1073) — 기본 update check interval 을 6시간에서 10분으로 낮춰 managed plugin 업데이트가 더 빨리 노출되도록 했다.
- **플러그인 준비 상태 표시 보강** (PR #1071) — host-managed Python 플러그인의 `preparing` 단계가 설정 패널, 플러그인 목록, 메인 플러그인 그리드에 유지 표시된다. Local Indexer 처럼 로드 전 준비 중인 플러그인도 placeholder 상태로 드러난다.
- **Azure Foundry reasoning 노출** (PR #1072) — Azure Foundry 응답의 reasoning/thinking 정보를 visible transcript 흐름에 맞춰 표시한다.

### 안정성

- **Python dependency sync 출력 억제** (PR #1071) — `uv pip sync` 의 대량 stderr 다운로드 로그는 tail 만 보존하고 UI thread 를 압박하지 않도록 조정했다. 프로세스는 기존대로 분리 실행되며 progress event 만 렌더러로 전달한다.
- **Marketplace health probe 안정화** (PR #1070) — 정상 marketplace 에서 status ping abort WARN 이 반복되지 않도록 timeout, in-flight coalescing, cache, stale-generation discard 를 정렬했다.
- **rollback metadata 보존** (PR #1073) — prior-version rollback 은 최신 catalog SHA 와 비교하지 않고 설치 당시 registry snapshot / bundle metadata 를 사용해 admin install source 와 artifact metadata 를 보존한다.

### 검증

- PR #1070: focused Vitest 2 files / 37 pass, `bun run typecheck`, `bun run build`, remote CI success.
- PR #1071: focused PluginRuntime / PluginCard / PluginConfigTab / PluginGridButton suites 95 pass, `bun run typecheck`, `bun run build`.
- PR #1072: remote CI success.
- PR #1073: focused lifecycle/marketplace suites 117 pass, update interval source regression 1 pass, `bun run typecheck`, `bun run build`, remote CI success, Copilot inline comments 0.

---

## v0.2.4 — 2026-05-21

### 신규 기능

- **render_html 전용 preview window** (PR #1063) — 채팅 inline webview 대신 별도 sandboxed BrowserWindow 에서 HTML 결과를 열도록 전환. 저장 세션 replay 는 inert launcher 로 유지하고, 새로 완료된 `render_html` 결과만 1회 자동 open.
- **preview window 내부 JavaScript 제어** (PR #1066) — JavaScript 허용/차단 토글을 채팅 카드가 아니라 실제 preview window toolbar 로 이동. preview shell 은 LVIS theme token 을 주입하고, tool description 도 `hsl(var(--background))` / `foreground` / `primary` / `muted` / `border` 기반 디자인을 권장하도록 정렬.

### 개선

- **plugin surface directory grant 정렬** (PR #1065) — plugin UI shell, preload, renderer resource 접근 경계를 최신 permission policy 에 맞춰 보강.
- **설정 권한 목록 scroll 안정화** (PR #1064) — Settings → 권한 → 허용 디렉터리 삭제 후 스크롤 위치가 상단으로 튀지 않도록 삭제 전후 scrollTop 을 보존.
- **toolbar help hint 정리** (PR #1063) — 상단 toolbar 의 `⌘ + ?` help hint pill 과 stale first-boot tour anchor 를 제거해 현재 onboarding flow 와 맞춤.

### 보안 / 안정성

- `render_html` preview 는 기존 `lvis-render-html` network-deny partition, CSP-first document, isolated renderer boundary 를 유지.
- preview IPC / preload / renderer 회귀 테스트로 arbitrary HTML 이 Node, app preload API, unrestricted network 에 접근하지 못하도록 고정.
- stale `fix/html-render-open-window*` 로컬 worktree/branch 는 최신 main 의 #1063/#1066 구현보다 오래된 축소판임을 확인하고 제거했다.

### 검증

- PR #1063: focused Vitest 6 files / 86 pass, `bun run typecheck`, `bun run build`, remote CI `build-and-test` / CodeQL success.
- PR #1064: focused PermissionsTab Vitest 3 files / 27 pass / 1 skipped, `bun run typecheck`.
- PR #1066: focused Vitest 4 files / 60 pass, `bun run typecheck`, `bun run build`.

---

## v0.2.3 — 2026-05-20

### 신규 기능

- **저장 세션 보존 및 채팅 목록 로드 wiring** — hamburger memory tab 의 채팅 목록 row 를 실제 session load 로 연결하고, detached memory view 에서도 main window 로 세션을 열 수 있게 했다.
- **LLM 기본 모델 dropdown** — 텍스트 입력 기반 모델 설정을 provider별 default dropdown 으로 정렬.
- **설정 logout + demo re-activation entrypoint** — 설정에서 logout / demo 재활성화 흐름을 직접 진입할 수 있게 했다.

### 개선

- **chat transcript replay SOT 정렬** — 재시작 후 history replay 가 proactive envelope, skill-routed user text, tool result display, system notice, turn summary 를 live streaming 과 같은 projection contract 로 복원.
- **token preflight over-count 수정** — 자동 compact preflight 가 세션 누적 input token 이 아니라 최근 provider-reported raw prompt size 와 wire serialization 기준 estimate 를 사용하도록 정렬.
- **TokenProgressRing denominator 수정** — Azure Foundry deployment id 가 OpenAI 모델명과 일치하면 OpenAI catalog context window 를 상속해 `gpt-5.4-mini` usable budget 이 `98,000` 대신 `360,000` 으로 계산.
- **token ring tooltip 상단 상세화** — 비용 예측 tooltip 과 같은 상단 hover 패턴으로 context used / limit / remaining / usage / TPM 정보를 표시.
- **plugin install progress alias 정리** — 요청 slug 와 canonical plugin id 사이 install progress ghost 를 제거하고 plugin cell alias 로 같은 셀에 진행 상태를 표시.

### 안정성 / 패키징

- **plugin dependency lifecycle runtime setup** — host boot 에서 plugin Python dependency sync 를 직접 수행하지 않고 plugin runtime prepare/start 경계로 이동.
- **demo activation relaunch continuity** — dev runner 재시작, host demo status IPC, Foundry endpoint 검증을 통해 첫 활성화 후 relaunch 상태 보존.
- **atomic release publish workflow** — tag build artifact 를 single publish job 으로 모아 GitHub Release asset partial upload race 를 제거.
- **uv runtime packaging hardening** — packaged uv materialization, license notice, package footprint gate 를 보강.

### 검증

- 주요 focused suites: chat/session replay, auto-compact/context-budget/pricing, plugin runtime/install lifecycle, demo activation, status bar, token ring.
- `bun run typecheck`, `bun run build`, macOS package footprint, remote CI / CodeQL / cluster-detector success.

---

## v0.2.2 — 2026-05-20

### 신규 기능

- **Onboarding UX 전체 재설계** (PR #1044) — 4 단계 forced-choice + memory-first flow + ping-aware welcome.
  - **ScenarioShowcase**: 시연 footer 의 "이런 식으로 동작해요" 라인 제거. 버튼 `로그인하에 LVIS 시작하기` / `뒤로가기`. 4 카드 grid 에서 skip/건너뛰기 제거 — 사용자가 *반드시 카드 선택*.
  - **LoginModalConversational**: 1/2/3 chip 화면의 취소 + Esc/outside dismissal 제거 (forced choice). 데모 자격증명 (chip 1) 클릭 시 *fullscreen 새 page* 로 transition — 상단 `← 뒤로가기` + 활성코드 입력 + 모든 취소 버튼 제거.
  - **Chain restructure**: `welcome` stage 폐지, `personalized_welcome` 신설 (memory 다음, tour 이전). MemorySeedDialog 가 LoginModal 직후 바로 등장 → PersonalizedWelcome → tour 순서.
  - **PersonalizedWelcome** (신규 component): 호칭/자기소개 반영 인사 + `api.pingAiProvider()` 로 LLM 연결 확인 + latency 표시. 확인 버튼만 (skip 없음).
  - **SpotlightTour**: ⌘+? 도움말 step 을 #4 → 마지막 #8 위치로 이동.
  - **PluginShowcase**: `둘러보기 →` → inline `펼쳐보기 ↓` expansion. 외부 navigation 제거 — 스폿라이트 2 노출 버그 인식 해소.

### Internal

- **Demo activation: `LVIS_DEMO_ENABLED` 환경변수 폐기** (PR #1040). `captureDemoCredentials()` 가 `LVIS_DEMO_KEY_<VENDOR>` 의 존재만으로 demo 활성을 판정 — activation code (수동 발급) 자체가 유일한 gate. master gate env var 가 누락된 `.env.demo` 가 demo activation 후에도 `isDemoEnabled()=false` 로 떨어지면서 onboarding chain 이 skip → ChatView empty-state 로 떨어지던 SOT divergence 해소. `whitelist-registry` 의 demo snapshot 분기도 `useDemoSnapshot` 옵션만 read — env fallback 제거.
- **Release process 문서화** (PR #1037). `docs/development/release-process.md` SOT + `CLAUDE.md` 의 Release Process section. branch+PR flow / partial asset recovery / intentional limits (Mac arm64 only, electron-builder publish race).

### 사용자 영향

- *진짜 zero-touch demo experience*: activation code 한 줄 → 자동 relaunch → 두 번째 boot fully active. 환경변수 export / `.env.demo` 수동 편집 / 터미널 사용 *완전 불필요*.
- Forced-choice onboarding: 매 화면 1-3 옵션 중 선택. 사용자가 *어디서 막힐 지* 명확.

---

## v0.2.1 — 2026-05-19 (hotfix)

### Critical fix

- **loginMockup IPC 일관 error handling** — Step 2/3 (`llm-key-issuing`/`sandbox-preparing`) 의 unhandled throw 가 IPC reject 로 leak 되어 "로그인 처리 중 오류" 발생하던 회귀 해소. 모든 step 의 try/catch 일관 + 결정적 error code 반환.
- **First-activation host-resolver race** — packaged build 에서 첫 activation 시 Chromium net stack 이 frozen (command-line frozen after `app.whenReady()`). activation 성공 후 자동 `app.relaunch()` 추가 — 다음 boot 의 `loadPersistedDemoActivationSync()` + `applyDemoHostResolverRules()` 시점 매핑 활성.
- **Main process console logging 강화** — `~/Library/Logs/LVIS/main.log` (macOS) / `%APPDATA%\LVIS\logs\main.log` (Windows) 에 stack trace 기록. 진단 가능.
- 새 error code: `llm-key-issuing-failed` / `reviewer-rewire-failed` / `endpoint-unreachable` / `requires-relaunch` — 사용자 친화 한국어 메시지 매핑.

### Internal

- ULTRATHINK 4-agent 진단 (tracer / debugger / critic / verifier) 으로 root cause 확정. PR #1031.

---

## v0.2.0 — 2026-05-19

### 신규 기능

- **Interactive Onboarding Chain** — 첫 부팅 사용자 흐름 재설계. FSM reducer 기반: `ScenarioShowcase → LoginModal → WelcomeQuestion → MemorySeed → SpotlightTour (8-step) → PluginShowcase → 첫 chat`.
- **Interactive ScenarioShowcase (Option A)** — 4 시나리오 카드. 카드 클릭 시 inline demoAutoplay turn 시연.
- **LoginModal Conversational** — chat-style 인증 UX. chip 3개.
- **Demo Activation Code 시스템** — AES-256-GCM 한 줄 code → `.env.demo` 자동 unpack.
- **Memory Seed Wizard** — 호칭 + 자기소개 → MEMORY.md 영구 저장.
- **SpotlightTour 8-step** — composer/도구/⌘K/⌘?/history/Settings/status bar/plugin entry.
- **TutorialDialog (Discovery Swipe)** — 5장 카드 swipe.
- **Live Auto-play 시스템** — scripted-turn engine (returning user 만 활성).
- **PluginShowcase** — Tour 종료 후 plugin 별 설명.
- **Settings → 일반 tab** — 계정 + 워크스페이스 통계 + 시스템/기반 기술 stack.
- **Settings → 마켓플레이스 tab 재구성** — primary CTA + 고급 옵션 collapsed.
- **Status bar 재설계** — marketplace dot + vendor/model 표시.

### 개선

- Onboarding pace + animation, Boot splash 우하단 stack, App 버전 SoT 정정, Demo 모드 host-resolver-rules, Cross-platform 정합, work-proactive → work-assistant rename, uv CI cache.

### 버그 fix

- LoginModal race / ScenarioShowcase closet-flash / DemoAutoplay chain 종료 / SpotlightTour 2번 노출 / "로그인된 척" race / Activation 자동 advance.

### 보안

- AES-256-GCM, IPC sender frame validation, 0o600/0o700 permissions, audit prefix + rate-limit.

### Internal

- 30+ PR merged dev → main (PR #1028). 4-agent ralph review 완료.

---

## #893 — login-and-secret-allowlist

### M1 — perm-revoke → bearer-abort wiring

- `PermissionManager` now owns per-plugin `AbortController`s and exposes
  `getPluginRevokeSignal(pluginId)` + `revokePluginAccess(pluginId, reason)`.
- The three persisted-mutation entry points (`addAlwaysAllowedPersist`,
  `addAlwaysDeniedPersist`, `removeRule`) call `revokeAllPluginAccess(...)`
  after their broadcast so outstanding `hostApi.resolveApiKey` bearers are
  aborted on any rule change.
- `resolve-api-key.ts` accepts a `getPluginRevokeSignal` dep and merges it
  with the caller's request signal via `AbortSignal.any` so the returned
  bearer's `release()` fires on whichever signal aborts first.
- Boot wiring threads the live `PermissionManager` into `initPluginRuntime`
  → per-plugin `resolveApiKey` host implementation.

Before this change, `broadcastConfigChanged` notified the renderer config tab
but did NOT signal aborting plugins' in-flight bearers. The `release()`
listener inside `resolve-api-key.ts` was dead weight because no upstream
caller wired the controller. A plugin that captured the bearer in a closure
could continue calling the upstream provider after the user revoked access.

### M2 — demo snapshot expiry documented

- `marketplace-whitelist.demo.json` retains `expiresAt: 2030-01-01` AS-IS.
  This is INTENTIONAL — kiosk / trade-show machines run the bundled snapshot
  for the lifetime of the signed app binary, so a short expiry would brick
  long offline deployments.
- Production catalog (live `lvis-project/marketplace-whitelist` repo) uses
  a rolling 90-day expiry and is fetched + verified at boot via
  `whitelist-fetcher.ts`. The demo path is gated behind
  `LVIS_DEMO_ENABLED=1` so production builds never load the demo snapshot.
- Comment header added near the demo-snapshot loader in
  `src/plugins/whitelist/whitelist-registry.ts` documenting the policy.

### Optional — whitelist-bootstrap shutdown signal

- `wireWhitelistRegistry` accepts an optional `appShutdownSignal: AbortSignal`
  that is threaded through to the whitelist fetch so app-quit during a slow
  CDN response unblocks boot/shutdown without waiting up to 10s for the HTTP
  timeout.
