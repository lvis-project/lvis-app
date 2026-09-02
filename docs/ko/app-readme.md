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

## 작업 공간 — 타일로 나뉜 대화

메인 영역은 워크벤치 모델을 따릅니다. 메인 영역은 테두리를 가진 채팅 그룹(이하 타일)으로 나뉘고, 각 타일은 같은 대화를 다시 보여 주는 창이 아니라 그 자체로 하나의 대화입니다. 워크 모드는 타일을 최대 4개까지, 채팅 모드는 정확히 1개를 가집니다. 포커스는 타일의 테두리에 표시하므로 다음 입력이 어느 타일로 들어가는지 한눈에 확인할 수 있습니다.

- **타일 하나가 대화 하나를 가집니다.** 타일마다 자기 대화 루프를 가지므로 여러 타일이 동시에 응답을 스트리밍할 수 있습니다. 하나의 세션은 동시에 한 타일에서만 열립니다. 사이드바에서 이미 열려 있는 대화를 클릭하면 사본을 새로 여는 대신 그 대화를 가진 타일로 포커스를 옮깁니다. 새로 분할한 타일은 활성 프로젝트 아래에서 새 대화를 시작합니다.
- **타일 머리글이 자기 제어를 가집니다.** 머리글 왼쪽에는 대화 제목이, 오른쪽에는 대화 자체에 대한 동작(고정, 내보내기(Markdown 또는 JSON), 가져오기)과 타일 자체의 제어(대화 목록, 채팅 영역 분할, 이 채팅만 보기, 채팅 영역 닫기)가 놓입니다. 영역을 한 번이라도 분할하면 모든 타일을 닫을 수 있고, 마지막 하나만 닫을 수 없습니다.
- **분할 방향을 사용자가 고릅니다.** 분할 제어는 "좌우로 분할"과 "위아래로 분할"을 제시합니다. 나뉜 두 쪽이 최소 크기에 못 미치는 방향은 선택할 수 없는 상태로 표시하고, 두 방향 모두 들어가지 않으면 그 이유를 문장으로 알립니다.
- **작업 패널은 하나의 카드입니다.** 파일, 미리보기, 브라우저, 터미널, 서브에이전트, 사이드 채팅이 타일 높이만큼 서는 카드 하나에 들어갑니다. 타일이 충분히 넓으면 대화 옆에 붙고, 좁으면 대화의 오른쪽 가장자리 위에 떠서 표시됩니다. 머리글의 닫기 단추는 타일을 닫고, 카드 자신의 닫기 단추는 패널을 닫습니다.
- **밀려 들어오는 표면도 타일 하나에 속합니다.** 오버레이 카드, MCP 앱 카드, 질문 카드, 자리 비움 권한 위임, 세션 Tasks는 그 대화를 가진 타일에 붙고, 그 대화를 가진 타일이 없으면 포커스된 타일에 붙습니다. 권한 고지 토스트는 타일마다가 아니라 창마다 한 번 표시됩니다.

이 영역의 설계 문서는 [../design/tiled-chat-groups.md](../design/tiled-chat-groups.md)이며, 그룹 모델·채널 분리·기하 구조의 기준 문서입니다.

## 채팅 UX

**컴포저.** 호스트가 거절한 전송은 조용히 사라지지 않고 사용자에게 보고합니다. 메시지는 첨부와 입력 내용을 유지한 채 컴포저로 되돌아오고, 거절 사유를 함께 표시합니다. 턴이 진행되는 동안 Enter 만 누르면 메시지는 큐에 들어가고, 큐는 진행 중인 턴의 다음 정지 지점에서 전달되며, 턴이 끝날 때까지 남은 항목은 새 메시지로 전송됩니다. Cmd/Ctrl+Enter 는 대신 턴을 중단합니다. 중단은 같은 전송 호출 안에서 처리하므로, 전송을 승인한 키 입력이 그대로 그 전송을 실어 나릅니다. 큐로 들어간 메시지와 중단 후 보낸 메시지는 대화 기록에 그렇게 표시되고, 사용자가 멈춘 답변에는 "사용자가 중지함" 배지가 남습니다.

**메시지 카드.** 사용자가 보낸 메시지 위에 커서를 올리면 편집, 분기, 여기로 되돌아가기 세 가지 동작이 나타납니다. "여기로 되돌아가기"는 그 메시지의 본문을 컴포저로 돌려놓고 그 지점 이후를 모두 버립니다. 대화 기록에서도, 나중에 말하려고 큐에 넣어 둔 메시지에서도, 디스크에 저장된 세션에서도 함께 버립니다. 새 세션으로 분기하는 대신 같은 대화에서 입력을 다시 쓰기 위한 동작입니다. 이 동작은 출력을 생성 중인 턴이 없을 때만 제공하며, 입력을 온전히 되돌려 줄 수 없는 메시지는 대화를 그대로 둔 채 거절합니다. 각 카드 아래에는 전송 시각을 표시합니다. 메시지 단위 고정은 더 이상 제공하지 않으며, 대화 자체의 고정은 타일 머리글과 사이드바 행에서 그대로 사용합니다.

**사이드바.** 대화 행은 이름 변경, 읽지 않음으로 표시, 읽음으로 표시, 보관, 공유, 대화 복사, 삭제를 제공하고, 프로젝트 행은 고정·폴더 열기·제거와 함께 편집과 프로젝트 보관을 제공합니다. 턴이 진행 중인 대화의 행에는 응답 표시가 나타나고, 사용자가 보고 있지 않은 곳에서 턴이 끝나면(포커스되지 않은 타일, 또는 다른 화면에 가려진 타일) 사용자가 그 대화를 볼 때까지 안 읽음으로 표시합니다. 대화 탭의 목록은 남은 개수를 알리는 행으로 끝나지 않고 스크롤에 따라 다음 쪽을 이어서 보여 주며, 프로젝트 탭에서는 그룹마다 자기 단추로 펼치고 접으므로 프로젝트 하나가 길어져도 다른 프로젝트를 화면 밖으로 밀어내지 않습니다.

**작업 패널.** 브라우저 탭은 세션의 도구 활동에서 나온 웹 출처를 도구 입력과 도구 결과 양쪽에서 모아 보여 주고, 각 행에 그 주소를 요청한 것인지 결과에서 받은 것인지 표시합니다. 파일 탭은 세션의 파일을 각 파일에 가해진 동작(읽음, 씀, 첨부, 도구)과 함께 나열합니다. 활동 대시보드의 플러그인·MCP 호출 횟수는 대화 기록에서 복원하므로 세션을 다시 열어도 유지됩니다. 비어 있는 패널에는 머리글의 도구 활동 팝오버와 같은 내용을 표시합니다.

## 플러그인 아키텍처

설치된 플러그인은 `~/.lvis/plugins/<id>/plugin.json`에 위치하며, 활성 목록은 `~/.lvis/plugins/registry.json`가 관리합니다. 메인 앱은 플러그인 구현을 직접 import하지 않고 `PluginRuntime`이 manifest를 읽어 host entry를 동적으로 로드합니다.

더 넓게 보면 `~/.lvis/` 루트에는 여러 도메인에 걸치는 자원(`settings.json`, `audit.log`, `secrets/`)만 두고, 도메인 하나가 소유하는 자료는 모두 `~/.lvis/<feature>/` 아래에 둡니다. 그래야 도메인 하나를 디렉토리 하나 단위로 백업하거나 지울 수 있습니다. 스킬 승인 기록은 `~/.lvis/skills/approvals.json`에서, 고정한 메시지는 `~/.lvis/sessions/starred.json`에서 읽습니다. 이전 버전이 루트에 남긴 파일은 처음 로드할 때 해당 namespace 로 옮깁니다.

플러그인은 capability, method, UI extension, emitted event, subscription, notification event를 manifest에 선언합니다. 메인 프로세스는 IPC를 플러그인 method 호출로 브리지하고, lifecycle은 runtime이 `start`/`stop` 단위로 관리합니다.

플러그인 자신의 시작 실패는 치명적 오류가 아니라 성능 저하로 다룹니다. 인스턴스는 그대로 남고 다른 플러그인의 도구 호출은 계속 동작하며, 실패한 플러그인을 호출하면 매번 실제 사유를 응답합니다. 세션 전체의 도구 호출을 닫는 것은 호스트 자신의 generation fence 가 실패했을 때뿐입니다.

대표 관리형 플러그인:

- `@lvis/plugin-local-indexer`
- `@lvis/plugin-meeting`
- `@lvis/plugin-ms-graph`
- `@lvis/plugin-work-assistant`

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
- 디자인: [../design/README.md](../design/README.md)
- 타일로 나뉜 채팅 그룹: [../design/tiled-chat-groups.md](../design/tiled-chat-groups.md)
- 플러그인 개발: [현재 English guide](../guides/plugin-development.md)
- 프로덕션 릴리스 체크리스트: [../references/production-release-checklist.md](../references/production-release-checklist.md)
