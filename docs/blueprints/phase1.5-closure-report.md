# LVIS Phase 1.5 — Plugin Deployment Model Closure Report

**Status**: ✅ COMPLETE
**Window**: 2026-04-13 → 2026-04-14 (single session continuation)
**Scope doc**: `docs/architecture/plugin-deployment-model.md` §12
**Working TODO (root, untracked)**: `TODO.md` §16.3–§16.5

---

## 1. Scope Summary (§12 deliverables)

| Item | Status | Evidence |
|---|---|---|
| `DeploymentMode` type + `PluginManifest.deployment` | ✅ | `src/plugin-runtime/types.ts:28-48` |
| `PluginDeploymentGuard` hybrid (path + manifest field) | ✅ | `src/plugin-runtime/deployment-guard.ts` (~130 lines) |
| `canUninstall` / `canDisable` / `canInstall` | ✅ | §13 test requirement full coverage |
| `MarketplaceService.install/uninstall` guard injection | ✅ | `src/plugin-runtime/marketplace.ts:83-88, 107-112` |
| `PluginRuntime.disable(pluginId, actor)` new impl | ✅ | `src/plugin-runtime/runtime.ts:152-190` |
| UI lock display (🔒 + disabled buttons) | ✅ | `src/renderer.tsx:429-440` |
| 3 bundled plugins `deployment: "managed"` | ✅ | installed manifests + marketplace.json catalog + source plugin.json |

**Phase 2 exclusions respected**: policy file, signature verify, managed installer, IT admin API, LightRAG real impl, cloud index real client — all untouched and properly deferred.

---

## 2. Implementation Highlights

### 2.1 Hybrid judgment (default-deny)
`deployment-guard.ts` uses two orthogonal layers that a plugin must pass BOTH:
1. **Path check** — `userInstalledDir` 하위가 아니면 managed. prefix-confusion, traversal 차단.
2. **Manifest field check** — `plugin.json` 의 `deployment === "managed"` 이면 managed.

**Rationale**: registry.json 위변조(path 우회) + manifest.json 위변조(field 우회) 둘 다 막으려면 AND 게이트가 필요. 한 레이어만으로는 bundled plugins(installedDir 내부)과 외부 공격자 경로 둘 다를 커버할 수 없다.

### 2.2 Trust boundary (§7.3)
- `actor` 파라미터는 main process 내부에서만 결정. IPC 핸들러는 절대 actor를 받지 않음.
- `marketplace.install/uninstall`, `runtime.disable`은 literal `"user"` 로 하드코딩.
- `"it-admin"`은 향후 `ManagedPluginInstaller` (Phase 2)에서만 사용.

### 2.3 Registry TOCTOU lock (F-round)
`registry.ts` 에 `withRegistryLock` / `updatePluginRegistry` in-process async mutex 추가. marketplace.install / marketplace.uninstall / runtime.disable 세 경로가 모두 lock 경유. 현재는 single-writer지만 Phase 2에서 `ManagedPolicySync` 백그라운드 sync 도입 시 3-writer 동시성 대비 선제 방어.

### 2.4 fd-based chmod (F-round)
`settings-store.ts` `migrateSecretsMode` 는 `stat→chmod` race를 `fstat+fchmod` 로 대체. 공격자가 stat와 chmod 사이에 symlink로 파일을 바꿔치기 하더라도 fd는 원 inode에 고정되어 race 차단.

### 2.5 Hardcoded SHA256 (F-round)
`scripts/fetch-uv.mjs` 는 uv 0.7.3의 5 플랫폼 archive 해시를 compile-time 상수로 박음. GitHub compromise 시나리오에서도 verified. 새 버전으로 bump 시 side-car 폴백 → fail-closed.

### 2.6 UI lock
`renderer.tsx` 플러그인 카드에 `🔒 + bg-muted/40 + disabled 버튼 + tooltip`. isManaged flag는 main process `list()` 에서 내려오며, UI는 backend 우회 불가 (Electron contextIsolation + 백엔드 재검증).

---

## 3. Multi-Agent Validation Round (Architect + Security + Code-Reviewer)

3 reviewer 병렬 검증, 모두 **APPROVE_WITH_MINOR**.

| Severity | Architect | Security | Code | Total |
|---|---:|---:|---:|---:|
| CRITICAL | 0 | 0 | 0 | **0** |
| HIGH | 1* | 0 | 0 | 1 |
| MED | 2 | 3 | 4 | 9 |
| LOW | 3 | 3 | 3 | 9 |

*Architect HIGH는 "테스트 gap" (코드 결함 아님).

### 주요 발견 요약
- **Sec M1**: `registry.json` write에 lock 부재 → TOCTOU
- **Sec M2**: `stat→chmod` race
- **Sec M3**: Windows `plain:` ACL 부재 (Phase 2 이월)
- **Code MED**: 미사용 `getInstalledDir()`, disable() 직접 테스트 부재, install() 통합 테스트 부재
- **Architect MED**: 백워드 호환 테스트 부재, path check가 Phase 1.5에서 dormant임을 문서화 필요

---

## 4. F-Round Fixes — 9/9

| ID | 대응 | 내용 | 리뷰어 |
|---|---|---|---|
| F1 | Sec M1 + Code MED | `registry.ts` `withRegistryLock` + `updatePluginRegistry` mutex | Security + Code |
| F2 | Sec M2 | fd-based `fchmodSync` in `settings-store` | Security |
| F3 | Code MED | `getInstalledDir()` dead code 제거 | Code |
| F4 | Architect MED | backward-compat 테스트 (legacy manifest 없는 필드) | Architect |
| F5 | Code MED | `PluginRuntime.disable()` 직접 단위 테스트 4건 (`runtime.test.ts`) | Code |
| F6 | Code MED | `marketplace.install()` guard 통합 테스트 4건 (`marketplace-guard.test.ts`) | Code |
| F7 | Code NIT | `fetch-uv.mjs` 미사용 import 정리 | Code |
| F8 | Sec L3 + Code LOW | `readManifestSafe` `console.warn` forensics | Security + Code |
| F10 | Sec L1 | `KNOWN_GOOD_SHA256` 포맷 assertion (regex 전수 검증) | Security |

### Phase 2 이월 (F-round 범위 밖)
- Windows `plain:` prefix refuse (Sec M3) — platform-specific secrets 설계
- `canDisable` 독립화 TODO (Architect LOW) — `lockEnabled` 도입 시
- `isPathUnderUserInstalledDir` symlink `realpath` (Code LOW) — security hardening
- `marketplace.json` signing (Sec L2) — 정책 layer
- `GuardResult` discriminated union refactor (Code LOW) — 타입 polish
- Registry 크로스프로세스 lock — IPC 다중 writer 도입 시

---

## 5. Testing Results

### 5.1 Unit tests (vitest)
**8 suites × 110/110 PASS** (Phase 1 baseline 88 + Phase 1.5 신규 22)

| Suite | Tests | 성격 |
|---|---:|---|
| `python-runtime.test.ts` | 10 | uv bootstrap mocks |
| `hybrid-retriever.test.ts` | 10 | RRF 수학 |
| `cloud-index-adapter.test.ts` | 4 | Mock 어댑터 |
| `idle-scheduler.test.ts` | 20 | 5-state FSM |
| `bash-ast-validator.test.ts` | 36 | 7 deny + 6 allow + warn 모드 |
| `deployment-guard.test.ts` | 14 | **신규** — hybrid 판정 + canInstall + 백워드 compat |
| `runtime.test.ts` | 4 | **신규** — disable() 직접 (F5) |
| `marketplace-guard.test.ts` | 4 | **신규** — install() 통합 (F6) |

### 5.2 TypeScript
`npx tsc --noEmit`: 0 errors.

### 5.3 E2E Physical Subset
`npx tsx lvis-app/scripts/e2e-phase1.ts S2 S5 S6 S7 S8` — **5/5 PASS**:
- S2 Warm boot (.ready sentinel)
- S5 KNOWLEDGE_DEPTH_CAP=3 source 검증
- S6 Idle 5-state FSM
- S7 Hybrid RRF + Mock cloud (k=60)
- S8 Bash AST (9 deny + 4 allow)

### 5.4 E2E Gap (Phase 2 prerequisite)
- **S1 Cold boot**: `__dirname` ESM 버그는 수정됐으나 실제 uv provisioning이 네트워크 + 바이너리 실행을 요구 (이번 세션 범위 밖)
- **S3 / S4**: `/Users/ken/.lvis/runtime/venv/bin/python` 실 binary 부재 — `.ready` sentinel만 있고 venv 콘텐츠가 없음 (Phase 1 mock 테스트의 잔재)

---

## 6. Commit Trail

| Commit | Repo | Summary |
|---|---|---|
| `aa5b3ca` | lvis-plugin-email | 신규 plugin.json manifest |
| `986e16e` | lvis-plugin-pageindex | deployment: managed |
| `db83425` | lvis-plugin-meeting | deployment: managed |
| `19182d9` | lvis-app | 초기 deployment guard + UI lock + python-runtime fix |
| `30b95c4` | lvis-app | closure — canInstall + registry lock + F-round 9개 |

---

## 7. Architectural Decisions Log

### 7.1 왜 `userInstalledDir` 반전 semantic인가?
초기 설계는 `managedPluginsDir` 지정이었지만, dev 모드에서 sibling plugin repos(parent dir 공유)와 `plugins/installed/` (child dir)가 동일 부모를 공유하는 토폴로지 때문에 single-root 포함 판정이 false positive를 낸다. 반전해서 "`userInstalledDir` 하위가 아니면 모두 managed"로 바꾸니 unknown/공격 경로는 자동으로 보호 대상이 되는 default-deny 정책이 성립.

### 7.2 왜 hybrid(path + field) 판정인가?
- 단일 path-only: bundled plugins이 `plugins/installed/` 에 설치되는 marketplace 플로우를 못 잡음
- 단일 field-only: manifest.json 위변조 시 우회 가능
- hybrid: 두 layer를 곱셈으로 결합 → 공격자가 둘 다 뚫어야 함 → 공격 표면 기하급수적 축소

### 7.3 왜 `actor` 기본값 `"user"`인가?
IPC 핸들러에서 actor 파라미터가 누락되더라도 최소 권한(user)으로 떨어지도록. 기본값 `"it-admin"`은 trust boundary 위반의 지름길.

### 7.4 왜 registry lock을 미래 대비로 넣었는가?
현재는 single-writer라 경합 없음. 그러나 Phase 2의 `ManagedPolicySync` 백그라운드 sync는 `install/disable/policy-apply` 3-writer가 동시에 registry.json을 건드린다. 이 시점에 lock을 도입하지 않으면 디버깅 30h+ 급 간헐 race가 된다. 미래의 race를 위한 선방어.

---

## 8. Systemic TODO

### 8.1 root TODO.md 추적 gap
`/Users/ken/workspace/GIT/github/lvis-project/TODO.md` 는 어느 git repo에도 포함되지 않음. 이번 세션의 §15.3 / §16.3 / §16.4 / §16.5 갱신은 working state로만 존재. Phase 2 시작 전에 다음 중 하나:
- (a) TODO.md를 lvis-app/TODO.md로 이관 + CLAUDE.md의 `../TODO.md` 참조 업데이트
- (b) 각 phase 종료 시 snapshot을 blueprint(본 문서 위치)로 committing — 현재 채택
- (c) root를 meta git repo로 승격

현재 선택: (b) — 본 closure report가 Phase 1.5 시점의 committed snapshot.

### 8.2 OpenAI API Key 노출
본 세션 중 실 OpenAI API 키가 chat으로 평문 공유되었음. 사용자는 즉시 rotate 필요. 어떤 committed file에도 키는 포함되지 않음 (env 변수로만 전달).

### 8.3 Physical E2E cold boot 공백
`.ready` sentinel이 stale (이전 세션 mock 테스트의 잔재) — 실제 venv 바이너리는 부재. S1 cold boot physical run을 한 번 완주하면 S3/S4까지 자동 해결. 우회: `rm -rf ~/.lvis/runtime && npx tsx lvis-app/scripts/e2e-phase1.ts S1`.

### 8.4 Corporate TLS Interception (added 2026-04-14)
사용자 실행 점검 중 meeting STT가 `SELF_SIGNED_CERT_IN_CHAIN`으로 실패. LG 사내망의 self-signed CA MITM이 원인. **dev bypass(D+E)를 `main.ts` 의 `if (!app.isPackaged)` 가드로 임시 적용** — `NODE_TLS_REJECT_UNAUTHORIZED=0` + Chromium `--ignore-certificate-errors`. **packaged build에는 자동 미적용**이므로 production 진입 전 정식 구현 필수.

정식 대응: **Option B (OS keystore 런타임 추출, `mac-ca`/`win-ca`)** 권장. 상세 작업 + 체크리스트 + 보안 게이트는 `TODO.md §17` 참조. main.ts:30-44 에 inline TODO 마커 존재.

### 8.5 Integration Fix Round — Physical Cold Boot (2026-04-14)

F-round(§4) 완료 후 사용자 실 Electron 실행 점검 중 **8개 layer에 걸친 integration 결함**이 누적 발견. root cause는 **Phase 1이 mock 88건 + mocked e2e-phase1.ts로만 검증되고 physical cold boot이 한 번도 완주되지 않았기 때문**. mock은 boundary 양쪽이 동일 가정을 공유한 채 격리 검증되므로 boundary mismatch 감지 불가.

**Layer별 fix 요약** (`TODO.md §18` 참조):

1. **IPC handler race** (main.ts `ab5aa80`) — `createWindow()`→`loadFile`가 `bootstrap()`→`registerIpcHandlers()` 이전. splash data: URL로 해소.
2. **Corporate TLS interception** (main.ts `5414840`) — `!app.isPackaged` 가드로 dev-only bypass.
3. **uv binary dev/prod path** (python-runtime.ts `be4041d`) — `process.defaultApp ‖ !process.resourcesPath` 분기.
4. **uv pip sync `--frozen` 제거** (`be4041d`) — uv 0.7.x 호환.
5. **Lock 파일 transitive deps + pin 충돌** (`a2c852e`) — `uv pip compile` 재생성 (271 lines, pins 해소).
6. **pageindex plugin id mismatch** (boot.ts `be4041d`) — `pageindex` / `lvis-plugin-pageindex` 양쪽 키 configOverrides 주입.
7. **kiwipiepy 0.23 모델 호환** (korean_tokenizer.py `a2c852e`) — `OSError` fallback to default.
8. **workerClient endpoint drift** (pageIndexPlugin.ts `a2c852e`) — 5 HTTP 메서드를 `workerClient` delegation thin wrapper로 통합. `indexDocument /index` (404) → `reindex`로 위임. **single source of truth 확립**.

**Bonus fix**:
- **422 validator**: allowedRoots host 주입 + persistedFolders 사전 로드
- **500 health timeout**: 3-layer lazy fix (eager dimensions 제거 + embed_corpus try/except + SearchService None)
- **HF SSL fail**: spawn env `PYTHONHTTPSVERIFY=0 + HF_HUB_DISABLE_TELEMETRY=1` dev-only

**Architectural 결정 — RAG 외부 API 의존성 제거** (`a2c852e`):
사용자 질문 "RAG에 API가 필요한가?" — **정답: 필요 없음**. Phase 2 계획이던 local embedding을 Phase 1.5로 앞당김. `paraphrase-multilingual-MiniLM-L12-v2` (384-dim, 117 MB, 한국어 + 50개) 기본값. `create_embedding_client(provider=...)` factory로 local/openai 분기. Graceful BM25-only degrade로 HF 차단 환경에서도 plugin이 boot 성공.

**Physical 검증 결과**:
- Before: `boot: ready (15 tools, 2 plugins)` — pageindex load fail
- After: **`boot: ready (21 tools, 3 plugins)`** — pageindex 정상 등록, fixtures + Downloads PDF 인덱싱 (BM25 + FTS5 + kiwi)
- vitest 110/110, TSC 0 errors, 회귀 0

**한계 (Phase 2 이월)**: 사내망 HF 다운로드 차단으로 vector layer 비활성 (BM25-only). 사외망 1회 cold boot으로 모델 영구 cache → 이후 사내망에서도 vector 활성. Phase 2에서 HF mirror 또는 pre-baked tarball 방식 IT 협의 필요.

---

## 9. References

- `docs/architecture/plugin-deployment-model.md` — 설계 명세 (§12 Phase 1.5 roadmap)
- `docs/architecture/architecture.md` §9.6 — 상위 아키텍처 요약
- `docs/blueprints/autopilot-phase1-indexer.md` — Phase 1 closure report
- `TODO.md` (root, 추적 안 됨) §16 — working state
- 커밋: `aa5b3ca`, `986e16e`, `db83425`, `19182d9`, `30b95c4`

---

**작성자**: Claude Opus 4.6 (LVIS 오토파일럿 세션)
**작성일**: 2026-04-14 KST
**다음 단계**: Phase 2 — IT Admin API 연동 (policy sync, managed installer). `§16.2` 5 결정 항목 IT 부서 협의 선행 필요.
