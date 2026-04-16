# 플러그인 역참조 제거 마이그레이션 계획

> 상태: 적용 시작 (2026-04-17)
> 범위: lvis-app host, installed plugin manifests

## 목표

- 호스트가 특정 플러그인 id/메서드 이름을 직접 참조하지 않도록 구조를 전환한다.
- 플러그인 설치/교체 시 호스트 코드 수정 없이 manifest 선언만으로 통합되도록 만든다.
- 플러그인 개발자가 문서화된 계약(capabilities/startupMethods/eventSubscriptions/ipcBindings)만 지키면 통합이 완료되게 한다.

## Phase 1 (완료): 선언형 계약 도입 + 하드코딩 축소

1. PluginManifest 확장
- `capabilities`
- `startupMethods`
- `eventSubscriptions`
- `ipcBindings`

2. PluginRuntime 확장
- `getPluginManifest(pluginId)`
- `listPluginManifests()`
- `findPluginIdByCapability(capability)`
- `listPluginIdsByCapability(capability)`
- `listIpcBindings()`

3. boot.ts 전환
- python path를 특정 plugin id가 아닌 `configOverrides["*"]`로 주입
- watcher 자동 시작을 `startupMethods` 기반으로 실행
- proactive 이벤트 수집을 `eventSubscriptions` 기반으로 등록
- worker-client plugin 조회를 capability 기반으로 변경

4. ipc-bridge.ts 전환
- `lvis:index:*`, `lvis:meeting:*` 하드코딩 핸들러 제거
- `ipcBindings`를 읽어 채널/메서드 동적 등록

## Phase 2 (권장): 호스트-플러그인 계약 고도화

1. capability taxonomy 표준화
- 공통 capability 목록을 문서화하고 네이밍 규칙 고정
- 예: `worker-client`, `background-watcher`, `calendar-source`, `mail-source`

2. typed contracts 도입
- capability별 반환 shape를 명시한 계약 타입 추가
- 예: worker-client provider contract, scheduler-consumer contract

3. 검증 강화
- manifest lint 단계에서 capability/contract 필수 조합 검증
- CI에서 `startupMethods in methods[]`/`ipcBindings.method in methods[]` 위반 차단

## Phase 3 (권장): 레거시 IPC 축소

1. renderer에서 `callPluginMethod()` 기본 경로 사용 확대
2. legacy channel(`lvis:meeting:*`, `lvis:index:*`) 의존 UI를 단계적으로 제거
3. 사용량 telemetry를 보고 사용이 0이면 legacy `ipcBindings` 제거

## 플러그인 개발자 가이드라인

1. 새 플러그인은 반드시 capability를 선언한다.
2. 앱 부팅 시 동작이 필요하면 startupMethods에만 선언하고, 호스트 코드 수정 요청을 하지 않는다.
3. 이벤트 연동은 eventSubscriptions를 통해 명시한다.
4. 레거시 IPC가 필요한 경우 ipcBindings로만 선언한다.
5. tool name은 underscore 규칙을 지키고, manifest와 runtime handler를 일치시킨다.

## 완료 조건

1. 새로운 플러그인 추가 시 host 코드 변경 없이 manifest만으로 동작한다.
2. plugin id 변경 시 host 코드 변경이 필요 없다.
3. `boot.ts`, `ipc-bridge.ts`에 plugin-specific method literal이 신규로 추가되지 않는다.
