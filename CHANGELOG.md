# Changelog

## Unreleased

### 플러그인 / 마켓플레이스

- **마켓플레이스 공지 배너 및 marquee 표시** (PR #1259) — Marketplace `GET /api/v1/announcements` 응답을 main-process poller 가 `lvis:marketplace:announcements` IPC 로 renderer 에 전달하고, dismiss 상태를 `settings.marketplace.dismissedAnnouncementIds` 에 저장해 재시작 후에도 숨김을 유지한다. 긴 공지/업데이트 배너 텍스트는 `MarqueeText` 로 overflow 시에만 자동 스크롤하고 reduced-motion 변경 시 정적 표시로 복귀한다.

### 설정 / IPC 경계

- **hostResolverMap 변경 경로 고정** (PR #1259) — generic `lvis:settings:update` 는 이제 `llm.hostResolverMap` 패치를 `host-map-requires-apply-host-map` 으로 거부한다. relaunch-sensitive host map 변경은 dedicated `SETTINGS.applyHostMap` IPC 만 사용해야 한다.

### 검증

- PR #1259: focused announcement/marquee Vitest 6 files / 74 pass, MarketplaceFetcher test-stub Vitest 7 files / 104 pass, `bun run typecheck`, pre-push full Vitest 505 files / 6605 pass / 14 skipped, `bun run build`, `git diff --check`.

## v0.2.18 — 2026-06-01

### 플러그인 / 마켓플레이스

- **플러그인 업데이트 stale catalog 차단 복구** (PR #1198) — 업데이트 배지는 live Marketplace catalog 로 `meeting@0.5.25` 를 감지했지만, 설치 직전 `expectedVersion` 검증은 7일 TTL offline catalog cache 의 stale `meeting@0.5.8` 값을 읽어 정상 업데이트를 차단했다. 업데이트 설치 경로의 버전 검증을 live catalog 조회로 정렬해 banner 와 install guard 가 같은 Marketplace 최신 버전을 기준으로 판단하도록 했다.
- **일반 설치 경로 live fetch 범위 제한** (PR #1198) — `expectedVersion` 이 없는 일반 설치는 기존 catalog/list 경로를 유지하고, 업데이트처럼 기대 버전이 명시된 경우에만 live version guard 를 수행한다.

### 검증

- PR #1198: focused Vitest 4 files / 51 pass, `bun run typecheck`, `bun run build`, `git diff --check`, remote build-and-test / Windows permission path / CodeQL / naming-gate success, Copilot current-head inline comments 0, Cross-Cutting 3-lane review Critical=0/Major=0.

## v0.2.17 — 2026-06-01

### 릴리스 검증

- **라이브 앱 업데이트 설치 경로 검증 릴리스** — v0.2.16 의 updater shutdown handoff 수정이 실제 GitHub 릴리스 피드에서 다음 버전 업데이트를 다운로드하고, 확인 후 종료/설치까지 완료하는지 검증하기 위한 version-only 릴리스다. 업데이트 설치 코드 경로는 v0.2.16 과 동일하며, package version bump 만으로 v0.2.16 → v0.2.17 라이브 업데이트 경로를 만든다.

### 검증

- v0.2.16 과 동일 코드 경로. v0.2.16 검증: Targeted Vitest 4 files / 53 pass, `bun run check:test-quality`, `bun run typecheck`, `bun run build`, `git diff --check` pass.

## v0.2.16 — 2026-06-01

### 앱 업데이트

- **앱 업데이트 적용 재시작 경로 복구** — `quitAndInstall()` 가 먼저 BrowserWindow 를 닫고 앱 종료로 이어지는 Electron updater 계약을 LVIS 의 close-to-tray / async before-quit / plugin before-quit 핸들러가 `preventDefault()` 로 가로막아 다운로드 완료 후 재시작 설치가 진행되지 않던 문제를 수정했다. 업데이트 설치 의도를 main process 에 표시하고, 해당 경우에는 창 닫기와 종료 이벤트를 updater 가 소유하도록 둔다.
- **업데이트 설치 IPC 경계 보강** — `lvis:update:install-now` 가 실제 재시작/설치 경로가 되었으므로 host renderer sender 를 main process 에서 검증하고, native 확인 dialog 도 같은 IPC handler 안에서 소유해 renderer 나 plugin shell 이 확인 단계를 건너뛰어 설치를 강제하지 못하게 했다.
- **업데이트 배지 IPC race 방어** — renderer 의 초기 `getAppUpdateState()` snapshot 이 더 늦게 도착해 live update push 를 덮어쓰지 못하게 하고, install IPC 가 실패하거나 앱이 종료되지 않는 경우에는 local click gate 를 해제해 재시도 가능하게 했다.

### 검증

- Targeted Vitest: `release-prep`, `app-update-install-intent-source`, `use-app-update`, `plugin-runtime` — 4 files / 53 pass.
- `bun run typecheck`, `bun run build`, `git diff --check` pass.

## v0.2.15 — 2026-06-01

### 플러그인 / 마켓플레이스

- **플러그인 secret URL 오입력 차단** (PR #1194) — API-key 형태의 플러그인 secret 필드에 `http://` / `https://` endpoint 값이 저장되거나 provider 호출까지 흘러가는 경로를 차단했다. 저장 경계와 HostApi read 경계에서 URL-shaped 값을 거부/격리해 provider 401 에러에 잘못된 endpoint 문자열이 노출되는 문제를 막는다.
- **마켓플레이스 업데이트 버전 검증 강화** (PR #1194) — renderer 가 전달한 기대 버전을 신뢰하지 않고, main-process install lifecycle 에서 trusted catalog version 과 먼저 대조한다. 실제 version-changing install 이 일어난 경우에만 rollback/quarantine 을 수행하고, no-op install 뒤 mismatch 는 기존 정상 런타임을 복구한다.

### 안정성 / Windows 검증

- **permission path SOT Windows 정렬** (PR #1194) — reviewer path-field 값과 allowedDirectories 비교를 canonical + case-fold 형태로 통일해 Windows drive/separator 차이로 허용 경로가 HIGH 로 오판되는 문제를 수정했다.
- **persistent approval store Windows 내구성 보강** (PR #1194) — Windows 에서 directory fsync 가 EPERM 을 반환하는 환경을 best-effort 로 처리하고, persistent approval 파일의 read/modify/write 를 직렬화해 동시 rename 충돌을 제거했다.

### 검증

- PR #1194: 3-agent cluster review GO (architect/critic/security, MAJOR 0), `bun run typecheck`, 전체 `bunx vitest run --reporter=verbose` 473 files / 6226 pass / 24 skipped, `bun run build`, pre-push hook(`tsc --noEmit`, `vitest run`, `build`) pass, remote CI build-and-test / Windows permission path / CodeQL / naming-gate / cluster-detector success.

## v0.2.14 — 2026-05-27

### UI / 설정

- **데모 표시 토글 optimistic 전환** (PR #1185) — `features.hideToolFailures` 스위치가 순수 controlled 라 `updateSettings → onSettingsUpdated` broadcast 왕복이 끝나야 움직였고, stale/느린 설정 snapshot 에선 값은 저장되는데 스위치가 시각적으로 멈춰 "클릭이 안 되는" 것처럼 보였다. 클릭 즉시 로컬 state 로 전환(optimistic)하고 authoritative `settings` 값과 effect 로 reconcile, IPC 에러 시 revert 한다. `useSettings.toggleThinking` 와 동일 패턴.

### 검증

- PR #1185: 3-agent 검증 루프(correctness / architecture / test) GO MAJOR=0, `bun run typecheck` + `build:renderer`, 신규 e2e (flip + persist + reopen reflection) pass, remote CI build-and-test / Windows permission path / CodeQL / naming-gate / cluster 전부 success.

## v0.2.13 — 2026-05-26

### UI / 데모

- **도구 실패 배지 숨김 데모 플래그** (PR #1183) — `features.hideToolFailures`(기본 off)를 추가했다. 켜면 대화 타임라인에서 실패한 도구 호출의 "실패" / "오류 있음" 배지를 중립 표식(·)으로 대체해 시연 중 실패가 노출되지 않는다. 표시 전용 — `ToolEntryItem.status` 는 스트림 상태와 감사 로그에 여전히 `"error"` 로 남으며, 실패를 "완료" 로 가리지 않는다. `ToolStatusBadge`/`HiddenStatusMarker` 로 3곳에 복붙돼 있던 배지 렌더를 단일 출처로 통합했고, 설정 → 일반 → "데모 표시" 토글로 즉시 켜고 끌 수 있다.

### 검증

- PR #1183: `bun run typecheck` clean, ToolGroupCard 44 (신규 4) + settings-store 71 Vitest pass, `bun run build:renderer` 성공, remote CI build-and-test / Windows permission path / CodeQL / naming-gate / cluster 전부 success.

## v0.2.12 — 2026-05-26

### 안정성 / 중단 처리

- **툴 실행 중 사용자 중단 지원** (PR #1180) — `abortCurrentTurn()` 이 provider stream 에만 머물지 않고 tool executor 까지 전파되도록 정렬했다. 비협조 툴이 `abortSignal` 을 무시해도 `runWithCeiling()` 이 사용자 중단/ceiling 에서 즉시 반환하고, 이미 취소된 후속 tool call 은 훅/권한 단계 전에 취소 `tool_result` 로 닫는다.
- **Tool-result pair 보존 후 턴 종료** (PR #1180) — tool 실행 중 중단되면 취소 `tool_result` 를 history 에 남긴 뒤 다음 LLM round 로 재진입하지 않고 `[중단됨]` 으로 턴을 종료한다. OpenAI/Anthropic strict tool_use/tool_result pair invariant 를 유지하면서 사용자는 즉시 중단 완료를 확인할 수 있다.

### 검증

- PR #1180: focused Vitest 3 files, `bun run typecheck`, `bun run build`, pre-push full Vitest 470 files / 6204 pass / 13 skipped, remote CI / Windows permission path / CodeQL / naming / cluster success, Copilot inline comments 0.

## v0.2.11 — 2026-05-26

### TPM / 컨텍스트 안정화 (핵심)

- **Eager 도구 노출 회귀 수정 + 플러그인 활성/비활성** (PR #1177) — tool-level deferral 기본-on 회귀(턴마다 ~12회 `tool_search` 디스커버리 라운드로 TPM 폭증)를 되돌려 활성 플러그인 도구 스키마를 다시 eager 로 노출한다. 빌트인은 항상 eager 이며 임계 카운트에서 제외하고, deferral 은 활성 plugin+MCP 도구 수 ≥ 200(`EAGER_TOOL_EXPOSURE_CEILING`) 일 때만 동작한다. 설치/삭제만 있던 플러그인에 활성/비활성 상태를 도입했고(비활성 플러그인은 로드 유지·모델 노출만 차단·실행은 어댑터에서 fail-closed, sub-agent 경로 포함), 세션 TO-DO 의 no-op 재마킹 루프(이미 in_progress 인 항목 반복 갱신)를 차단하고 같은-메시지 도구 호출 순서를 결정적으로 보장한다.
- **TPM 429 bounded auto-compact 복구** (PR #1178) — provider diagnostics 가 `rate_limit_exceeded` 를 tokens-per-minute(TPM) 실패로 식별하면 대화를 1회 자동 압축해 라운드당 요청 크기를 줄여 복구한다. RPM(요청/분) 한도는 정상 에러 경로를 유지하고, 에러 시리즈당 1회 + clean turn 후에만 re-arm 하는 가드로 반복 429 가 compact 를 증폭하지 못하게 막는다.
- **gpt-5.4-mini TPM-aware preflight** (PR #1174) — `gpt-5.4-mini` 의 `tpmDefault=200K` 를 등록해 preflight 압축 판단이 TPM 한도를 인지하도록 했다.
- **Intra-turn tool-result stubbing** (PR #1172) — tool-call 라운드 사이에 직전 tool result 를 stub 으로 치환해 결과-heavy 턴의 누적 입력 토큰을 줄인다.

### 스트리밍 / 렌더링

- **스트림 종료 후 최종 답변 안정화** (PR #1173) — 스트림 closure 이후 final answer 가 흔들리지 않도록 고정하고, provider stream 실패를 request diagnostics 로 노출한다. 대용량 히스토리에서 streaming 중 render boundary / latency 회귀 가드를 추가했다.

### 개발 도구

- **dev 전용 system-prompt per-source 크기 계측** (PR #1175) — `LVIS_DEV_PROMPT_SOURCE_DUMP` 로 12-source 프롬프트의 소스별 토큰 크기를 측정한다.

### 검증

- PR #1177: 3-agent cluster review GO (architect/critic/security, MAJOR 0), `bun run typecheck`/`build`, plugins/boot 843 + 전체 스위트 6194 pass.
- PR #1178: engine/renderer/coverage multi-agent review, focused Vitest + 470 files / 6200 pass, `bun run typecheck`/`build`, CI CLEAN.

---

## v0.2.10 — 2026-05-25

### 안정성 / 모델 도구 노출

- **Tool-level deferral 기본 경로 정착** (PR #1147) — plugin activation 을 catalog scope 로 유지하고, provider-visible tool schema 는 keyword preload / `tool_search` promotion / carry-forward / 고정 allowlist 로만 노출한다. broad promotion 은 scoring/top-N 으로 제한해 TPM burst 와 불필요한 tool schema 노출을 줄였다.
- **Tool provenance source-aware 정렬** (PR #1153) — `builtin`, `plugin:<id>`, `mcp:<id>` 출처를 ToolRegistry, prompt catalog, execution metadata, IPC, trace/audit, ToolGroupCard UI까지 유지한다. cross-owner tool-name collision 은 fail-closed 처리하고, builtin tool inventory 질문에서는 직전 plugin/MCP carry-forward 를 reset 해 plugin tool 이 builtin 처럼 답변되는 경로를 차단했다.
- **OpenAI/Azure Responses `tool_search` wire alias 정렬** (PR #1149/#1150) — LVIS 내부 `tool_search` 와 provider built-in `tool_search_call` 충돌을 `lvis_tool_search` wire alias 로 분리하고, persisted history / tool result / display text 는 사용자에게 다시 `tool_search` 로 복원한다.

### UX / 컨텍스트

- **Persona prompt store 전환** (PR #1148) — main composer assistant-context 버튼을 Persona 전용으로 정리하고, role/persona prompts 를 file-backed `~/.lvis/prompts/*.md` + seeded resources SOT 로 이동했다.
- **Session TO-DO turn boundary 정렬** (PR #1152) — 세션 TO-DO 를 current-turn transient plan 으로 고정해 새 사용자 턴 시작 시 이전 plan 이 남지 않도록 하고, live push race 와 badge 상태를 정리했다.
- **Chat streaming scroll jitter 수정** (PR #1151) — streaming 중 bottom-follow 를 rAF coalesced immediate pin 으로 통합해 긴 응답에서 smooth scroll 반복으로 viewport 가 흔들리는 문제를 제거했다.

### 컨텍스트 예산 / E2E 안정화

- **Projected next-turn input SOT** (PR #1142/#1143) — context budget ring 과 compact 판단을 next-turn projected input 기준으로 재정렬하고, tool-result carryover / input-output split / TPM banner e2e coverage 를 보강했다.
- **Linux-headless onboarding/e2e 격리 보강** (PR #1143/#1146) — Electron e2e fixture 의 onboarding state, marketplace/update bootstrap, memory seed flow 를 실제 first-boot chain 과 맞췄다.

### 검증

- PR #1153: focused provenance suites, `ToolGroupCard`, `permission-review-scenario-board`, `bun run check:test-quality` 458 files / 6041 pass / 13 skipped with coverage gates, `bun run typecheck`, `bun run build`, remote build-and-test / Windows permission path / CodeQL / naming / cluster success, Copilot inline comments 0.
- PR #1147/#1148/#1149/#1150/#1151/#1152: targeted Vitest/Playwright lanes, typecheck/build, remote CI success.

---

## v0.2.9 — 2026-05-22

### 안정성 / 컨텍스트

- **50-message auto compact 제거** (PR #1097) — auto compact 는 고정 메시지 개수 대신 token pressure 또는 명시적 context-error recovery 로만 동작한다. 불필요한 중간 compact 로 thinking/tool-result 흐름이 끊기는 상황을 줄였다.

### 테스트 / 품질 게이트

- **테스트 helper SOT 정리** (PR #1095) — renderer, plugins, hooks, prompts, permissions, IPC, Vercel LLM adapter, conversation-loop 테스트의 반복 fixture/helper 를 공통 helper 로 이관했다.
- **중복 helper detector 추가** (PR #1095) — AST 기반 `scripts/check-test-duplicates.mjs` 로 test/support 경로의 duplicate helper body, 같은 파일 내부 duplicate, generic `setup`/`fixture`/`mock` substantial body 를 CI에서 검출한다.
- **Coverage area gate 추가** (PR #1095) — `@vitest/coverage-v8` 기반 `scripts/check-test-coverage.mjs` 와 `check:test-quality` 로 total/engine/permissions/plugins/ipc/renderer/main/boot/tools/mcp 영역별 회귀를 잡는다.
- **Coverage wrapper 안정화** (PR #1095) — coverage report 는 임시 디렉터리에서 생성 후 cleanup 하며, Windows 에서 shell 기반 argv handling 없이 `bun.exe` 를 직접 실행한다.

### 검증

- PR #1097: focused Vitest 2 files / 16 pass, `bun run typecheck`, `git diff --check`, remote CI success.
- PR #1095: `bun run check:test-quality` 445 files / 5865 pass / 13 skipped, duplicate scanned files 515 / duplicate helper implementations 0, coverage gates pass, `bun run typecheck`, `bun run build`, remote CI success, inline comments 0.

---

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
