# TODO — 후속 작업 (2026-07-14 갱신)

로컬 main이 origin/main보다 **265커밋 뒤처져** 있었음 → #1662(`bf0d2a03`)로 업데이트 완료. 아래는 그 위에서의 잔여.

공통 제약: 산출물은 **PR로**(main 직접 push 금지, squash 금지). 편집 파일 **LF** 유지(CRLF면 `sed -i 's/\r$//' <file>`). 프레시 워크트리 셋업: `bun install → node scripts/fetch-uv.mjs → bun run build:icons → npm rebuild better-sqlite3`(마지막). pre-push 우회 금지.

---

## ✅ 해소됨 — C1/C2는 이미 main에 머지돼 있었음 (로컬이 stale이었을 뿐)

사용자가 "반영 안 된 것 같다"고 본 두 기능은 **origin/main에 이미 존재**. 로컬 체크아웃이 265커밋 뒤처져 안 보였던 것. #1662 업데이트로 해소.

- **C1 — 키 미입력 창을 컴포저(채팅 입력)로 이동**: `2a403d08 fix(chat): move the no-API-key affordance out of the transcript`. `ComposerApiKeyChip`이 `ChatComposerDock`(컴포저 상단 스트립)에 렌더 — 트랜스크립트 밖, 채팅/프로젝트 영역 옆. 코드 검증 완료.
- **C2 — 채팅완료 노티 포커스-인지**: `5fbff784 feat(ui): add token insights and quiet foreground turn ends`. `notification-service.ts`: 포어그라운드 turn-end → 억제, 아니면 OS `Notification`. `BrowserWindow.getAllWindows().some(isFocused)`로 전 창 포커스 감지. 코드 검증 완료.

---

## #17 후속 — 리뷰어 협상 흐름 (별도 PR)

**목표**: 감사 LLM이 deny하면 → 메인 LLM이 권한상승 요청을 상세 기술 → **사용자 원의도에 부합하는 행위만** 수행, 요청 없던 행위 미수행.
- deny 지점: `src/permissions/permission-manager.ts` `resolveReviewerDecision`의 non-approve 경로 — 구조화된 사유(무엇이 왜 막힘 + 무엇을 승인받아야 하는지) 실어보내기.
- 재요청 루프: `src/tools/executor.ts`(~L1652 `dispatchReviewerForInteractiveAuto`) + `src/tools/pipeline/reviewer-dispatch.ts`. **원의도 anchor**로 스코프 확장 차단, 라운드 상한, 실패 시 사용자 모달 폴백(fail-open 금지).
- 민감영역(permissions/executor) → 3-agent 클러스터 리뷰 + `cluster-review-passed`. 진실표/시나리오 보드 갱신.

---

## #19 후속 — ASRT #1610 나머지 (item 2~4). #1618이 item(1) repair ACL만 완료.

### (2) default-on win32 — **보류 확정(2026-07-14 사용자 결정, flip 안 함)**
리서치 재확인: 브리프의 "shell이 에러난다"는 **stale** — `src/tools/bash.ts`/`powershell.ts`가 `isActiveSandboxShellContained`를 더는 호출 안 하고 `HostShellExecutionPlan`(`src/permissions/host-shell-execution-plan.ts`)으로 리팩터돼 **Windows-partial에서 이미 plain+ask(정직한 `isolation:none`)로 동작**함(`isActiveSandboxShellContained`의 유일 caller는 이제 `src/main/terminal/pty-manager.ts`뿐). 즉 메커니즘은 이미 완성.
- 남은 건 `src/data/settings-store.ts`의 `osToolSandbox` win32 기본값 **flip 뿐**인데, flip하면 srt-win 미프로비저닝 사용자가 **매 bash/powershell 호출마다 승인 모달**(헤드리스는 hard-deny) → 큰 UX 회귀.
- **사용자 결정: 보류 유지(flip 안 함)**. 메커니즘은 완성돼 있어 설정에서 opt-in 가능. 되살릴 때 옵션: (B) windows-partial-shell 폴백에 세션-스코프 정직 승인 추가로 매-호출 마찰 제거(정직성 유지). fail-open 금지, 클러스터 리뷰.

### (3) perMachine 마이그레이션 검증 — 릴리스 전 필수
#1610이 build.nsis `perMachine:false→true`. 기존 per-user 설치→perMachine 자동업뎃 시 orphaned/double install + 매 업뎃 UAC 재승격 위험. 실제 업뎃 런 검증 + 문서화. (CI 불가.)

### (4) 실-Windows end-to-end 검증
provisioning + ACL grant + perMachine 승격 실기 검증(재-UAC 없음, 첫 실행 init, uninstall 정리). CI 불가.

> ASRT는 방금 **0.0.66**으로 업데이트됨(`sandbox-runtime@0.0.66`) — (2)~(4) 착수 시 버전 정합 확인.

---

## ✅ chat-theme 브랜치 — 폐기 권장 (native context menu도 이미 main에 완성됨)

`feat/chat-theme-native-context-menus`는 **265커밋 뒤진 dead 브랜치**. 검증 결과 그 가치는 전부 main에 흡수됨:
- **native context menu = 완성·머지됨**: `fe40ac84`(native ctx menu 커밋)이 origin/main의 조상. 6개 파일(main `native-edit-context-menu.ts`·shared `native-context-menu.ts`/`assistant-context-menu.ts`·훅 `use-native-context-menu.ts`·테스트 2개) + IPC(`src/ipc/domains/ui.ts` `NATIVE_KINDS`/`COMMANDS`/`LABEL` + `lvis:ui:native-context-menu` 채널) 전부 main에 존재. 브랜치 vs main diff = **동일**. main ChatSidePanel은 훅 사용(broken `components/ui/context-menu.js` import는 리팩터 전 stale 잔재, main엔 없음). tsc 클린.
- chat theming / onboarding-chain도 흡수됨.
- 이전 tsc 에러(App/chat/boot/ChatSidePanel)는 전부 **stale 체크아웃 착시** — main에선 없음.

**결론**: 완성/머지할 것 없음. 브랜치는 **폐기 권장**(원격 `feat/chat-theme-native-context-menus` 삭제 — destructive라 사용자 승인 필요). 잔여 2커밋(settings-SOT/onboarding-test)은 `codex/settings-sot-cleanup` 등과 겹치는 것으로 별도 확인.

---

## 기타 미머지 (참고)
origin에 다수 브랜치가 main보다 ahead(대부분 에이전트 WIP): naming-round-2/3, ext-apps-adoption-p0, marketplace-core-slimming, windows-installer-home-selection(#1062 open) 등. 사용자가 콕 집은 C1/C2는 머지 확인됨. 나머지는 개별 지시 시 머지 검토.
