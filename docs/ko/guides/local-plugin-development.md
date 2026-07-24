# 마켓플레이스 없이 플러그인 다루기 (dev / prod)

> **대상**: `lvis-marketplace` 카탈로그를 거치지 않고 lvis-app 에 플러그인을 직접 등록하고 싶은 개발자/관리자.
>
> **이 문서가 다루는 범위**: 마켓플레이스 우회 시나리오 — dev 빌드에서의 빠른 prototyping 과 packaged(prod) 빌드에서의 사이드로드 가능 여부. **이 경로는 제한적입니다** (§3, §4 참고). 일상적 dev 루프는 [`local-marketplace-testing.md`](./local-marketplace-testing.md) (로컬 마켓플레이스 서버) 가 권장됩니다 — 사이드로드 형제-레포 manifest 는 호스트 trust-root 검사에서 거부됩니다.

---

## ⚡ 빠른 시작 (TL;DR)

**A. dev 빌드에서 로컬 빌드 폴더 설치**

```bash
cd /path/to/plugin-repo
bun run build
cd /path/to/lvis-app
bun run dev
```

앱에서 Settings → Plugin Config → 하단 amber **"개발자 도구"** → **"로컬 폴더에서 설치"**를 누르고 `plugin.json`과 `dist/`가 들어있는 빌드 디렉토리를 선택합니다. 설치와 registry 갱신은 실행 중인 호스트가 처리하고 플러그인을 자동 재시작합니다.

> 호스트의 `bun run dev:link`와 mutation CLI는 제거되었습니다. 정식 설치는 marketplace를, 로컬 개발은 위 Settings 흐름을 사용합니다.

**C. 기존 dev 환경에서 새 단일 루트로 마이그레이션** → §7 참고

**D. packaged 빌드 sideload?** → **지원 안 됨**. 정식 마켓플레이스 publish 만 ([`marketplace-publishing.md`](./marketplace-publishing.md))

상세 절차/제한/트러블슈팅은 §3-7 참고.

---

## 4-quadrant 매트릭스

| | 마켓플레이스 있이 | 마켓플레이스 없이 |
|--|--|--|
| **dev** (unpackaged 빌드) | [local-marketplace-testing.md](./local-marketplace-testing.md) — git-based 부트스트랩 자동 publish (**권장 dev 루프**) | §3 — Settings에서 로컬 빌드 폴더 설치 |
| **prod** (packaged 빌드) | [marketplace-publishing.md](./marketplace-publishing.md) — 정식 publish 채널 | §4 — 비공식 channel 없음 |

이 가이드는 **오른쪽 열** (마켓플레이스 없이) 만 다룹니다.

---

## 1. 사전 요구사항

| 도구 | 용도 |
|------|------|
| Node.js ≥ 18 | `lvis-app` Electron launcher + `postinstall` 훅이 시스템 `node` 직접 호출 |
| bun (선택) | `lvis-app`/플러그인 기본 패키지 매니저. 없으면 `npm` 폴백 (`*:npm` 스크립트) |
| git | 플러그인 레포 클론 + submodule (`@lvis/plugin-sdk`) |

---

## 2. 플러그인 스캐폴드

[`lvis-plugin-template`](https://github.com/lvis-project/lvis-plugin-template) 사용:

```bash
# GitHub 에서 "Use this template" → 새 레포 생성 후
git clone --recurse-submodules <your-repo-url> lvis-plugin-<yourname>
cd lvis-plugin-<yourname>
bun install
bun run build         # tsup → dist/
bun run test
```

submodule 누락 시: `git submodule update --init --recursive`.

매니페스트 작성 규칙(필수 필드, AJV 검증, tool 스키마 — v6 는 pure `Tool[]`)은 [`plugin-development.md`](./plugin-development.md#플러그인-매니페스트-pluginjson) 참고 (해당 가이드의 `toolSchemas`/`uiActions` 절은 pre-v6, #885 Phase R 에서 대체됨).

---

## 3. 마켓플레이스 없이 dev — 제한 사항과 절차

### 3-1. 왜 제한적인가

호스트(`PluginRuntime`)는 registry 에 등록된 manifest 경로를 **trust-root 검사**(src/plugins/runtime.ts:1353 `isTrustedRegistryManifestPath`)로 보호합니다. manifest 의 `realpathSync()` 결과가 다음 두 root 중 하나에 들어가야만 로드됩니다:

1. `realpath(hostRoot)` — `lvis-app/` 디렉토리
2. `realpath(pluginsRoot)` — `~/.lvis/plugins/`

**이 검사에는 `LVIS_DEV` 등의 우회 env 가 없습니다.** 다음은 **모두 거부**됩니다:

- `../lvis-plugin-foo/plugin.json` 같은 형제-레포 절대경로
- 형제 레포를 `~/.lvis/plugins/foo` 로 symlink 한 것 — `realpathSync` 가 원본 경로를 반환해서 검사에 걸림

거부 시 호스트 콘솔에 `[plugin-runtime] ignoring untrusted registry manifest path for <id>: <path>` 가 출력되고, 해당 플러그인은 **조용히 빠집니다** (앱은 정상 부팅).

따라서 마켓플레이스 없이 dev 설치를 하려면 **실행 중인 호스트의 Settings에서 로컬 빌드 폴더를 선택**해야 합니다. 호스트가 검증된 내용을 `~/.lvis/plugins/<id>/` 트리로 복사하고 registry와 runtime을 함께 갱신합니다.

> 일상적 dev 루프에는 [local-marketplace-testing.md](./local-marketplace-testing.md) 의 로컬 마켓플레이스 서버(git-based 부트스트랩)가 더 빠릅니다 — 플러그인을 형제 디렉토리로 두고 `bun run build` + 서버 재시작만 하면 자동 publish 됩니다. 이 §3 경로는 그 서버 띄우기조차 부담스러운 단발성 prototype 시나리오에 한정됩니다.

### 3-2. 플러그인 루트 경로

플러그인 런타임은 OS에 관계없이 항상 `~/.lvis/plugins/` 를 단일 루트로 사용합니다 (`src/plugins/plugin-paths.ts`):

| OS | 플러그인 루트 |
|----|-----------|
| Windows | `%USERPROFILE%\.lvis\plugins\` |
| macOS | `~/.lvis/plugins/` |
| Linux | `~/.lvis/plugins/` |

플러그인 루트는 환경변수로 바꾸지 않습니다. 테스트/특수 런타임만 `resolvePluginPaths({ pluginsRoot })` 처럼 constructor injection 으로 override 합니다.

> ⚠️ **`LVIS_USER_DATA_DIR` 는 플러그인 루트가 아닙니다.** `run-electron.mjs:82` 의 `ensureWindowsUserDataDir` 는 Windows 전용이며, Electron 의 **앱 프로필 디렉토리** (`--user-data-dir`) 만 변경합니다. 플러그인 루트는 이와 무관하게 항상 `~/.lvis/plugins/` 입니다.

### 3-3. 절차 — 호스트 설치 경로 사용

```bash
# 1) 플러그인 빌드
cd lvis-plugin-<yourname>
bun install
bun run build

# 2) unpackaged 호스트 실행
cd /path/to/lvis-app
bun run dev
```

3. Settings → Plugin Config → **개발자 도구** → **로컬 폴더에서 설치**를 선택합니다.
4. `plugin.json`과 `dist/`가 포함된 플러그인 빌드 폴더를 선택합니다.
5. 설치 완료 후 필요하면 `bun run plugins:list`로 조회합니다.

`plugins:list`는 조회 전용입니다. install/add/remove/enable/disable CLI와 직접 registry 변경은 실행 중인 호스트와 상태가 어긋날 수 있어 지원하지 않습니다.

### 3-4. 직접 registry 편집 금지

`~/.lvis/plugins/registry.json` 은 호스트가 소유하는 durable state입니다. 직접 편집하지 말고 위 설치 경로나 앱 설정을 사용합니다.

### 3-5. 실행

```bash
cd lvis-app
bun run start
```

`bun run start` 가 unpackaged 빌드일 때 자동 세팅하는 env (`scripts/run-electron.mjs:26-46`):

| env | 효과 |
|-----|------|
| `LVIS_DEV_SKIP_SIG=1` | 매니페스트 ed25519 서명 검증 skip — 로컬 빌드는 `plugin.json.sig` 없음 |
| `LVIS_ALLOW_LINKED_PLUGIN_ENTRY=1` | manifest 의 `entry` 필드가 `../node_modules/@lvis/...` 같은 링크 항목 가리키는 것 허용 |
| `LVIS_ENABLE_DEV_CONSOLE=0` | DevTools 자동 열기 끄기 |
| `LVIS_DEV_NO_SANDBOX=1` (Windows) | Chromium sandbox off — enterprise PC GPU 크래시 회피 |
| GPU safe-flags (Windows) | `--disable-gpu --disable-software-rasterizer --disable-gpu-compositing --no-sandbox` 자동 추가 |
| 콘솔 UTF-8 (Windows) | `chcp 65001`, `PYTHONIOENCODING=utf-8` 등 |

> `bun run start` 는 **`LVIS_DEV=1` 을 세팅하지 않습니다**. dev 게이트 전부를 켜고 싶으면 `bun run dev` (`run-electron-dev.mjs`) 를 쓰거나 직접 export. `LVIS_DEV_RELOAD` (§5) 는 독립 — `LVIS_DEV` 없이 단독으로도 동작합니다 (`dev-flags.ts:103-106`). DevTools 자동 열림은 `LVIS_ENABLE_DEV_CONSOLE=1` 이 분리된 게이트. 마켓플레이스 서명 키는 앱 호스트의 `src/plugins/marketplace-keys.ts` 가 소유하며 SDK 는 타입/소스 계약만 제공합니다.

### 3-6. 검증

부팅 로그에서:

- ✅ 정상 로드: `[lvis] boot: plugins loaded: <tool-name-list>`에 플러그인의 Tool 이름이 포함됨 — `src/boot/steps/plugin-runtime.ts`
- ✅ 서명 우회 경고: `[lvis] boot: LVIS_DEV_SKIP_SIG=1 — plugin signature verification disabled (dev-only)` — `src/boot/steps/plugin-runtime.ts:601`
- ❌ 거부됨: `[plugin-runtime] ignoring untrusted registry manifest path for <id>: <path>` → §3-1 참고
- ❌ 매니페스트 자체 invalid: `[plugin-runtime] <id> rejected — <reason>`
- ❌ 매니페스트 schema 실패: `[manifest:<id>] schema validation failed (<jsonpath>): <message>`

---

## 4. 마켓플레이스 없이 prod (packaged 빌드) — 지원되지 않음

packaged 빌드 (`app.isPackaged === true`) 는 보안 정책 상 사이드로드 우회 경로를 제공하지 않습니다.

| 게이트 | 동작 |
|--------|------|
| 모든 `LVIS_DEV*` env | `src/boot/dev-flags.ts:18-54` 에서 hard-gate — packaged 일 때 무조건 무시 |
| `LVIS_DEV_SKIP_SIG=1` | 위와 동일. **서명 없는 managed 플러그인은 거부됨** |
| Trust-root 검사 | dev 와 동일하게 항상 적용 |
| 서명 검증 (`PluginSignatureVerifier`) | `installPolicy: "admin"` 인 managed 플러그인은 `plugin.json.sig` 가 trusted publisher key set 매칭 필수 |
| 사용자 플러그인 (`installPolicy: "user"`) 서명 누락 | 기본 차단. 설정의 **"서명되지 않은 사용자 플러그인 허용"** 토글로 user-by-user opt-in 가능 (`runtime.ts:331-348`, `settings.plugins.allowUnsignedUserPlugins`) |

Settings의 로컬 폴더 설치는 dev mode에서만 표시되며 packaged 빌드에는 설치 우회 경로가 없습니다. `~/.lvis/plugins/registry.json` 직접 편집도 지원하지 않습니다.

**결론**: 비공식 prod 사이드로드 channel 은 설계상 없음. dev 에서 §3 또는 [local-marketplace-testing.md](./local-marketplace-testing.md) 로 검증 후, **prod 는 [`marketplace-publishing.md`](./marketplace-publishing.md) 의 정식 publish 가 유일 경로**입니다.

---

## 5. Hot reload — `LVIS_DEV_RELOAD=1`

`src/plugins/dev-watcher.ts` 가 각 플러그인의 `dist/` 디렉토리를 watch 하고, 변경 감지 시 디바운스 500ms 후 `PluginRuntime.reloadPlugin(id)` 호출 — 호스트 재시작 없이 해당 플러그인만 재로드합니다 (다른 플러그인·UI 영향 없음).

```bash
LVIS_DEV=1 LVIS_DEV_RELOAD=1 bun run start
# 또는
LVIS_DEV_RELOAD=1 bun run dev
```

플러그인 디렉토리 watch 터미널과 별개로:

```bash
cd lvis-plugin-<yourname>
bun run build:watch     # 또는 tsup --watch
```

watch 빌드가 `dist/*.js` 를 갱신하면 호스트 watcher 가 디바운스 후 재로드:

```
[plugin-dev-watcher] reloading <id>
[plugin-dev-watcher] reloaded <id>
```

매니페스트 (`plugin.json`) 자체 변경은 hot-reload 대상 아님 — 호스트 재시작 필요. UI 모듈 (`dist/ui/*.js`) 도 dynamic import 캐시 때문에 호스트 재시작 권장.

`LVIS_DEV_RELOAD` 는 `dev-flags.ts` 의 `app.isPackaged` 게이트를 거치므로 packaged 빌드에서 무조건 off.

---

## 6. 자주 막히는 곳

| 증상 | 원인 / 해결 |
|------|-------------|
| 부팅 후 플러그인이 안 보이고 `[plugin-runtime] ignoring untrusted registry manifest path for <id>` 로그 | manifest 가 trust-root 밖. §3-1의 Settings 로컬 폴더 설치 또는 [local-marketplace-testing.md](./local-marketplace-testing.md)를 사용합니다. symlink도 안 됩니다 (`realpathSync` 검사). |
| `bun run plugins:list` 결과가 기대와 다름 | CLI와 Electron 모두 `~/.lvis/plugins/`를 플러그인 루트로 사용합니다. 오래된 `.lvis-dev` 잔재를 제거한 뒤 Settings 로컬 폴더 설치를 다시 실행하세요. registry는 직접 편집하지 않습니다. |
| `[manifest:<id>] schema validation failed (<jsonpath>): ...` | AJV 검증 실패. `plugin.json` 의 해당 필드 확인. SDK 빌드시 `bun run validate:hostapi` 로 미리 잡힘. |
| `plugin signature required` 또는 `plugin signature verification failed` (packaged 빌드에서) | §4 참고 — packaged 빌드는 dev skip flag 무시. 정식 publish 또는 사용자 토글 필요. |
| Hot-reload 가 안 됨 | (a) `LVIS_DEV_RELOAD=1` 누락 (`bun run start` 는 자동 세팅 X — `bun run dev` 거나 직접 export). (b) `dist/` 가 watch 가능 위치인지 확인 (네트워크 드라이브 등에서는 fs.watch 부정확). (c) plugin.json 자체를 바꿨다면 호스트 재시작 필수. |
| 한글 깨짐 (cp949) | PowerShell 에서 `chcp 65001` 후 `bun run start`. 또는 Windows Terminal (UTF-8 default) 사용. |

---

## 7. 기존 dev 환경에서 단일 루트(`~/.lvis/plugins/`)로 마이그레이션

> **대상**: 이전 세대 dev 환경에서 `LVIS_PLUGINS_DIR` 환경변수, `lvis-app/.lvis-dev/plugins/`, `bun run dev:link` 등을 사용하던 기존 LVIS 개발자.
> **목표**: 충돌 없이 새 단일 루트 + 호스트 Settings 로컬 폴더 설치 워크플로우로 전환.

### 7-1. 무엇이 바뀌었나

| 변경 전 (deprecated) | 변경 후 (canonical) |
|---|---|
| `LVIS_PLUGINS_DIR` 가 dev runner 에서 자동 세팅 | dev runner 는 `LVIS_PLUGINS_DIR` 를 더 이상 사용하지 않음 — 런타임은 항상 `~/.lvis/plugins/` 사용 |
| `lvis-app/.lvis-dev/plugins/` 에 sibling repo 별 등록 | 단일 루트 `~/.lvis/plugins/` + Settings 로컬 폴더 설치로 호스트 소유 경로 통일 |
| 마켓플레이스 서명 키: SDK 또는 플러그인 패키지가 키 소유 | 앱 호스트 `marketplace-keys.ts` + 서버 env 가 trust root 를 소유 |
| 외부 개발자 sideload: 수동 파일 복사만 | UI: Settings → Plugin Config → "로컬 폴더에서 설치" 버튼 |

### 7-2. 마이그레이션 단계

**(1) 모든 레포 최신화 + 서브모듈 동기화**

```bash
cd /path/to/lvis-project

# lvis-app: 작업 중이면 stash 후 pull
cd lvis-app
git stash push --include-untracked -m "pre-single-root-migration"
git checkout main
git pull origin main
git submodule update --init --recursive   # SDK 서브모듈 갱신 (af62b1e+)
bun install                                # bun.lock 동기화
git stash pop  # 필요 시

# 모든 sibling 플러그인 최신화
cd ..
for r in lvis-plugin-meeting lvis-plugin-local-indexer lvis-plugin-work-assistant \
         lvis-plugin-work-assistant lvis-plugin-ms-graph \
         lvis-plugin-agent-hub lvis-plugin-template lvis-plugin-sdk \
         lvis-marketplace lvis-agent-hub; do
  (cd "$r" && git checkout main && git pull origin main)
done
```

**(2) 옛 dev 디렉토리 + 환경변수 정리**

```bash
# .lvis-dev 디렉토리 잔재 제거 (있을 경우)
rm -rf /path/to/lvis-project/lvis-app/.lvis-dev/plugins

# 셸 rc 에서 오래된 LVIS_PLUGINS_DIR 제거
grep -n "LVIS_PLUGINS_DIR" ~/.zshrc ~/.bashrc 2>/dev/null
# 위 grep 결과를 보고 해당 줄 삭제. 현 세션에서는:
unset LVIS_PLUGINS_DIR
```

**(3) (선택) 깨끗한 시작을 위해 `~/.lvis/plugins/` 백업 후 재구성**

```bash
mv ~/.lvis/plugins ~/.lvis/plugins.bak.$(date +%s)
```

**(4) dev 빌드와 호스트 실행**

```bash
cd /path/to/plugin-repo
bun run build
cd /path/to/lvis-app
bun run dev
```

**(5) Settings에서 로컬 빌드 폴더 설치**

1. `LVIS_DEV=1 bun run start` (또는 `bun run dev`)
2. Settings → Plugin Config → 하단 amber **개발자 도구** 패널 → **로컬 폴더에서 설치**
3. `plugin.json` + `dist/` 가 포함된 빌드 디렉토리 선택
4. 자동 재시작 후 즉시 사용 가능

> 플러그인 디렉토리 요건: `plugin.json` 의 `id` 가 `^[a-zA-Z0-9._-]+$` 매치, `dist/` 빌드 산출물 존재. `installPolicy: "admin"` 으로 이미 설치된 같은 id 는 덮어쓰기 거부됨.
>
> 복사 시 `node_modules/electron` · `node_modules/@electron/*` · `.git` 은 자동 제외됩니다 (Electron 번들 asar 가 패치된 fs 에서 "Invalid package" 로 폭사하는 사례 회피). 플러그인 런타임이 필요한 다른 npm 의존성은 그대로 복사되어 install dir 에서 import 됩니다. 같은 id 의 dev-link entry 가 registry 에 남아 있으면 `_devLinked` 플래그가 자동으로 제거되어 다음 `bun run dev` 부팅의 dev-link cleanup 으로부터 보호됩니다. install 시점에 `plugin.json` + `dist/` 의 sha256 receipt 가 `~/.lvis/plugins/.cache/<id>/install-receipt.json` 에 기록되어 호스트 integrity 게이트(`runtime/snapshots.ts`)를 통과합니다.

### 7-3. 마이그레이션 후 자가 진단

| 증상 | 원인 / 해결 |
|------|-------------|
| `Cannot find module '@lvis/plugin-sdk/keys'` 또는 관련 keys export 오류 | 로컬 working copy / SDK 서브모듈 stale 또는 오래된 코드가 SDK 키 소유 모델을 참조 중. `git pull && git submodule update --recursive` 후 앱 호스트의 `src/plugins/marketplace-keys.ts` 경로를 사용하세요. |
| `bun install --frozen-lockfile` 실패 | bun.lock 갱신 필요 → `bun install` (frozen 없이) 후 커밋 |
| 플러그인이 안 보임 | Settings → Plugin Config → 개발자 도구에서 빌드 폴더를 다시 설치하고 `bun run plugins:list`로 조회 |
| 두 위치에서 플러그인 충돌 | `.lvis-dev` 잔재를 삭제한 뒤 Settings에서 빌드 폴더를 다시 설치. registry는 직접 편집하지 않음 |
| `installSource: "dev-link"` 이 registry 에 남아 있음 (구 `bun run dev:link` 잔재) | 부팅 시 `local-dev`로 rewrite되고 경고가 출력됨. receipt 검증을 통과하도록 Settings에서 빌드 폴더를 다시 설치 |
| 서명 검증 실패 (dev) | `LVIS_DEV=1 LVIS_DEV_SKIP_SIG=1` (이미 `bun run dev` 기본값) |
| sideload 패널이 안 보임 | `LVIS_DEV=1` 환경변수 적용 확인. packaged 빌드는 dev 패널 비활성 |

---

## 관련 문서

- [`local-marketplace-testing.md`](./local-marketplace-testing.md) — **권장 dev 루프** (로컬 마켓플레이스 서버 + git-based 부트스트랩)
- [`marketplace-publishing.md`](./marketplace-publishing.md) — prod 마켓플레이스 publish 채널
- [`plugin-development.md`](./plugin-development.md) — 매니페스트 전체 스키마, HostApi 계약, capabilities, 이벤트, 서명, 테스팅 깊은 레퍼런스
- [`windows-setup.md`](./windows-setup.md) — Windows first-run 가이드
- [`../architecture/architecture.md` §9](../architecture/architecture.md#9-plugin-system--ui-extension) — 플러그인 시스템 아키텍처
