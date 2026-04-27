# 로컬 플러그인 개발 Quick Start (마켓플레이스 없이)

> **대상**: 사내 마켓플레이스 카탈로그를 통하지 않고, 로컬 머신에서 LVIS 플러그인을 만들고 호스트(`lvis-app`)에 사이드로드해 즉시 검증하고 싶은 개발자.
>
> **이 문서가 다루는 범위**: 0 → 호스트에서 플러그인 메서드/UI 가 살아 동작하기까지. 매니페스트·HostApi 의 깊은 레퍼런스는 [`plugin-development.md`](./plugin-development.md) 를 참고하세요.

---

## 한 줄 요약

```
lvis-plugin-template clone → bun build → lvis-app 에 manifestPath 등록 → LVIS_DEV=1 LVIS_DEV_SKIP_SIG=1 로 실행
```

마켓플레이스는 production 배포 채널일 뿐이고, **dev 루프는 마켓플레이스 없이 완결**됩니다.

---

## 1. 사전 요구사항

| 도구 | 용도 |
|------|------|
| Node.js ≥ 18 | `lvis-app` 의 Electron launcher 와 postinstall 훅이 시스템 `node` 를 직접 호출 |
| bun (선택) | `lvis-app`/플러그인 기본 패키지 매니저. 없으면 `npm` 폴백(`*:npm` 스크립트) |
| git | submodule 포함 클론 |

LGenie/MS Graph 등 외부 자격증명은 **로컬 dev 에서 필요 없음** — `LVIS_PAGEINDEX_TEST_MODE=1` 처럼 mock 경로가 준비되어 있습니다.

---

## 2. 플러그인 스캐폴드

[`lvis-plugin-template`](https://github.com/lvis-project/lvis-plugin-template) 을 사용합니다.

```bash
# GitHub 에서 "Use this template" 으로 lvis-plugin-<yourname> 생성 후
git clone --recurse-submodules git@github.com:<org>/lvis-plugin-<yourname>.git
cd lvis-plugin-<yourname>

bun install
bun run build         # tsup → dist/ 생성
bun run test          # vitest 스모크
```

submodule 누락 시: `git submodule update --init --recursive`.

이 시점에서 `dist/hostPlugin.js` 와 `plugin.json` 이 준비됩니다. 매니페스트 작성 규칙(필수 필드, AJV 검증 룰, toolSchemas)은 [`plugin-development.md` §2](./plugin-development.md#플러그인-매니페스트-pluginjson) 참고.

---

## 3. lvis-app 에 사이드로드

호스트 앱(`lvis-app`)이 마켓플레이스 catalog 가 아닌 **로컬 registry 파일**(`plugins/registry.json`) 을 통해서도 플러그인을 로드합니다. 두 가지 방법이 있습니다.

### 3-A. CLI 로 등록 (권장)

```bash
cd /path/to/lvis-app

# 절대 경로 또는 상대 경로 모두 OK
bun run plugins:add -- <plugin-id> /abs/path/to/lvis-plugin-<yourname>/plugin.json

# 또는 같은 부모 디렉토리에 둔 경우
bun run plugins:add -- <plugin-id> ../lvis-plugin-<yourname>/plugin.json

bun run plugins:list                       # 확인
bun run plugins:enable -- <plugin-id>      # 비활성 상태로 추가됐다면
```

CLI 가 `plugins/registry.json` 에 `{ id, manifestPath, enabled: true }` 항목을 원자적으로 추가합니다.

### 3-B. registry.json 직접 편집

빠르게 prototyping 할 때:

```json
{
  "version": 1,
  "plugins": [
    { "id": "meeting",   "manifestPath": "plugins/installed/meeting/plugin.json",   "enabled": true },
    { "id": "myplugin",  "manifestPath": "../lvis-plugin-myplugin/plugin.json",     "enabled": true }
  ]
}
```

`manifestPath` 는 **`lvis-app` 디렉토리 기준 상대 경로** 또는 절대 경로. file:// 스킴은 자동 처리됩니다.

### 3-C. UI 에서 설치

`lvis-app` 실행 후 좌측 사이드바 **플러그인 마켓플레이스** 영역의 설치 버튼은 동일한 로컬 등록 경로를 호출합니다(원격 catalog 가 비어있어도 동작).

---

## 4. dev 모드로 실행

```bash
cd /path/to/lvis-app
bun run start
```

`scripts/run-electron.mjs` 가 unpackaged 빌드일 때 다음을 **자동으로** 세팅합니다:

| 환경변수 | 효과 |
|----------|------|
| `LVIS_DEV=1` | 플러그인 루트 경계 검사 완화. `../lvis-plugin-*` 같은 형제 디렉토리 manifest 가 거부되지 않음. |
| `LVIS_DEV_SKIP_SIG=1` | ed25519 서명 검증 skip. 로컬 빌드는 `plugin.json.sig` 가 없으므로 필수. |
| GPU safe-flag (`--disable-gpu` 등) | 사내 VDI/EDR 환경 GPU 크래시 우회. 정상 환경은 `LVIS_KEEP_GPU=1` 로 opt-out. |
| 콘솔 UTF-8 (`chcp 65001`, `PYTHONIOENCODING=utf-8`) | Windows cp949 한글/이모지 깨짐 방지. |

**packaged 빌드(`app.isPackaged`)에서는 자동 off** — 프로덕션 누수 우려 없음.

수동 우회가 필요하면:

```bash
LVIS_DEV=1 LVIS_DEV_SKIP_SIG=1 bun run start
```

bun 이 없는 환경에서는 `npm run start:npm` 또는 PowerShell 에서 `npm run start:win`.

---

## 5. 변경 → 재빌드 → 재로딩 루프

| 변경 위치 | 필요 동작 |
|-----------|-----------|
| 플러그인 `src/**` | 플러그인 디렉토리에서 `bun run build` (또는 `bun run dev` 가 watch 를 제공한다면 그것). lvis-app 재시작은 필요 — 호스트는 시작 시 매니페스트를 1회 로드. |
| 플러그인 `plugin.json` (필드 추가/수정) | 매니페스트 변경은 호스트 재시작 필수 (AJV 재검증). |
| 플러그인 UI (`dist/ui/*.js`) | dynamic import 캐시 때문에 호스트 재시작 권장. |
| `lvis-app/src/**` | `bun run build` + 재시작. |

플러그인 프로젝트에 watch 빌드를 두려면 `tsup --watch` 를 별도 터미널에서 돌리고, `lvis-app` 재시작만 반복하면 됩니다.

---

## 6. 검증 체크리스트

플러그인이 제대로 살아있는지 빠르게 확인:

1. **로드 성공** — 부팅 로그에 `plugin loaded: <id>` 가 보이는지. AJV 실패 시 `manifest validation failed` 로 거부됨.
2. **메서드 호출** — 채팅창에서 `tools[]` 의 도구를 LLM 이 호출하거나, UI 컨트롤(`uiCallable` 에 등록된 도구만)에서 직접 호출.
3. **이벤트** — `plugin.json` 의 `keywords[]`/`eventSubscriptions[]`/`notificationEvents[]` 가 의도대로 트리거되는지.
4. **서명 우회 경고** — 부팅 로그에 `LVIS_DEV_SKIP_SIG=1 — signature verification disabled` 경고가 한 번 출력되어야 정상 (없으면 서명 검증이 켜진 상태에서 실패한 것).

테스트 코드는 호스트 없이도 `vitest` 로 직접 돌릴 수 있고, HostApi mock 패턴은 [`plugin-development.md` §15](./plugin-development.md#테스팅) 참고.

---

## 7. 자주 막히는 곳

| 증상 | 원인/해결 |
|------|-----------|
| `manifest validation failed: ... permissions` | SDK 스키마는 `permissions: string[]` 만 허용. 빈 객체 `{}` 는 거부됨 — `[]` 로. |
| `plugin signature required` 로 로드 거부 | `LVIS_DEV_SKIP_SIG=1` 누락. unpackaged 에서 자동 세팅되지만 packaged 빌드를 dev 환경에서 띄우면 강제됨. |
| `plugin path outside allowed root` | `LVIS_DEV=1` 누락 또는 manifest 경로가 너무 멀리(예: `../../../../`). 형제 디렉토리(`../lvis-plugin-*`)는 dev 모드에서 허용. |
| Windows 에서 `EISDIR` (file:../ 설치 시) | npm 의 file: 링크가 symlink 모드로 동작. `npm install --legacy-peer-deps --install-links=true` 또는 bun 사용. |
| 한글 깨짐 (cp949) | `npm run start:win` (PowerShell launcher) 또는 `chcp 65001` 직접. |
| LVIS catalog 가 비어 보임 | 의도된 동작. dev 환경에서는 marketplace HTTP 호출 실패해도 로컬 registry 는 정상 동작. |

---

## 8. 마켓플레이스로 넘어갈 때

dev 루프가 안정되면 마켓플레이스 흐름까지 검증해야 합니다.

- **로컬 마켓플레이스로 end-to-end 테스트** (zip 패키징 → 서버 publish → 앱에서 install 까지) — [`local-marketplace-testing.md`](./local-marketplace-testing.md). prod 에 올리기 전 한 번은 도세요.
- **prod 카탈로그 publish 절차** (관리형 승인 흐름, 서버 사인키 정책 포함) — [`marketplace-publishing.md`](./marketplace-publishing.md).

---

## 관련 문서

- [`local-marketplace-testing.md`](./local-marketplace-testing.md) — 로컬 마켓플레이스 서버를 띄워 publish/install end-to-end 테스트
- [`plugin-development.md`](./plugin-development.md) — 매니페스트 전체 스키마, HostApi 계약, capabilities, 이벤트, 서명, 테스팅 레퍼런스
- [`windows-setup.md`](./windows-setup.md) — Windows 사내망 first-run 가이드
- [`marketplace-publishing.md`](./marketplace-publishing.md) — 카탈로그 배포 채널 (prod publish 절차)
- [`../architecture/architecture.md` §9](../architecture/architecture.md#9-plugin-system--ui-extension) — 플러그인 시스템 아키텍처
- [`lvis-plugin-template/README.md`](https://github.com/lvis-project/lvis-plugin-template) — 템플릿 레포 사용법
