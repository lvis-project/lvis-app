# Blueprints (역사적 Phase 아카이브)

이 디렉토리의 문서는 LVIS 호스트 앱의 **과거 Phase 계획·종결 보고서·설계 제안** 입니다. 파일명에 `phase[N]-` / `autopilot-phase[N]-` / `track-[a|b]-closure-report` 같은 process-derived 접두사가 들어 있지만, 이는 의도된 *역사적 기록* 표기입니다 — 새 식별자 네이밍 룰(`feedback_naming_process_metadata.md`) 의 sweep 대상에서 명시적으로 제외됩니다.

## 현재 아키텍처는 어디에 있나

- 라이브 아키텍처 SOT: [`../architecture/architecture.md`](../architecture/architecture.md) (v4 Final)
- 영역별 설계 문서: [`../architecture/`](../architecture/) (permission-policy-design, plugin-deployment-model, …)
- Reference: [`../references/`](../references/)

## 여기 파일들의 성격

| 패턴 | 의미 |
|------|------|
| `phase[N]-closure-report.md` | 해당 Phase 종료 시점의 결정/배포 상태 동결 기록 |
| `autopilot-phase[N]-*.md` | 자동 실행 sub-system 의 Phase 별 진행 노트 |
| `phase[N]-*-plan.md` | 과거 시점에 잡았던 단계별 실행 계획 — 일부는 그대로, 일부는 후속 PR 로 대체됨 |
| `*-redesign-*.md` / `*-design.md` | 특정 시점의 design 제안 (P-state 명시) |

## 룰 / 가드

- `feedback_naming_process_metadata.md` 의 process-metadata 식별자 sweep 은 **이 디렉토리 제외**.
- `.github/workflows/naming-gate.yml` 의 grep 패턴에서 `docs/blueprints/` 가 명시적으로 skip 됩니다.
- 새 phase-derived 파일을 추가하면 *역사적 기록* 의도가 명확해야 합니다. 살아있는 설계는 `docs/architecture/` 로.

## 인덱스 (작성 시점 순)

기록 순서는 git log 가 SOT. 빠른 lookup 만 제공:

- `autopilot-phase1-indexer.md` — 자동 인덱서 Phase 1 노트
- `phase1.5-closure-report.md`
- `phase2-track-b-closure-report.md`
- `phase2-proper-marketplace-design.md`
- `phase3-folder-refactor-plan.md`
- `agent-hub-implementation-plan.md`
- `composer-redesign-message-queue.md`
- `composer-redesign-mockup.html`
- `openharness-selective-borrow-plan.md`
