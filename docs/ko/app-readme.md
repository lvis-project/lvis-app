# lvis-app

LVIS App은 채팅, 워크 모드, 도구 호출, 플러그인, 로컬 상태, 권한 흐름을 하나의 데스크톱 환경에 통합하는 Electron 기반 에이전트 워크스페이스입니다. Manifest 기반 플러그인 런타임, 관리형 마켓플레이스 설치, 로컬/클라우드 검색, 회의·업무 보조 플로우, OS별 installer 빌드 파이프라인을 이 저장소에서 관리합니다.

영문 README: [../../README.md](../../README.md)

## 포함 내용

- Electron main/renderer/preload/plugin-preload 번들.
- 실제 채팅 UI, 세션 resume/fork/branch/export/compact, inline `ask_user_question` 카드.
- `~/.lvis/plugins/registry.json` 기반 Manifest 동적 플러그인 로딩.
- 관리형 마켓플레이스 플러그인 자동 install/refresh.
- Local Indexer BM25/vector 결과와 cloud adapter 결과를 RRF로 융합하는 host-side retrieval.
- 플러그인 UI 호스팅, IPC 브리지, 이벤트 계약, OS 알림, overlay trigger surface.
- macOS Apple Silicon, Linux, Windows installer 빌드 스크립트와 GitHub Actions workflow.

## 플러그인 아키텍처

설치된 플러그인은 `~/.lvis/plugins/<id>/plugin.json`에 위치하며, 활성 목록은 `~/.lvis/plugins/registry.json`가 관리합니다. 메인 앱은 플러그인 구현을 직접 import하지 않고 `PluginRuntime`이 manifest를 읽어 host entry를 동적으로 로드합니다.

플러그인은 capability, method, UI extension, emitted event, subscription, notification event를 manifest에 선언합니다. 메인 프로세스는 IPC를 플러그인 method 호출로 브리지하고, lifecycle은 runtime이 `start`/`stop` 단위로 관리합니다.

대표 관리형 플러그인:

- `@lvis/plugin-local-indexer`
- `@lvis/plugin-meeting`
- `@lvis/plugin-ms-graph`
- `@lvis/plugin-work-assistant`
- `@lvis/plugin-agent-hub`

## 개발 환경

필수:

- Bun
- Node.js `>=22.4`
- git submodule (`packages/plugin-sdk`)

```bash
git clone <repo-url>
cd lvis-app
bun install
```

Bun이 기본 패키지 매니저이지만, Electron 실행과 postinstall/build 스크립트 일부는 시스템 `node` CLI를 직접 호출합니다.

## 주요 명령

```bash
# 개발 루프
bun run dev

# 빌드 후 Electron 실행
bun run start

# 타입 검사
bun run typecheck

# 단위 테스트
bun run test

# 앱 빌드
bun run build

# 현재 OS installer
bun run dist
```

## 플러그인 Registry 조회 CLI

Registry CLI는 실행 중인 호스트의 live state와 durable state가 어긋나지 않도록 조회 전용입니다. 설치와 상태 변경은 마켓플레이스 카드, `lvis://install/<slug>` 딥링크, 또는 호스트 설정을 사용합니다. 로컬 개발에서는 unpackaged 앱을 실행하고 **Settings → Plugin Config → 개발자 도구 → 로컬 폴더에서 설치**에서 `plugin.json`이 포함된 빌드 폴더를 선택합니다.

```bash
bun run plugins:list
```

## Windows 개발 메모

`scripts/run-electron.mjs`는 Windows 개발 실행 시 로컬 Electron CLI 사용, GPU safe flag 주입, UTF-8 환경변수 기본값 설정을 처리합니다. PowerShell에서 한글 출력이 깨지면 다음을 먼저 실행합니다.

```powershell
chcp 65001
bun run start
```

자세한 내용은 [Windows setup guide](../guides/windows-setup.md)를 참고하세요.

## 더 읽기

- 한국어 문서 허브: [README.md](./README.md)
- 아키텍처: [../architecture/README.md](../architecture/README.md)
- 플러그인 개발: [../guides/plugin-development.md](../guides/plugin-development.md)
- 프로덕션 릴리스 체크리스트: [../references/production-release-checklist.md](../references/production-release-checklist.md)
