# Multi-Worker Discipline — 멀티 워커 환경에서 main 을 안전하게 유지하는 4가지 룰

> 같은 파일을 안 건드려도 *semantic* regression 으로 main 이 깨지는 사례가 누적되고 있다.
> 본 문서는 lvis-app 팀이 합의한 4가지 핵심 룰과, 머지 전·후 플레이북을 정리한다.

## 1. 배경 — 왜 이 룰이 필요한가

여러 작업자(사람 + Claude Code 에이전트)가 동시에 PR 을 펼치는 환경에서는,
git 의 textual conflict 만으로는 잡히지 않는 *의미적 충돌* 이 자주 발생한다.
실제로 최근 두 건의 사례가 본 룰의 동기가 되었다.

### 사례 1 — PR #475 (schema SoT 이동) 머지 후 main 이 9개 테스트 fail

`refactor(schema): SDK as SoT — drop host schema` PR 이 host 의 `schemas/plugin.schema.json`
을 지우고 `@lvis/plugin-sdk/schemas/plugin-manifest.schema.json` 으로 이전했다.
SDK 스키마는 JSON Schema **draft 2020-12** 를 쓰는데, host 의 `manifest-validation.ts`
는 default `new Ajv()` (draft-07 만 지원) 를 그대로 사용 → `no schema with key
"draft/2020-12/schema"` 로 9개 테스트 fail. `KNOWN_CAPABILITIES` TS const 도 새 schema
enum 과 drift. 같은 시기 PR #473 (stacked chat view), #487 (dev-link purge), #482
(security harden) 등이 병렬 머지 중이었고, 각자 본인 분기 시점의 main 에서는 CI pass
했지만 머지된 결과 main 이 빨간 채로 남았다. 다음 작업자(예: chip race fix) 가
push 시도 → pre-push hook 에서 9개 fail 로 막힘 → 자기 work 이 무관한 issue 로 블록.

### 사례 2 — PR #476 (composer marker sync) 머지 후 attachments chip 미표시 race

PR #476 머지 후 attachments chip 이 안 뜨는 회귀가 발생했다. 원인은
`Composer.tsx` 의 marker-sync useEffect — state-A(markers)와 state-B(attachments)를
비교해 한쪽을 cleanup 하는 패턴인데, 두 state 를 같이 업데이트하는 코드 경로 중
한 곳이 `flushSync(() => setA(...)); B(...);` 로 분리되어 있었다. flushSync 가 A
commit 직후 sync 렌더 + useEffect 를 실행시키고, useEffect 는 *A 만 본 상태* 에서
B 가 비어있다고 판단 → A wiped. 정답은 한 commit 안에서 batch:
`flushSync(() => { setA(...); B(...); });`. 텍스트 conflict 도 없고 단위 테스트도
통과했지만, 두 state 의 commit 시점 race 라는 의미적 결함이 production 까지 흘러갔다.

두 사례 모두 공통 — **변경의 표면(diff)** 만 보면 안전해 보였지만, **다른 PR/코드/repo
와의 의미적 연결** 을 sweep 하지 않아서 깨졌다. 아래 4가지 룰은 각 표면에서의 방어책이다.

## 2. 4가지 핵심 룰

### 2.1 Main 항상 green — branch protection + post-merge smoke + rebase-then-merge

**Why**: main 이 한 번이라도 빨간 채 머지되면, 다른 작업자의 무관한 PR 들이
pre-push hook / CI 에서 줄줄이 막힌다. 책임은 마지막 머지자에게 있고,
즉시 revert 하지 않으면 모든 worker 의 work 가 정체된다.

**How to apply**:
- GitHub repo settings → Branches → main 에 **"Require branches to be up to date
  before merging"** 체크. 최신 main 으로 rebase 한 PR 만 머지 가능.
- CI workflow 에 **main push trigger 의 full smoke test** 추가
  (`.github/workflows/main-smoke.yml`). 머지 직후 main 이 빨갛게 되면 자동 알림.
- 깨진 main 감지 시 **즉시 revert PR 발행** (책임자 = 마지막 머지자). 후속 fix 는
  별도 PR 로. 깨진 채 다른 PR 머지 금지.
- 작업 시작 전 `lvis-repos-sync` (모든 lvis-* repo pull) + smoke 한 번. 깨진
  main 위에서 새 work 시작하지 말 것.

### 2.2 SoT 이동은 한 PR 안에서 sweep — validator + 파생 const + 테스트 fixture lockstep

**Why**: Source-of-Truth 위치가 바뀌면 (host → SDK, JSON → TS, 한 파일 → 다른 파일)
**downstream consumer 들이 자동으로 따라오지 않는다**. validator 의 parser 버전,
파생 TS const, 테스트 fixture, 문서 — 한 곳이라도 stale 로 남으면 silent regression.
사례 1 의 AJV draft 누락이 정확히 이 패턴.

**How to apply** — SoT 이동 PR 작성 시 자기 점검 체크리스트:
1. **Format compatibility** — 새 SoT 의 spec/format 이 모든 reader 에 지원되는가?
   JSON Schema draft 변경? → `new Ajv2020()` 으로 교체. 타입 위치 이동? → TS
   path mapping / re-export.
2. **Derived constants re-derivation** — 새 SoT 에서 파생되는 TS const
   (`KNOWN_*`, `*_ENUM` 등) 모두 갱신. sync 테스트 (`schema.enum === KNOWN_X`) 추가.
3. **Test fixtures migration** — `grep -rn "<old path>" src/ test/` 로 잔존 참조 0건.
4. **Self-check before commit** — `bun run test` 전체 pass 필수. `--no-verify` 금지.
5. **Sweep dependent repos** (host-plugin-contract-sync 룰 연계) — host ↔ SDK ↔
   plugin repos 가 모두 새 SoT 를 일관되게 보는지 확인.

**적용 대상**: schema, type 정의, enum/capability 리스트, 권한/policy SoT,
이벤트 카탈로그 등 contract artifact 의 위치/포맷이 이동하는 모든 PR.

### 2.3 State-A ↔ B sync race 는 한 flushSync — derived-state cleanup useEffect 방어

**Why**: useEffect 가 state-A 와 state-B 를 비교해 한쪽을 cleanup 하는 패턴이 있다면,
A 와 B 를 같이 업데이트하는 **모든 코드 경로** 는 반드시 한 render commit 안에서
batch 되어야 한다. 사례 2 의 chip race 가 이 패턴.

**Anti-pattern**:
```ts
flushSync(() => setA(newA));
B(newB); // ← A commit 직후 useEffect 가 먼저 실행되어, B 가 stale 인 채 A 만 보고 cleanup → A wiped
```

**Correct**:
```ts
flushSync(() => {
  setA(newA);
  B(newB); // ← 같은 commit 에 묶임
});
```

**How to apply**:
- "state-A 와 state-B 를 cross-reference 하는 useEffect" 가 있으면 — 그 두 state 를
  같이 쓰는 **모든** call site 를 grep 으로 찾아 한 batch 인지 확인.
- React 18+ 에서 자동 batching 이 일반 이벤트 핸들러에선 동작하지만, `flushSync`
  나 `setTimeout`, async 경계에서는 깨진다. 이 경계에서는 명시적으로 한 함수 안에
  넣을 것.
- useEffect 가 derived-state cleanup 을 한다면 — 코드에 **명시적 주석** 으로
  "A 와 B 는 한 commit 에서 같이 업데이트되어야 함" 표시.
- 회귀 테스트 — 두 state 의 분리된 업데이트가 실제 race 를 일으키는 e2e 시나리오
  추가 (단위 테스트로는 commit timing 을 잡기 어렵다).

### 2.4 Cross-repo contract sync — host ↔ SDK ↔ plugin repos 같은 세션에서 sweep

**Why**: LVIS 의 plugin contract 는 5개 repo (`lvis-app`, `lvis-plugin-sdk`,
6개 `lvis-plugin-*`, `lvis-plugin-template`, `lvis-marketplace`) 에 걸쳐 있다.
한 곳만 바꾸고 나머지를 stale 로 두면, 사이드바 탭 미등록 / `bridge.callPluginMethod
is not a function` / loose vs strict regex 분기 등 silent regression 이 누적된다.

**How to apply**:
- 변경 surface 가 다음 중 하나라면 cross-repo sweep 의무:
  - plugin manifest schema (SDK schema + host validator + plugin/template plugin.json)
  - plugin webview bridge / host API (host preload + 6 plugin repos src/)
  - publish workflow contract (template + 6 plugin repos publish.yml + marketplace API)
  - install policy / capability / pluginAccess / event names
  - shared regex / shared constants (예: `STABLE_SEMVER_RE` — 4곳 동시)
- 작업 시작 시 sweep 명령 (search-first, code-second):
  ```bash
  grep -rn "<deprecated-symbol>" \
    /Users/megankim/Documents/lvis-project/lvis-app/src \
    /Users/megankim/Documents/lvis-project/lvis-plugin-sdk/{src,schemas} \
    /Users/megankim/Documents/lvis-project/lvis-plugin-*/{src,.github} \
    /Users/megankim/Documents/lvis-project/lvis-plugin-template \
    /Users/megankim/Documents/lvis-project/lvis-marketplace
  ```
- 발견된 모든 사용처에 대해 같은 세션 안에 PR 펼침. PR description 에
  "Companion PRs" 섹션으로 묶어 머지 순서 의존성 명시 (예: SDK → host → template).
- 4-에이전트 셀프리뷰 시 plugin-auditor / architect 에게 "다른 repo 에 누락된 곳
  grep 으로 확인" 명시. 단일 PR diff 만으로는 cross-repo 누락 못 잡는다.

## 3. 머지 직전 체크리스트

PR 머지 버튼을 누르기 직전, 작성자가 본인 PR 에 대해 다음을 확인:

- [ ] 최신 main 에 rebase 했고, rebase 후 CI 가 다시 green 인가?
- [ ] `bun run test` 전체 로컬에서 pass 하는가? (`--no-verify` 우회 금지)
- [ ] SoT/contract 변경이라면 — validator + 파생 const + 테스트 fixture 모두
      같은 PR 안에 있는가? (`grep -rn "<old>"` 0건)
- [ ] cross-repo dependency (host ↔ SDK ↔ plugin repos) 가 영향받는다면
      companion PR 들이 같은 세션 안에 펼쳐져 있는가? PR description 에 명시?
- [ ] state-A ↔ B 를 같이 다루는 useEffect 가 있는 영역을 건드렸다면 —
      모든 call site 가 같은 batch (한 flushSync 또는 React 자동 batching) 안인가?
- [ ] UI/렌더러 변경이면 Playwright e2e 가 green 인가? (CLAUDE.md
      "Playwright Verification" 룰)
- [ ] 셀프리뷰 (4-에이전트: static / security / plugin-audit / architect) 통과?

## 4. 깨졌을 때 플레이북

main 이 빨갛게 되면 — **모든 worker 의 다음 push 가 막히므로 SEV-1 로 처리**.

1. **즉시 revert PR 발행** — `gh pr revert <SHA>` 로 머지 commit 을 되돌리는 PR.
   책임자 = 마지막 머지자 (본인 PR 이 직접 원인이 아니더라도, 머지 시점에 본인이
   green 을 깨뜨린 거라면 본인이 revert 책임). revert PR 은 review 1명 + admin
   merge 로 fast-track.
2. **다른 worker 들에게 즉시 알림** — Slack 채널 / GitHub issue 코멘트로
   "main red — revert PR #XXX 진행 중, 새 push 보류" 공지. 진행 중인 PR 들이
   stale rebase 로 시간 낭비하지 않도록.
3. **후속 fix PR** — revert 머지 후, 원래 변경을 *제대로* 적용하는 fix PR 작성.
   이번엔 위 4가지 룰 + 체크리스트 전체 통과해야만 머지.
4. **Post-mortem 메모** — 같은 패턴으로 또 깨지지 않도록, `MEMORY.md` 또는
   본 문서에 사례 추가. 룰이 부족하면 새 룰 추가.
5. **CI 추가 방어선 검토** — 같은 회귀를 자동으로 잡을 수 있는 테스트/lint 규칙이
   있다면 즉시 추가 (예: schema enum sync 테스트, useEffect derived-state lint rule).

---

**연계 룰**: `no-verify-bypass`, `pr-pre-checks`, `pr-review-process`,
`host-plugin-contract-sync`, `worktree-cleanup`. 모두 같은 목표 — main green +
silent regression 방지 — 의 다른 측면.
