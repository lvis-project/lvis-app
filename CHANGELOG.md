# Changelog

## v0.2.0 — 2026-05-19

### 신규 기능

- **Interactive Onboarding Chain** — 첫 부팅 사용자 흐름 재설계. FSM reducer 기반: `ScenarioShowcase → LoginModal → WelcomeQuestion → MemorySeed → SpotlightTour (8-step) → PluginShowcase → 첫 chat`.
- **Interactive ScenarioShowcase (Option A)** — 4 시나리오 카드 (회의록 정리 · 문서 검색 · 업무 도우미 · 멀티-에이전트). 카드 클릭 시 inline demoAutoplay turn 시연 후 "이 시나리오로 시작 →" 선택.
- **LoginModal Conversational** — chat-style 인증 UX. chip 3개 (데모로 30초 체험 / API 키 직접 / 조직 SSO 곧 지원).
- **Demo Activation Code 시스템** — AES-256-GCM 암호화된 한 줄 activation code 입력 → `.env.demo` 자동 unpack (`~/.lvis/secrets/`). passphrase 만 binary 포함, payload 는 외부 채널로 전달 → 2-factor 효과.
- **Memory Seed Wizard** — 호칭 + 한 줄 자기소개 → `~/.lvis/memories/MEMORY.md` 영구 저장 + 정적 keyword→plugin 추천 chip.
- **SpotlightTour 8-step** — composer / 도구 승인 / ⌘K 팔레트 / ⌘? 도움말 / 채팅 history / Settings / status bar vendor / plugin entry. 각 step 의 production DOM anchor 보장.
- **TutorialDialog (Discovery Swipe)** — 5장 시나리오 카드 stack swipe (✓/✕/↺). `⌘+Shift+T` 또는 도움말 메뉴 또는 채팅 빈 공간 우클릭으로 진입.
- **Live Auto-play 시스템** — scripted-turn engine + fake sandbox + REC indicator + "키 잡기" take-over handoff. *returning user 만* 자동 활성 (첫 부팅은 onboarding chain 우선).
- **PluginShowcase** — Tour 종료 후 4 plugin 카드 (meeting · local-indexer · work-assistant · multi-agent) 별 설명 + "둘러보기" → 해당 SpotlightTour scenario.
- **Settings → 일반 tab** — 계정 카드 (Avatar + 호칭 + vendor + 데모 모드 + MEMORY 자기소개 미리보기) + 워크스페이스 통계 (플러그인 / 도구 / 에이전트 / 스킬 / 역할 개수 · 마켓플레이스 상태 dot) + 시스템 정보 (운영체제 · 앱 버전 · 기반 기술 stack: Electron / Node / Chromium / V8).
- **Settings → 마켓플레이스 tab 재구성** — 상단 violet-gradient "🛒 마켓플레이스 열기 →" CTA + 마켓플레이스 상태 dot. 패키지 인벤토리 위, "고급 옵션" accordion (서버 연결 · URL · 사설 네트워크 · API 키) 하단 default collapsed.
- **Status bar 재설계** — 좌측 마켓플레이스 dot + tooltip `Marketplace: Online/Offline` · vendor + model 표시 (`🔷 azure-foundry · gpt-5.4-mini`) 클릭 시 Settings → LLM 으로 이동.

### 개선

- **Onboarding pace + animation** — type-on stagger 720ms · success dwell 1.8s · cross-fade transition 100ms overlap · slide-up animation. `prefers-reduced-motion: reduce` 시 opacity-only fade.
- **Boot splash 우하단 stack** — LVIS 버전 + Electron + Node + Chromium + V8 (이전 Electron 버전만 표시).
- **App 버전 SoT 정정** — Settings → 일반 → "앱 버전" 이 LVIS `package.json` 직접 parsing (이전 `vunknown` 회귀 해소).
- **Demo 모드 host-resolver-rules** — Electron app 수준 DNS 매핑 (`/etc/hosts` 수정 불필요, sudo 권한 0). 내부 Azure Foundry endpoint 자동 매핑.
- **Cross-platform 정합** — macOS 워딩 제거, OS 글리프 (🍎🪟🐧💻) 만 유지. "운영체제" 일원화.
- **work-proactive → work-assistant 일괄 rename** — onboarding surface 의 사용자-facing label 정합.
- **uv binary CI cache** — `actions/cache@v4` 로 `resources/uv/` 캐시. `resources/uv-archives/` .gitignore 강화 (binary 가 git 에 들어가지 않도록).

### 버그 fix

- **LoginModal 진입 race** — fresh state 에서 자동 표시 안 되던 회귀 해소.
- **ScenarioShowcase closet-flash** — initial state `idle` 회귀 + probe-skip 가 showcase 단계 우회 안 함.
- **DemoAutoplay 가 chain 종료** — `onFinished` 가 `onboardingCompleted: true` 강제 set 하던 회귀 해소. `shouldActivateDemoAutoplay` predicate invert (returning user 만 active).
- **SpotlightTour 2번 노출** — `chainTourBroadcastRef` idempotency 가드 + `activeScenarioIdRef` defense-in-depth. React 18 StrictMode + dependency re-render 둘 다 차단.
- **"로그인된 척" race** — chain done 직후 `hasApiKey === null` 상태에서 ChatView ready-state paint. `effectiveHasApiKey` mask 강화 + ChatView `hasApiKey === true` 조건 변경.
- **Activation 자동 advance** — paste → "활성 →" 한 번 클릭 → 즉시 인증 진행 (Enter 다시 X). `activationConfirmed` 게이트 통째 제거.
- **Demo activation persist-failed audit** — partial state audit trail 정합 (warn entry 추가).

### 보안

- **AES-256-GCM activation codec** — random IV per call + 16B auth tag + scrypt KDF.
- **IPC sender frame validation** — 모든 신규 handler `validateSender` + `auditUnauthorized`.
- **0o600/0o700 file permissions** — `~/.lvis/<feature>/` 통째 권한 강화. atomic write (`.tmp` → rename).
- **Audit prefix 강제** — `[demo-activation]` / `[demo-autoplay]` rate-limit 30/s + 256B field cap + `redactFsPath`.

### Breaking changes

없음. 기존 사용자 settings 자동 migration (legacy `vendors[v].authMode` → top-level `llm.authMode`, appearance v1→v2, `normalizeFeatureFlags` silent default).

### Internal

- 30+ PR merged to dev → main release (PR #1028).
- 4-agent ralph review 완료 (architect PASS / critic round-2 ACCEPT / security APPROVE-WITH-CONDITIONS).
- 5500+ unit/integration tests pass.

### Storage

`~/.lvis/` namespace 신규 디렉토리:
- `~/.lvis/onboarding/tour-state.json` — SpotlightTour 진행 상태 (0o600)
- `~/.lvis/tutorial/preferences.json` — Discovery Swipe 선호 (0o600)
- `~/.lvis/secrets/.env.demo` — Demo activation 후 자동 unpack (0o600)
- `~/.lvis/memories/MEMORY.md` — MemorySeed 자기소개 영구 저장

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
