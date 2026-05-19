# Changelog

## Unreleased

### Internal

- **Demo activation: `LVIS_DEMO_ENABLED` 환경변수 폐기**. `captureDemoCredentials()` 가 `LVIS_DEMO_KEY_<VENDOR>` 의 존재만으로 demo 활성을 판정 — activation code (수동 발급) 자체가 유일한 gate. master gate env var 가 누락된 `.env.demo` 가 demo activation 후에도 `isDemoEnabled()=false` 로 떨어지면서 onboarding chain 이 skip → ChatView empty-state 로 떨어지던 SOT divergence 해소.
- `whitelist-registry` 의 demo snapshot 분기도 `useDemoSnapshot` 옵션만 read — env fallback 제거. caller (`boot/steps/whitelist-bootstrap.ts`) 가 항상 `isDemoEnabled()` 결과 명시 전달.
- 영향 file: `demo-credentials.ts`, `auth.ts`, `whitelist-bootstrap.ts`, `whitelist-registry.ts` + 5 test + `.env.demo.example` + `docs/onboarding/local-demo-setup.md`.

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
