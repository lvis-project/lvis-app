# lvis-app (test host)
`lvis` 메인 패키지가 아직 없는 상태에서 플러그인 통합을 검증하기 위한 테스트용 Electron 호스트입니다.

## 포함 내용
- Plugin Runtime + Manifest 기반 동적 로딩
- `plugins/registry.json` 기반 manifestPath 동적 로딩
- `@lvis/plugin-pageindex`, `@lvis/plugin-meeting`, `@lvis/plugin-email`, `@lvis/plugin-calendar` 동적 통합
- 앱 시작 시 PageIndex 워커 + 자동 인덱서 구동
- 실제 채팅 UI(렌더러) + preload IPC 브리지
- IPC 핸들러
  - `lvis:index:scan`
  - `lvis:index:documents`
  - `lvis:chat:preview`
  - `lvis:meeting:start`
  - `lvis:meeting:push-chunk`
  - `lvis:meeting:stop`
  - `lvis:meeting:transcript`
- E2E 플로우 스모크 테스트 스크립트

## 동적 플러그인 매니페스트
- `plugins/installed/pageindex/plugin.json`
- `plugins/installed/meeting/plugin.json`
- `plugins/installed/email/plugin.json`
- `plugins/installed/calendar/plugin.json`
- `plugins/registry.json` (활성 플러그인 목록)

## Plugins Registry CLI
```bash
npm run plugins:list
npm run plugins:install -- <plugin-id>
npm run plugins:add -- <plugin-id> <manifest-path>
npm run plugins:remove -- <plugin-id>
npm run plugins:enable -- <plugin-id>
npm run plugins:disable -- <plugin-id>
```

예시:
```bash
npm run plugins:install -- meeting
npm run plugins:add -- search search/plugin.json
```

Electron 앱 좌측 사이드바의 **플러그인 마켓플레이스** 영역에서 설치 버튼을 눌러도 동일하게 로컬 설치/등록이 수행됩니다.  
설치된 플러그인이 `plugin.json`의 `ui` 확장을 제공하면, 메인 패널 상단 탭(및 앱 메뉴바)에서 선택해 해당 플러그인 UI를 열 수 있습니다.
탭/메뉴 라벨은 `ui.displayName`을 우선 사용하고, 없으면 `title`을 사용합니다.
`kind: "embedded-module"` 확장은 플러그인 패키지 내부 UI 모듈(예: `dist/ui/meeting-control.js`)을 호스트가 동적 import하여 인라인으로 마운트합니다.
UI 렌더링 책임은 호스트(`lvis-app` renderer)에 있으며, 플러그인은 `plugin.json`의 `ui` 메타데이터와 실제 UI 모듈 자산, 그리고 기능 메서드를 제공합니다.

## 독립 플러그인 아키텍처
- 메인 앱은 플러그인 구현을 직접 import하지 않고 `PluginRuntime`이 매니페스트를 읽어 런타임 동적 로드합니다.
- 각 플러그인은 자체 host entry(`host-plugin`)를 제공하고, 메서드 단위(`index_scan`, `meeting_start` 등)로 기능을 노출합니다.
- 메인 프로세스는 IPC를 플러그인 메서드 호출로 브리지하며, 플러그인 추가/교체 시 매니페스트 변경만으로 확장 가능합니다.
- 라이프사이클(`start`/`stop`)은 runtime이 일괄 관리합니다.

## 설치
```bash
npm install
```

## 테스트
```bash
npm run test:electron-smoke
npm run test:plugin-flow
npm run test:meeting-flow
npm run test:main-flow
```

## 실행
```bash
# 실제 PageIndex 모드 (설치/키 필요)
# PAGEINDEX_ROOT=/absolute/path/to/PageIndex OPENAI_API_KEY=... npm run start

# 테스트 모드(기본): 외부 LLM 없이 로컬 Markdown 기준 검증
LVIS_PAGEINDEX_TEST_MODE=1 npm run start
```
