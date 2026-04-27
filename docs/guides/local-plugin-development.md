# 마켓플레이스 없이 플러그인 다루기 (dev / prod)

> **대상**: `lvis-marketplace` 카탈로그를 거치지 않고 lvis-app 에 플러그인을 직접 등록하고 싶은 개발자/관리자.
>
> **이 문서가 다루는 범위**: 마켓플레이스 우회 시나리오 — dev 빌드에서의 빠른 prototyping 과 packaged(prod) 빌드에서의 사이드로드 가능 여부. **이 경로는 제한적입니다** (§3, §4 참고). 일상적 dev 루프는 [`local-marketplace-testing.md`](./local-marketplace-testing.md) (로컬 마켓플레이스 서버) 가 권장됩니다 — 사이드로드 형제-레포 manifest 는 호스트 trust-root 검사에서 거부됩니다.

---

## 4-quadrant 매트릭스

| | 마켓플레이스 있이 | 마켓플레이스 없이 |
|--|--|--|
| **dev** (unpackaged 빌드) | [local-marketplace-testing.md](./local-marketplace-testing.md) — git-based 부트스트랩 자동 publish (**권장 dev 루프**) | §3 — `<userData>/plugins/` 직접 복사 (제한 사항 다수) |
| **prod** (packaged 빌드) | [marketplace-publishing.md](./marketplace-publishing.md) — 정식 publish 채널 | §4 — 비공식 channel 없음. 사용자 토글로만 가능 |

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

매니페스트 작성 규칙(필수 필드, AJV 검증, toolSchemas)은 [`plugin-development.md`](./plugin-development.md#플러그인-매니페스트-pluginjson) 참고.

---

## 3. 마켓플레이스 없이 dev — 제한 사항과 절차

### 3-1. 왜 제한적인가

호스트(`PluginRuntime`)는 registry 에 등록된 manifest 경로를 **trust-root 검사**(src/plugins/runtime.ts:1353 `isTrustedRegistryManifestPath`)로 보호합니다. manifest 의 `realpathSync()` 결과가 다음 두 root 중 하나에 들어가야만 로드됩니다:

1. `realpath(hostRoot)` — `lvis-app/` 디렉토리
2. `realpath(userInstalledDir)` — `<userData>/plugins/`

**이 검사에는 `LVIS_DEV` 등의 우회 env 가 없습니다.** 다음은 **모두 거부**됩니다:

- `../lvis-plugin-foo/plugin.json` 같은 형제-레포 절대경로
- 형제 레포를 `<userData>/plugins/foo` 로 symlink 한 것 — `realpathSync` 가 원본 경로를 반환해서 검사에 걸림

거부 시 호스트 콘솔에 `[plugin-runtime] ignoring untrusted registry manifest path for <id>: <path>` 가 출력되고, 해당 플러그인은 **조용히 빠집니다** (앱은 정상 부팅).

따라서 마켓플레이스 없이 dev 사이드로드를 하려면 **플러그인을 `<userData>/plugins/<id>/` 트리 안에 물리적으로 복사**해야 합니다.

> 일상적 dev 루프에는 [local-marketplace-testing.md](./local-marketplace-testing.md) 의 로컬 마켓플레이스 서버(git-based 부트스트랩)가 더 빠릅니다 — 플러그인을 형제 디렉토리로 두고 `bun run build` + 서버 재시작만 하면 자동 publish 됩니다. 이 §3 경로는 그 서버 띄우기조차 부담스러운 단발성 prototype 시나리오에 한정됩니다.

### 3-2. userData 경로 (OS별)

`run-electron.mjs:82` 가 Electron profile 이름을 `Electron-LVIS-Run` 으로 고정합니다:

| OS | 기본 경로 |
|----|-----------|
| Windows | `%APPDATA%\Electron-LVIS-Run\plugins\` |
| macOS | `~/Library/Application Support/Electron-LVIS-Run/plugins/` |
| Linux | `~/.config/Electron-LVIS-Run/plugins/` |

`LVIS_USER_DATA_DIR=/some/path` 로 override 가능.

> ⚠️ **CLI vs Electron registry 불일치 trap**. `bun run plugins:list` 같은 CLI 는 `scripts/plugins-cli.ts:21` 에서 `LVIS_USER_DATA_DIR ?? ~/.lvis` 를 사용합니다. Electron 은 `--user-data-dir=<appData>/Electron-LVIS-Run` 을 사용합니다. 둘이 다르면 **CLI 로 등록한 플러그인을 Electron 이 못 봅니다**. 양쪽에 같은 `LVIS_USER_DATA_DIR` 를 export 하거나 (또는 둘 다 명시적 동일 경로), 직접 등록 (§3-4) 을 권장.

### 3-3. 절차 — `bun run plugins:add` 사용

```bash
# 1) 플러그인 빌드
cd lvis-plugin-<yourname>
bun install
bun run build

# 2) <userData>/plugins/<id>/ 안에 복사
#    예: id="myplugin", macOS 의 경우
mkdir -p "$HOME/Library/Application Support/Electron-LVIS-Run/plugins/myplugin"
cp -R plugin.json dist/ \
    "$HOME/Library/Application Support/Electron-LVIS-Run/plugins/myplugin/"

# 3) lvis-app 의 CLI 로 registry 에 등록 — 두 경로가 같은 userData 를 가리키도록
cd /path/to/lvis-app
export LVIS_USER_DATA_DIR="$HOME/Library/Application Support/Electron-LVIS-Run"
bun run plugins:add -- myplugin myplugin/plugin.json
# manifest 경로는 <userData>/plugins/ 기준 상대경로
bun run plugins:list      # 등록 확인 — registryPath 가 위 경로 안에 있어야 정상
```

CLI 는 manifest 가 실제로 존재하는지 (`access`) 만 확인하고 trust-root 검사는 하지 않습니다 — 그건 호스트(Electron 시작 시) 가 합니다.

### 3-4. 직접 registry 편집 (대안)

`<userData>/plugins/registry.json` 을 직접 편집하는 것이 가장 명확합니다 (CLI/Electron 경로 mismatch 회피):

```json
{
  "version": 1,
  "plugins": [
    { "id": "myplugin", "manifestPath": "myplugin/plugin.json", "enabled": true }
  ]
}
```

`manifestPath` 는 `dirname(registryPath)` (= `<userData>/plugins/`) 기준 상대경로 또는 절대경로. 단 절대경로도 trust-root 안에 있어야 합니다.

### 3-5. 실행

```bash
cd lvis-app
LVIS_USER_DATA_DIR="<위와-동일-경로>" bun run start
```

`bun run start` 가 unpackaged 빌드일 때 자동 세팅하는 env (`scripts/run-electron.mjs:26-46`):

| env | 효과 |
|-----|------|
| `LVIS_DEV_SKIP_SIG=1` | 매니페스트 ed25519 서명 검증 skip — 로컬 빌드는 `plugin.json.sig` 없음 |
| `LVIS_ALLOW_LINKED_PLUGIN_ENTRY=1` | manifest 의 `entry` 필드가 `../node_modules/@lvis/...` 같은 링크 항목 가리키는 것 허용 |
| `LVIS_ENABLE_DEV_CONSOLE=0` | DevTools 자동 열기 끄기 |
| `LVIS_DEV_NO_SANDBOX=1` (Windows) | Chromium sandbox off — 사내 PC GPU 크래시 회피 |
| GPU safe-flags (Windows) | `--disable-gpu --disable-software-rasterizer --disable-gpu-compositing --no-sandbox` 자동 추가 |
| 콘솔 UTF-8 (Windows) | `chcp 65001`, `PYTHONIOENCODING=utf-8` 등 |

> `bun run start` 는 **`LVIS_DEV=1` 을 세팅하지 않습니다**. dev 게이트 전부를 켜고 싶으면 `bun run dev` (`run-electron-dev.mjs`) 를 쓰거나 직접 export. `LVIS_DEV=1` 으로 추가 활성화되는 것: `LVIS_ALLOW_TEST_MARKETPLACE_KEYS` 와 동등한 효과 (`dev-flags.ts:88` testMarketplaceKeysAllowed 가 `LVIS_DEV` 도 OR 로 받음). `LVIS_DEV_RELOAD` (§5) 는 독립 — `LVIS_DEV` 없이 단독으로도 동작합니다 (`dev-flags.ts:103-106`). DevTools 자동 열림은 `LVIS_ENABLE_DEV_CONSOLE=1` 이 분리된 게이트.

### 3-6. 검증

부팅 로그에서:

- ✅ 정상 로드: `[lvis] plugin:<id> registered <N> keywords` (또는 `tools` 등록 로그) — `src/boot/steps/plugin-runtime.ts:645` 부근
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

따라서 packaged 빌드에서 **마켓플레이스 없이 플러그인을 추가하려면**:

1. **trusted publisher key 로 서명된 zip 을 직접 받아 설치**: 마켓플레이스 외 채널(예: 사내 파일 공유)로 받은 서명된 artifact 를 (앱이 직접 install API 를 노출하지 않으므로) registry 에 수동 추가하는 방법은 사실상 없음 — 정상 경로는 마켓플레이스 install.
2. **사용자 플러그인 (서명 없음) + 토글 켜기**: 설정 → 플러그인 → "서명되지 않은 사용자 플러그인 허용" 켜고, `<userData>/plugins/<id>/` 에 복사하고 `registry.json` 수동 편집. 이는 **사용자가 명시적으로 보안 약화를 동의** 한 경우에만 가능. 관리형 정책(`admin`) 플러그인은 이 우회 안 됨.

**결론**: 비공식 prod 사이드로드 channel 은 설계상 없음. dev 에서 §3 또는 [local-marketplace-testing.md](./local-marketplace-testing.md) 로 검증 후, **prod 는 [`marketplace-publishing.md`](./marketplace-publishing.md) 의 정식 publish 가 유일 경로**.

---

## 5. Hot reload — `LVIS_DEV_RELOAD=1`

`src/plugins/dev-watcher.ts` 가 각 플러그인의 `dist/` 디렉토리를 watch 하고, 변경 감지 시 디바운스 500ms 후 `PluginRuntime.reloadPlugin(id)` 호출 — 호스트 재시작 없이 해당 플러그인만 재로드합니다 (다른 플러그인·UI 영향 없음).

```bash
LVIS_DEV=1 LVIS_DEV_RELOAD=1 LVIS_USER_DATA_DIR="<…>" bun run start
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
| 부팅 후 플러그인이 안 보이고 `[plugin-runtime] ignoring untrusted registry manifest path for <id>` 로그 | manifest 가 trust-root 밖. §3-1 참고 — `<userData>/plugins/<id>/` 안으로 복사하거나 [local-marketplace-testing.md](./local-marketplace-testing.md) 사용. symlink 도 안 됨 (`realpathSync` 검사). |
| `bun run plugins:list` 결과가 Electron registry 와 다름 (Windows 흔함) | CLI 의 userDataDir(`~/.lvis`) ≠ Electron 의 `<appData>\Electron-LVIS-Run\`. 양쪽에 동일 `LVIS_USER_DATA_DIR` export 또는 §3-4 직접 편집. |
| `[manifest:<id>] schema validation failed (<jsonpath>): ...` | AJV 검증 실패. `plugin.json` 의 해당 필드 확인. SDK 빌드시 `bun run validate:hostapi` 로 미리 잡힘. |
| `plugin signature required` 또는 `plugin signature verification failed` (packaged 빌드에서) | §4 참고 — packaged 빌드는 dev skip flag 무시. 정식 publish 또는 사용자 토글 필요. |
| `Plugin already exists: <id>` (`plugins:add`) | 같은 id 가 registry 에 이미 있음. `bun run plugins:remove -- <id>` 후 재등록. |
| Hot-reload 가 안 됨 | (a) `LVIS_DEV_RELOAD=1` 누락 (`bun run start` 는 자동 세팅 X — `bun run dev` 거나 직접 export). (b) `dist/` 가 watch 가능 위치인지 확인 (네트워크 드라이브 등에서는 fs.watch 부정확). (c) plugin.json 자체를 바꿨다면 호스트 재시작 필수. |
| Windows 에서 `EISDIR` (file:../ 설치 시) | npm 의 file: 링크가 symlink 모드로 동작. `npm install --legacy-peer-deps --install-links=true` 또는 bun 사용. |
| 한글 깨짐 (cp949) | `npm run start:win` (PowerShell launcher) 또는 `chcp 65001` 직접. `bun run start` 는 자동 처리. |

---

## 관련 문서

- [`local-marketplace-testing.md`](./local-marketplace-testing.md) — **권장 dev 루프** (로컬 마켓플레이스 서버 + git-based 부트스트랩)
- [`marketplace-publishing.md`](./marketplace-publishing.md) — prod 마켓플레이스 publish 채널
- [`plugin-development.md`](./plugin-development.md) — 매니페스트 전체 스키마, HostApi 계약, capabilities, 이벤트, 서명, 테스팅 깊은 레퍼런스
- [`windows-setup.md`](./windows-setup.md) — Windows 사내망 first-run 가이드
- [`../architecture/architecture.md` §9](../architecture/architecture.md#9-plugin-system--ui-extension) — 플러그인 시스템 아키텍처
