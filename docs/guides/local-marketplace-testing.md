# 로컬 마켓플레이스로 플러그인 테스트하기

> **대상**: 플러그인을 사내 prod 마켓플레이스에 올리기 전, **end-to-end 마켓플레이스 흐름**(zip 패키징 → 서버 publish → 카탈로그 노출 → 앱에서 install)이 잘 도는지 로컬에서 검증하고 싶은 개발자.
>
> **이 문서가 다루는 범위**: 로컬 `lvis-marketplace` 서버 띄우기 → CLI 로 publish → `lvis-app` 에서 install. 마켓플레이스 없이 그냥 사이드로드만 하려면 [`local-plugin-development.md`](./local-plugin-development.md). 프로덕션 publish 절차는 [`marketplace-publishing.md`](./marketplace-publishing.md).

---

## 언제 이 흐름이 필요한가

사이드로드(`plugins:add`)는 빠르지만, 다음을 검증할 수 없습니다:

- zip 구조가 서버 검증(`zip_validator`)을 통과하는지 (path traversal, symlink, 압축 비율)
- 매니페스트가 서버 schema validation 을 통과하는지
- `tools[]` namespace 충돌이 없는지
- `installPolicy`, `dependencies`, `pluginAccess` 가 서버 정책 게이트를 통과하는지
- 앱이 카탈로그에서 정상 노출 → 다운로드 → ed25519 envelope 검증 → 추출까지 도는지
- `lvis://install/{slug}` 딥링크가 동작하는지

prod 에 올리기 전 한 번은 이 루프를 도는 것을 권장.

---

## 1. 사전 준비

| 도구 | 용도 |
|------|------|
| Python ≥ 3.11 + `uv` | `lvis-marketplace` 서버 |
| Docker (선택) | Postgres 까지 한 번에 띄우려면 |
| Node.js ≥ 20 | `lvis-publish` CLI 빌드/실행 |
| `lvis-app` dev 빌드 | 카탈로그 consumer |

---

## 2. 마켓플레이스 서버 로컬 실행

두 가지 방법 — 빠르게 띄우려면 **uvicorn 단독**, Postgres 까지 재현하려면 **Docker Compose**.

### 2-A. uvicorn 단독 (SQLite, 가장 빠름)

```bash
cd lvis-marketplace/server
uv sync
cp .env.example .env                              # SQLite 기본값으로 충분
uv run alembic upgrade head
uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

확인:

```bash
curl -s http://localhost:8000/api/v1/health | jq
# { "status": "ok", "ready": true, "bootstrap_status": ... }
```

### 2-B. Docker Compose (Postgres 포함)

```bash
cd lvis-marketplace/deploy
docker compose up
# postgres :5432, marketplace server :8000
```

### 환경변수

서버는 부팅 시 `.env` 또는 환경변수에서 다음을 읽습니다 (`server/.env.example` 전체 목록):

| 변수 | 기본 | 메모 |
|------|------|------|
| `LVIS_MARKETPLACE_STORAGE_DIR` | `./storage` | 업로드 zip 저장 위치 |
| `LVIS_MARKETPLACE_DB_PATH` | `./lvis-marketplace.db` | SQLite 경로 (Postgres 사용 시 무시) |
| `LVIS_MARKETPLACE_HOST` / `_PORT` | `127.0.0.1` / `8000` | bind |
| `LVIS_MARKETPLACE_MAX_ARTIFACT_MB` | `50` | zip 사이즈 상한 (CLI 도 같은 값으로 가드) |
| `MARKETPLACE_SIGNING_PRIVATE_KEY_DEV_V1` | `.env.example` 의 dev 값 | dev-v1 키 — 로컬 개발 OK, **prod 금지** |
| `LVIS_SCHEMA_HOST` | `lvis.local` | 매니페스트 `$schema` URI 호스트. 로컬에서는 기본값 그대로 사용 |

서버는 시작 시 모든 환경변수에 잡히는 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 키로 zip 의 sha256 을 **모두 자동 서명**합니다. 클라이언트(`lvis-app`)는 envelope 의 시그니처 중 하나라도 자기가 번들한 publisher key set 에 매칭되면 받아들입니다.

---

## 3. CLI(`lvis-publish`) 빌드

CLI 는 워크스페이스에 별도 빌드가 필요합니다.

```bash
cd lvis-marketplace/cli
npm install
npm run build
# 실행 진입점: ./bin/lvis-publish
```

전역 등록(선택):

```bash
npm link                         # → 어디서든 `lvis-publish` 호출
```

이후부터는 `npx lvis-publish ...` 또는 `lvis-marketplace/cli/bin/lvis-publish ...` 로 실행.

---

## 4. 플러그인 zip 패키징

> ⚠️ 현재 `lvis-plugin-template` 에는 `package.sh` 같은 zip 헬퍼가 없습니다. 직접 `zip` 으로 만듭니다. Windows 면 PowerShell `Compress-Archive` 또는 7-zip.

### 4-1. 빌드

플러그인 레포에서:

```bash
cd lvis-plugin-<yourname>
bun install
bun run build       # → dist/ 생성
```

### 4-2. (선택) 매니페스트 서명

마켓플레이스 서버는 zip 의 sha256 을 별도로 서명하지만, **매니페스트 자체 서명**(`plugin.json.sig`)은 `installPolicy: "admin"` 일 때 호스트가 강제합니다. 로컬 dev 에서는 `LVIS_DEV_SKIP_SIG=1` 로 우회 가능하지만, prod 흐름을 그대로 재현하려면 서명까지 해보는 것이 좋습니다.

```bash
# (1) 개발용 키페어 생성 — lvis-app 의 헬퍼 사용
cd ../lvis-app
node scripts/keygen-publisher.mjs > /tmp/dev-publisher.pem
# 출력에서 PRIVATE / PUBLIC PEM 블록을 분리해 저장

# (2) 환경변수에 PRIVATE 넣고 매니페스트 서명
cd ../lvis-plugin-<yourname>
LVIS_PUBLISHER_SIGNING_KEY="$(cat /tmp/dev-publisher-private.pem)" \
  node ../lvis-app/scripts/sign-manifest.mjs plugin.json
# → plugin.json.sig 생성
```

`lvis-app` 이 이 PUBLIC 키를 신뢰하게 만들려면 SDK 의 `MARKETPLACE_PUBLIC_KEYS` 에 추가하거나(영구), 단발성 테스트면 `LVIS_DEV_SKIP_SIG=1` 로 검증을 건너뛰면 됩니다.

### 4-3. zip 만들기

zip 루트에 `plugin.json` 과 `dist/` 가 있어야 합니다 (서브폴더 한 단계 들어가면 서버가 거절).

```bash
zip -r lvis-plugin-<yourname>-0.1.0.zip plugin.json dist/ icons/ 2>/dev/null
# 서명을 했다면
zip -r lvis-plugin-<yourname>-0.1.0.zip plugin.json plugin.json.sig dist/ icons/
```

PowerShell:

```powershell
Compress-Archive -Path plugin.json,plugin.json.sig,dist,icons `
  -DestinationPath lvis-plugin-<yourname>-0.1.0.zip
```

빠른 검증 (path traversal / symlink / 매직 바이트):

```bash
unzip -l lvis-plugin-<yourname>-0.1.0.zip | head
# plugin.json 이 root 에 있어야 함. dist/ 도 root 직속.
```

---

## 5. CLI 로 publish

먼저 CLI 에 base URL + key 를 저장 (`~/.lvis/marketplace-cli.json`):

```bash
lvis-publish login --base-url http://localhost:8000
# API key 프롬프트 — 로컬 dev 서버는 기본 인증이 켜져 있지 않으면 빈 값 OK
lvis-publish status
# server health + login state 출력
```

publish:

```bash
lvis-publish publish lvis-plugin-<yourname>-0.1.0.zip --slug <yourname>
```

CLI 가 client-side 에서 다음을 가드:
- `.zip` 확장자 + ZIP magic bytes
- 50 MB 상한
- 파일 존재성

서버 응답 예:

```json
{ "plugin_id": 7, "version": "0.1.0", "sha256": "abc..." }
```

확인:

```bash
lvis-publish list
lvis-publish show <yourname>
curl -s http://localhost:8000/api/v1/catalog | jq '.plugins[] | select(.slug == "<yourname>")'
```

---

## 6. lvis-app 에서 install

### 6-1. 마켓플레이스 URL 등록

`lvis-app` 실행 후 → 설정 → **마켓플레이스** 탭:

| 필드 | 값 |
|------|----|
| 서버 URL | `http://localhost:8000` |
| API 키 | (로컬 dev 서버는 비워둬도 됨) |
| 사설 네트워크 허용 | **켜기** (loopback URL 이라 필요) |

저장 후 부트스트랩 배너의 **다시 시도** 버튼으로 catalog refresh.

> API 키가 변경되면 fetcher 재구성을 위해 앱 재시작이 필요합니다. URL 변경은 **다시 시도**로 충분.

### 6-2. dev 플래그

unpackaged 빌드는 `scripts/run-electron.mjs` 가 자동 세팅하지만, 로컬 마켓플레이스 테스트에는 보통 추가로:

```bash
LVIS_ALLOW_TEST_MARKETPLACE_KEYS=1 bun run start
```

| 플래그 | 효과 |
|--------|------|
| `LVIS_DEV=1` | dev 게이트 활성화 (자동 세팅) |
| `LVIS_DEV_SKIP_SIG=1` | 매니페스트 서명 검증 skip (자동 세팅) |
| **`LVIS_ALLOW_TEST_MARKETPLACE_KEYS=1`** | 번들된 publisher key set 에 `dev-v1`/`poc-v1` 같은 **테스트 키 포함**. 서버가 dev 키로 zip 을 서명했을 때 envelope 검증을 통과시키려면 필수. |

모든 `LVIS_*` 플래그는 `app.isPackaged === true` 일 때 hard-gate 로 무시됩니다 — packaged 빌드 누수 우려 없음.

### 6-3. 두 가지 install 경로

**A. 마켓플레이스 탭 → 카드 → 설치**

가장 흔한 흐름. 앱이:
1. `GET /api/v1/plugins/<slug>/versions/<version>/download` 로 zip 다운로드
2. ed25519 envelope 검증 — 키 ID 가 번들된 publisher key set 에 매칭되어야 통과
3. zip → `userData/plugins/<id>/` 추출 (atomic stage → swap rename)
4. `registry.json` 업데이트 → `pluginRuntime.restartAll()`

**B. 딥링크 (`lvis://install/<slug>`)**

OS 가 `lvis://` 핸들러를 등록한 상태에서:

```bash
# macOS
open "lvis://install/<yourname>"

# Linux
xdg-open "lvis://install/<yourname>"

# Windows
start "lvis://install/<yourname>"
```

앱이 사용자 확인 다이얼로그를 띄우고 위 A 경로와 동일한 install pipeline 으로 진행. 진행률은 `lvis:plugins:install-progress`, 결과는 `lvis:plugins:install-result` IPC 이벤트로 broadcast.

### 6-4. 설치 확인

설치 후:

```bash
ls ~/.lvis/plugins/user/<yourname>/      # 추출된 디렉토리 (또는 userData 경로)
cat ~/.lvis/plugins/registry.json         # 항목 추가됐는지
```

앱 부팅 로그에 `plugin loaded: <id>` 가 보이고, 도구가 채팅에서 호출 가능해야 정상.

---

## 7. 자주 막히는 곳

| 증상 | 원인 / 해결 |
|------|-------------|
| `signature verification failed` | (a) `LVIS_ALLOW_TEST_MARKETPLACE_KEYS=1` 누락. (b) 서버가 prod 키로 서명했는데 lvis-app 이 dev 빌드. 서버의 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 환경변수와 lvis-app 의 trust set 이 같은 키 ID 를 공유하는지 확인. |
| `manifest signature missing` (managed) | `installPolicy: "admin"` 인데 `plugin.json.sig` 가 zip 에 없음. §4-2 따라 서명하거나 dev 에서 `LVIS_DEV_SKIP_SIG=1`. |
| `tool_name namespace conflict` (publish 시 거절) | 다른 플러그인이 같은 tool 이름을 이미 등록. publisher prefix 추가 (예: `myplugin_search`). |
| `(plugin_id, version)` duplicate (publish 시 거절) | 동일 버전 재업로드는 차단. `version` 을 bump 하고 다시 publish. 또는 dev DB 를 날리려면: 서버 중지 → `rm lvis-marketplace-dev.db` → `alembic upgrade head` 재실행. |
| 카탈로그가 비어 보임 | (a) 부트스트랩 배너 빨간색 — URL 오타 또는 사설 네트워크 토글 꺼짐. (b) `LVIS_MARKETPLACE_HOST=127.0.0.1` 인데 앱이 `localhost` 로 호출하면서 IPv6 가 끼어드는 경우 — 서버를 `0.0.0.0` 으로 띄우거나 앱 설정 URL 을 `127.0.0.1` 로 통일. |
| `zip rejected: path traversal` | zip 안에 `../` 또는 절대 경로 항목. macOS 의 `__MACOSX/` 디렉토리도 경고/거절 사유 — `zip -r ... -x "__MACOSX/*" "*.DS_Store"`. |
| `zip rejected: compression bomb` | 너무 높은 압축비. `dist/` 안에 거대한 placeholder asset 이 있는지 확인. 또는 서버의 `LVIS_MARKETPLACE_MAX_UNCOMPRESSED_MB` 상향. |
| `LVIS_SCHEMA_HOST` 관련 매니페스트 검증 실패 | 매니페스트 `$schema` 가 `https://lvis.local/schemas/plugin.schema.json` 인데 서버가 다른 host 로 빌드된 schema 만 들고 있음. 둘 다 기본값(`lvis.local`)을 쓰거나, 같은 값으로 환경변수 통일. |
| 딥링크 클릭해도 앱이 안 뜸 | OS 가 `lvis://` 를 다른 인스턴스에 라우팅. macOS: 앱을 한 번 packaged 형태로 실행해 protocol 등록. Windows: registry 의 `HKCR\lvis` 항목 확인. |

---

## 8. 정리

dev DB 에 쌓인 데이터를 한 번에 비우고 싶을 때:

```bash
cd lvis-marketplace/server
# 서버 중지 후
rm -f lvis-marketplace-dev.db
rm -rf storage/
uv run alembic upgrade head    # 빈 DB 재생성
```

CLI 로그아웃:

```bash
lvis-publish logout   # ~/.lvis/marketplace-cli.json 삭제
```

---

## 관련 문서

- [`local-plugin-development.md`](./local-plugin-development.md) — 마켓플레이스 없이 사이드로드만으로 dev 루프 돌리기
- [`marketplace-publishing.md`](./marketplace-publishing.md) — prod 마켓플레이스 publish 절차 (관리형 승인 흐름 포함)
- [`plugin-development.md`](./plugin-development.md) — 매니페스트·HostApi·서명 깊은 레퍼런스
- `lvis-marketplace/server/README.md` — 서명 키 ID 회전, `(plugin, mcp)` schema 분류, 정책 계약
- `lvis-marketplace/cli/src/index.ts` — CLI 서브커맨드 전체 목록 (login/logout/status/list/show/publish/yank/approve)
