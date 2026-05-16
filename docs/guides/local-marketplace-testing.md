# 로컬 마켓플레이스로 플러그인 테스트하기 (권장 dev 루프)

> **대상**: enterprise prod 마켓플레이스에 올리기 전 전체 마켓플레이스 흐름(서버 부트스트랩 → 카탈로그 노출 → 앱 install)을 로컬에서 검증하고 싶은 플러그인 개발자.
>
> **이 문서가 다루는 범위**: 로컬 `lvis-marketplace` 서버 띄우기 → 플러그인 git 레포에서 빌드/버전 bump → 서버가 자동으로 카탈로그에 등록 → `lvis-app` 에서 install. 마켓플레이스 우회 시나리오는 [`local-plugin-development.md`](./local-plugin-development.md). prod 카탈로그 publish 절차는 [`marketplace-publishing.md`](./marketplace-publishing.md).
>
> 코드 구조 상 **이것이 lvis-app 의 권장 dev 루프**입니다. `src/plugins/marketplace.ts:824-828` 의 주석이 명시: "Production and dev both fetch a signed zip from the marketplace API; the dev workflow runs the marketplace server locally". 형제-레포 사이드로드는 trust-root 검사에서 거부됨.

---

## ⚡ 빠른 시작 (TL;DR)

**1) 마켓플레이스 서버 띄우기**

```bash
cd lvis-marketplace/server
uv sync
cp .env.example .env                       # POC_V1 키 자동 포함
uv run alembic upgrade head
LVIS_MARKETPLACE_LOAD_DOTENV=1 \
  uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

서버가 `MANAGED_SOURCES` 의 형제 lvis-plugin-* 레포를 자동 부트스트랩 → 카탈로그 노출.

**2) lvis-app 가 로컬 서버 가리키도록**

Settings → 마켓플레이스 → URL = `http://127.0.0.1:8000` + 사설 네트워크 토글 ON → 앱 재시작.

**3) lvis-app 기동**

```bash
cd ../lvis-app
bun run dev      # LVIS_DEV=1 + hot-reload 자동
```

**4) 카탈로그 → 카드 클릭 → 설치** 또는 딥링크 `lvis://install/<slug>?version=<v>&source=...`.

**5) 새 버전 발행**: 플러그인 레포에서 `package.json` 버전 bump + `bun run build` → 서버 재시작 → 자동 publish.

상세 (서버 env, install 두 경로, 트러블슈팅 등) 은 §1-8 참고.

---

## 한 줄 요약 — 배포 모델

LVIS 마켓플레이스는 **git-based publish** (Go 모듈 프록시 스타일). 서버가 등록된 플러그인 git 레포를 직접 풀(pull)하고 packaging/signing 까지 서버 사이드에서 수행. **개발자는 zip 을 만들 필요도, CLI 로 업로드할 필요도 없습니다.**

```
[plugin git repo: bun run build → package.json version bump → commit (push 선택)]
                              ↓
[lvis-marketplace server: bootstrap on startup]
   git pull --ff-only → plugin.json + dist/ + prod node_modules → 결정적 zip → ed25519 서명 → DB UPSERT
                              ↓
[lvis-app: catalog refresh → 카드 → install]
   서버에서 zip 다운로드 → envelope 검증 → 추출 → registry 등록
```

> 서버가 만드는 zip 은 클라이언트 전송 포맷일 뿐, 개발자 산출물이 아닙니다. 서명도 서버가 합니다 (`MARKETPLACE_SIGNING_PRIVATE_KEY_*` 키들).

---

## 등록된 managed 플러그인 (`MANAGED_SOURCES`)

`lvis-marketplace/server/src/lvis_marketplace/bootstrap.py:121-187` 에 하드코딩된 6개 + 합성 1개:

| slug | 레포 디렉토리명 | install policy | 비고 |
|------|------------------|----------------|------|
| `meeting` | `lvis-plugin-meeting` | user (명시) | |
| `local-indexer` | `lvis-plugin-local-indexer` | admin (fallback) | `install_policy`/`deployment` 키 생략 → fallback 룰로 admin |
| `ms-graph` | `lvis-plugin-ms-graph` | user (명시) | 구 email + calendar 플러그인 합본 |

| `work-assistant` | `lvis-plugin-work-assistant` | user (명시) | |
| `agent-hub` | `lvis-plugin-agent-hub` | user (명시) | |
| `hello-world` (합성) | (코드 안에 dummy zip) | free | 부팅 시 자동 publish — install-flow 테스트용 |

> ⚠️ **fallback 룰 주의**: `MANAGED_SOURCES` 항목에서 `install_policy` / `deployment` 를 둘 다 생략하면 `admin`/`managed` 로 간주됩니다 (`bootstrap.py:651-655`). 새 user-policy 플러그인은 반드시 둘 다 명시(`install_policy="user", deployment="user"`)하세요. local-indexer 가 admin 인 것은 두 필드를 모두 생략한 결과지 의도된 admin 정책이라는 보장은 코드 차원입니다.

이 6개 중 하나를 수정하고 있다면 §3 의 dev 루프로 바로 진입. 새 플러그인은 §6 참고.

---

## 1. 워크스페이스 레이아웃

서버는 워크스페이스 root 를 다음 순서로 결정 (`bootstrap.py:79-91`):

1. `LVIS_PLUGIN_WORKSPACE_ROOT` env 가 있으면 그 값
2. 7개 managed 레포가 모두 sibling 으로 발견되는 첫 ancestor (`lvis-marketplace/` 부터 거슬러 올라감)
3. 그것도 없으면 `lvis-marketplace/` 의 부모

표준 레이아웃:

```
lvis-project/
├── lvis-app/
├── lvis-marketplace/         ← 서버
├── lvis-plugin-meeting/      ← bootstrap 이 git pull 대상으로 인식
├── lvis-plugin-local-indexer/
├── lvis-plugin-email/
├── lvis-plugin-calendar/
├── 
├── lvis-plugin-work-assistant/
└── lvis-plugin-agent-hub/
```

7개 중 일부만 있어도 OK — 없는 것은 부팅 로그에 `bootstrap: repo missing, skipped: <full-path>` 만 남기고 진행.

---

## 2. 마켓플레이스 서버 로컬 실행

### 2-A. 빠른 시작 (uvicorn + SQLite)

```bash
cd lvis-marketplace/server
uv sync
cp .env.example .env

uv run alembic upgrade head

# 중요: main.py 는 LVIS_MARKETPLACE_LOAD_DOTENV=1 일 때만 .env 를 읽습니다.
LVIS_MARKETPLACE_LOAD_DOTENV=1 \
  uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

> ⚠️ **`cp .env.example .env` 만 하면 키가 안 잡힙니다**. `lvis_marketplace/main.py:12-17` 가 `LVIS_MARKETPLACE_LOAD_DOTENV=1` 인 경우에만 `python-dotenv` 로 .env 를 로드합니다 (운영/CI 가 실수로 dev 키를 읽지 않도록). 매번 export 하기 번거로우면 `set -a; source .env; set +a` 같은 shell 패턴을 쓰세요.

### 2-B. Docker Compose (Postgres 포함, 선택)

```bash
cd lvis-marketplace/deploy
docker compose up
# postgres :5432, marketplace server :8000
```

### 2-C. 부팅 확인

부팅 로그에서 bootstrap 라인을 봅니다 (`bootstrap.py:677-711` 의 실제 wording):

```
bootstrap: meeting@1.0.0 unchanged — preserving existing artifact
bootstrap: repo missing, skipped: /path/to/lvis-plugin-local-indexer
```

> log 의 "skipped" 줄은 slug prefix 가 없는 풀 경로 형태입니다.

health 확인 (응답 shape 은 `lvis_marketplace/schemas.py:HealthResponse`):

```bash
curl -s http://localhost:8000/api/v1/health | jq
# { "status": "ok", "version": "0.1.0", "ready": true, "bootstrap_status": "ready" }
```

`bootstrap_status` 는 string: `"starting"` / `"ready"` / `"failed"` / `"skipped"` 중 하나. publish 갯수나 failure 목록은 health 에 노출되지 않고 **서버 로그**(stderr)에서만 확인 가능.

catalog 확인 — `/api/v1/catalog` 는 **bare JSON array** 반환 (`response_model=list[PluginSummary]`):

```bash
curl -s http://localhost:8000/api/v1/catalog | jq '.[] | {slug, latest_stable_version}'
# [...].plugins 같은 envelope 없음. 바로 .[]
```

### 2-D. 핵심 환경변수

| 변수 | 기본 | 메모 |
|------|------|------|
| `LVIS_MARKETPLACE_LOAD_DOTENV` | 미설정 | `1` 일 때만 `.env` 로드 (위 §2-A 참고) |
| `LVIS_MARKETPLACE_HOST` | `127.0.0.1` | uvicorn 바인드 호스트. `localhost` 보다 `127.0.0.1` 권장 (IPv6 회피) |
| `LVIS_MARKETPLACE_PORT` | `8000` | uvicorn 바인드 포트 |
| `LVIS_MARKETPLACE_STORAGE_DIR` | `./storage` | 부트스트랩 zip + 서명 envelope 저장소 |
| `LVIS_MARKETPLACE_DB_PATH` | `./lvis-marketplace.db` | SQLite (Postgres 사용 시 무시) |
| `LVIS_PLUGIN_WORKSPACE_ROOT` | (자동 탐지) | §1 참고 |
| `LVIS_MARKETPLACE_SKIP_BOOTSTRAP` | 미설정 | `1` 이면 git pull / 패키징 skip — 기존 DB 만 보고 빠르게 띄울 때 |
| `LVIS_SCHEMA_HOST` | `lvis.local` | 매니페스트 `$schema` URI 호스트. 로컬에서는 기본값. (URL 자체는 매니페스트에 박히는 식별자일 뿐, fetch 되지 않음 — DNS 이슈 없음) |
| `MARKETPLACE_SIGNING_PRIVATE_KEY_POC_V1` | `.env.example` 에 dev 값 | 서버가 zip sha256 을 서명할 키. 여러 키 등록 시 모두 dual-sign |
| `MARKETPLACE_SIGNING_PRIVATE_KEY_<KEY_ID>` | (없음) | `<KEY_ID>` = key_id 를 대문자화 + `-` → `_`. 예: `poc-v1` → `POC_V1` |

서버는 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 형태로 잡히는 모든 키로 **dual-sign** 합니다. 클라이언트(`lvis-app`)는 envelope 의 시그니처 중 하나라도 자기가 신뢰하는 publisher key set 에 매칭되면 OK.

---

## 3. 내 플러그인 변경 → 카탈로그 반영

managed 7개 중 하나를 작업하는 경우 — 한 사이클은 다음과 같습니다.

### 3-1. 플러그인 레포에서 빌드

```bash
cd lvis-plugin-<your-managed-slug>
bun install
bun run build           # → dist/ 갱신
bun run test            # 권장
```

### 3-2. 버전 bump

`package.json` 의 `version` 을 올립니다. 서버가 이 값을 읽어 `PluginVersion` 행을 만듭니다.

```bash
npm version patch --no-git-tag-version
# bun 은 version bump subcommand 없음 — npm 만 또는 package.json 직접 편집
```

> ⚠️ **동일 버전 재발행 불가**. `(plugin_id, version)` 유니크 + 같은 버전이면 sha256 비교까지 합니다. dist/ 내용이 바뀌었는데 버전이 같으면 다음 fail 메시지로 거절:
>
> `<slug>@<v>: immutable artifact mismatch (existing 0123456789ab != rebuilt fedcba987654)` — sha256 의 앞 12자리만 표시됨 (`bootstrap.py:665-671`).
>
> 반드시 버전을 올리거나 §7 의 DB 리셋.

### 3-3. 커밋 (선택)

```bash
git add plugin.json dist/ package.json
git commit -m "chore: bump to 0.1.1"
```

> **커밋도 push 도 dev 루프엔 필수 아님**. bootstrap 은 `git pull --ff-only` 가 실패해도 (no remote / 네트워크 끊김 / non-ff) `using existing dist/` 경고만 남기고 working tree 의 `dist/` 를 그대로 패키징합니다. push 는 다른 dev 가 보게 만드는 용도일 뿐.

### 3-4. 서버 부트스트랩 재실행

부트스트랩은 **서버 lifespan 시점**에 돕니다 — 외부 `dist/` 변경은 트리거되지 않습니다. 새 dist/ 를 반영하려면 서버 터미널에서 Ctrl+C 후 재시작:

```bash
LVIS_MARKETPLACE_LOAD_DOTENV=1 \
  uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

부팅 로그:

```
bootstrap: <slug>@0.1.1 published (NNN bytes, sha256…)
```

> Windows 에서 uvicorn `--reload` 는 가끔 변경을 놓칩니다. Ctrl+C → 재실행이 더 안정적.

### 3-5. 앱에서 catalog refresh

`lvis-app` 의 마켓플레이스 탭에서 **다시 시도** 또는 새로고침 — 새 버전이 카드에 반영.

---

## 4. lvis-app 에서 install

### 4-1. 마켓플레이스 URL 등록

`lvis-app` 실행 후 → 설정 → **마켓플레이스** 탭:

| 필드 | 저장 키 | 값 |
|------|---------|----|
| 필드 | 값 |
|------|----|
| 서버 URL | `http://127.0.0.1:8000` (IPv6 회피) |
| API 키 | 비워둠. read-only catalog/download 엔드포인트는 인증 없음 |
| 사설 네트워크 허용 | **켜기** (loopback URL 이라 필수) |

> ⚠️ **URL/API key/사설 네트워크 토글 변경 모두 앱 재시작 필요**. fetcher 가 `boot.ts:248-258` 에서 한 번만 잡히므로 settings 만 바꾼다고 동적으로 갱신되지 않음. 같은 URL 에서 catalog 만 새로고침은 부트스트랩 배너의 "다시 시도" 로 충분.

### 4-2. dev 플래그 — `bun run start` vs `bun run dev`

`bun run start` (`scripts/run-electron.mjs:26-46`) 가 자동 세팅하는 env:

| env | start (자동) | dev (자동) | 효과 |
|-----|:--:|:--:|------|
| `LVIS_DEV_SKIP_SIG=1` | ✅ | ✅ | 매니페스트 서명 검증 skip |
| `LVIS_ALLOW_LINKED_PLUGIN_ENTRY=1` | ✅ | ✅ | manifest entry 가 `../node_modules/@lvis/...` 같은 링크 가리키는 것 허용 |
| `LVIS_DEV=1` | ❌ | ✅ | dev 게이트 마스터 — DevTools / hot-reload 활성화 |
| `LVIS_DEV_RELOAD=1` | ❌ | ❌ (수동) | dist/ watch + reloadPlugin |

**마켓플레이스 zip envelope 검증**: 앱 호스트가 `src/plugins/marketplace-keys.ts` 의 내장 publisher key set 으로 검증합니다. SDK 는 타입/소스 계약만 제공하고 런타임 trust root 를 소유하지 않습니다.

모든 `LVIS_*` 플래그는 `app.isPackaged === true` 일 때 hard-gate 로 무시됩니다 (`dev-flags.ts:18-54`) — packaged 빌드 누수 우려 없음.

### 4-3. 두 install 경로

**A. 마켓플레이스 탭 → 카드 → 설치**

가장 흔한 흐름 (`lvis-app/src/plugins/marketplace-installer.ts:168-328`):
1. `GET /api/v1/plugins/<slug>/versions/<version>/download` 로 zip 다운로드 — `X-Plugin-SHA256` 헤더로 sha256 전달
2. `GET /api/v1/plugins/<slug>/versions/<version>/download.sig` 로 envelope 별도 fetch
3. envelope 검증 — 키 ID 가 trust set 에 매칭되어야 통과
4. zip → `~/.lvis/plugins/<id>/` 추출 (atomic stage → swap rename)
5. `~/.lvis/plugins/registry.json` 업데이트 → `pluginRuntime.restartAll()`

**B. 딥링크 (`lvis://install/<slug>`)**

`src/main.ts:100-114` 의 slug 정규식: `/^[a-z0-9][a-z0-9._-]{0,63}$/i` (1–64자, 영숫자로 시작). query/hash 가 있으면 거절.

```bash
# macOS
open "lvis://install/<slug>"
# Linux
xdg-open "lvis://install/<slug>"   # gnome 등 desktop 에서 동작 안 하면 gio open ...
# Windows
start "lvis://install/<slug>"
```

앱이 사용자 확인 다이얼로그를 띄우고 위 A 와 동일한 install pipeline 으로 진행. 진행률은 `lvis:plugins:install-progress`, 결과는 `lvis:plugins:install-result` IPC 로 broadcast.

### 4-4. 설치 확인

`lvis-app` 가 사용하는 **플러그인 루트**:

| OS | 경로 |
|----|------|
| Windows | `%USERPROFILE%\.lvis\plugins\` |
| macOS | `~/.lvis/plugins/` |
| Linux | `~/.lvis/plugins/` |

Electron profile/userData 와 별개이며, registry 는 항상 이 루트의 `registry.json` 입니다.

```bash
# macOS/Linux 예
ls "$HOME/.lvis/plugins/<slug>/"
cat "$HOME/.lvis/plugins/registry.json"
```

부팅 로그에 `[lvis] plugin:<id> registered <N> keywords` (또는 tools 등록 로그) 가 보이면 정상.

---

## 5. 부트스트랩 동작 디테일

`lvis-marketplace/server/src/lvis_marketplace/bootstrap.py` 가 다음을 수행:

1. `_resolve_workspace_root()` 로 워크스페이스 디렉토리 결정 (§1 참고)
2. `MANAGED_SOURCES` 의 각 항목에 대해:
   - `git pull --ff-only` (30 초 타임아웃, 실패 시 working tree 사용 + 경고)
   - `package.json` 에서 `version` 읽기 → 매니페스트의 `version` 필드를 이 값으로 **강제 동기화**
   - `npm ls --omit=dev --all --parseable` 로 production node_modules 클로저 산출 (vsce 스타일)
   - **번들 대상**: `plugin.json` + `dist/**` + `worker/**` + `resources/**` + `assets/**` + filtered `node_modules/**`
   - **자동 제외** (`bootstrap.py:401-415`):
     - `dist/`, `worker/`, `resources/`, `assets/` 트리: `.map`, `.d.ts`, `__pycache__/`, `*.pyc` 제외
     - `node_modules/` 트리: `.DS_Store`, `.map` 제외 + 별도 production-dep 필터 (`npm ls --omit=dev --all --parseable` 결과 안에 든 패키지만)
     - `.bin`, `.cache`, `.vite`, `.package-lock.json` 등은 production-dep 필터에서 자연스럽게 빠지지만 별도 blacklist 가 있는 건 아님
   - **결정적(deterministic) zip**: 1980-01-01 타임스탬프, ZIP_DEFLATED (`bootstrap.py:51, 306-310`)
   - sha256 계산 → `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 모든 키로 dual-sign envelope 생성
   - storage 에 stage → atomic promote
   - `Plugin` / `PluginVersion` 행 UPSERT (`approval_state="approved"` — **새 행에만**)
3. 같은 `(slug, version)` 의 기존 행이 있고 sha256 일치하면 `latest` 포인터만 갱신, 다르면 `immutable artifact mismatch` 로 실패

> ⚠️ **bootstrap 은 새 PluginVersion 행만 `approval_state="approved"` 로 만들고, 기존 행은 손대지 않습니다**. CLI 로 publish 한 `pending_review` 행은 admin approve 또는 §7 의 DB 리셋이 필요.

graceful 동작 — 한 레포가 실패해도 나머지는 계속 시도. 단 하나라도 실패하면 최종적으로 `bootstrap_status="failed"` + `ready=false` (부트스트랩 자체는 raise → `bootstrap_on_startup` 에서 catch → False 반환). API 는 정상 부팅하지만 health 가 ready=false 를 보고하므로 일부 자동화는 실패로 인식할 수 있음.

---

## 6. MANAGED_SOURCES 에 없는 새 플러그인 테스트하기

7개 등록된 슬러그가 아닌 완전히 새 플러그인은 두 경로.

### 6-A. 로컬에서 `MANAGED_SOURCES` 에 추가 (권장)

`lvis-marketplace/server/src/lvis_marketplace/bootstrap.py` 의 `MANAGED_SOURCES` 리스트에 슬러그 추가:

```python
MANAGED_SOURCES: list[dict[str, Any]] = [
    # … 기존 7개 …
    dict(
        slug="myplugin",
        repo=_repo_path("lvis-plugin-myplugin"),
        display_name="My Plugin",
        description="새 플러그인 로컬 테스트",
        category="productivity",
        plugin_type="plugin",
        install_policy="user",       # ← admin fallback 회피하려면 명시 필수
        deployment="user",           # ← 동일
    ),
]
```

서버 재시작 → 부트스트랩 → 카탈로그 노출. enterprise prod 배포 시에는 `lvis-marketplace` 에 PR 로 등록.

### 6-B. `lvis-publish` CLI 로 ad-hoc upload (보조 경로)

git-based 부트스트랩 외에 **CLI 로 직접 zip 업로드** 경로가 prod 채널과 별개로 보조 동작합니다 — `MANAGED_SOURCES` 수정이 부담스러운 일회성 테스트에 한정.

```bash
cd lvis-marketplace/cli
npm install && npm run build
./bin/lvis-publish login --base-url http://127.0.0.1:8000

cd /path/to/lvis-plugin-myplugin
bun run build
zip -r myplugin-0.1.0.zip plugin.json dist/ icons/        # zip 루트에 plugin.json
../lvis-marketplace/cli/bin/lvis-publish publish myplugin-0.1.0.zip --slug myplugin
```

> ⚠️ **`installPolicy: "admin"` 으로 publish 하면**: (a) `approval_state="pending_review"` 로 들어가 catalog 에 노출 안 됨 (`publisher.py:381` + `catalog.py:170`), (b) **동시에 `deployment="managed"` 로도 들어감** — 매니페스트 서명(`plugin.json.sig`) 가 zip 안에 없으면 §7 의 `manifest signature missing` 시나리오와 묶여 install 시점에 또 거절됨. dev 환경에서는 (1) `installPolicy: "user"` 로 publish, (2) `lvis-publish approve <publish-id>` 로 직접 승인 (admin role 필요), 또는 (3) zip 안에 미리 서명된 `plugin.json.sig` 포함.

자세한 prod 흐름과 CLI 전체 명령은 [`marketplace-publishing.md`](./marketplace-publishing.md).

---

## 7. 자주 막히는 곳

| 증상 | 원인 / 해결 |
|------|-------------|
| 서버가 `KEYS_NOT_CONFIGURED` 같은 에러로 부팅 실패 | `LVIS_MARKETPLACE_LOAD_DOTENV=1` 누락 → .env 로드 안 됨 → 서명 키 미주입. §2-A 참고. |
| `bootstrap: <slug> repo missing, skipped: <path>` | 워크스페이스 root 아래 디렉토리명이 `MANAGED_SOURCES` 의 `repo=_repo_path(...)` 와 다름. 디렉토리명 정확히 맞추거나 `LVIS_PLUGIN_WORKSPACE_ROOT` override. |
| `<slug>@<v>: immutable artifact mismatch (existing X != rebuilt Y)` | 같은 버전인데 dist/ 내용이 바뀜. **`package.json` 버전을 올려주세요.** 또는 §7 DB 리셋. |
| `<slug>@<v>: missing build output` | `dist/` 가 비어있거나 누락. `bun run build` 가 실제로 출력했는지, `.gitignore` 가 `dist/` 를 제외하지 않았는지 확인. |
| `bootstrap: <slug> git pull failed (...) — using existing dist/` (경고만) | 정상 dev 동작. 로컬 전용 / 네트워크 끊김 / non-ff. working tree 의 dist/ 그대로 패키징. |
| `signature verification failed` (앱 install 시) | 서버 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 키 ID 와 lvis-app 호스트의 내장 trust set 이 짝 안 맞음. 현재 단일 키 모델에서는 양쪽 모두 `poc-v1` 이어야 정상. |
| `manifest signature missing` (managed install) | bootstrap.py 는 `.sig` 를 zip 에 번들하지 않음. dev 에서는 `LVIS_DEV_SKIP_SIG=1` (자동) 으로 통과. prod 에서 admin-policy managed 플러그인을 git-based 부트스트랩으로 배포하려면 별도 매니페스트 서명 파이프라인이 필요 — 현재 CLI publish 경로 또는 user-policy 가 prod 권장. |
| `tool_name namespace conflict` (publish 시) | 다른 등록 플러그인이 같은 tool 이름 등록. publisher prefix 추가 (예: `myplugin_search`). |
| 카탈로그가 비어 보임 | (a) 부트스트랩 배너 빨간색 — URL 오타 / 사설 네트워크 토글 꺼짐 / 서버 다운. (b) `localhost` 사용 시 IPv6 우선순위로 연결 실패 — 양쪽 모두 `127.0.0.1` 권장. (c) 서버 `bootstrap_status="failed"` (health 확인). |
| 딥링크 클릭해도 앱이 안 뜸 | OS 가 `lvis://` 핸들러를 다른 인스턴스에 라우팅. macOS: packaged 빌드 한 번 띄워 protocol 등록. Windows: registry `HKCR\lvis` 확인. Linux: `gio open` 시도. |
| URL/API key 변경 후에도 catalog 갱신 안 됨 | fetcher 가 boot 시 한 번만 잡히므로 **앱 재시작 필요**. "다시 시도" 는 같은 fetcher 로 catalog 만 재호출. |

### dev DB 리셋

같은 버전을 강제 재발행하거나 `pending_review` 행을 정리하려면:

```bash
cd lvis-marketplace/server
# 서버 중지 후
rm -f lvis-marketplace*.db
rm -rf storage/
uv run alembic upgrade head        # 빈 DB 재생성
# 재시작 → bootstrap 이 모든 managed 플러그인 재발행
```

---

## 8. dev 와 prod 의 차이점

| 항목 | dev (이 가이드) | prod ([marketplace-publishing.md](./marketplace-publishing.md)) |
|------|------|------|
| 마켓플레이스 URL | `http://127.0.0.1:8000` | enterprise prod URL (env 로 주입) |
| 서버 서명 키 | `poc-v1` (현 단일 정규 키) | prod 키 회전 시 서버 env 와 앱 호스트의 `marketplace-keys.ts` 를 함께 갱신 |
| `LVIS_MARKETPLACE_LOAD_DOTENV` | `1` 필수 | **금지** — 운영 환경은 secret manager 또는 정식 env 주입 |
| publish 채널 | git-based 부트스트랩 (managed) + CLI ad-hoc | 동일 (managed 는 `lvis-marketplace` PR + 서버 재배포, ad-hoc 은 CLI publish + admin approve) |
| `installPolicy: "admin"` | bootstrap 자동 approve | CLI publish 는 `pending_review` → admin approve |

prod 배포 절차 자세한 내용은 [`marketplace-publishing.md`](./marketplace-publishing.md).

---

## 9. 한 줄 정리 (managed 플러그인 dev loop)

```bash
# 플러그인 레포에서
bun run build && \
  npm version patch --no-git-tag-version && \
  git add plugin.json dist/ package.json && \
  git commit -m "test: bump"

# 마켓플레이스 서버 터미널에서 — Ctrl+C 후
LVIS_MARKETPLACE_LOAD_DOTENV=1 \
  uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000

# lvis-app — 마켓플레이스 탭 새로고침 → 새 버전 install
```

---

## 관련 문서

- [`local-plugin-development.md`](./local-plugin-development.md) — 마켓플레이스 우회 시나리오 (`~/.lvis/plugins/` 직접 복사 — 제한적)
- [`marketplace-publishing.md`](./marketplace-publishing.md) — prod 마켓플레이스 publish 절차
- [`plugin-development.md`](./plugin-development.md) — 매니페스트·HostApi·서명 깊은 레퍼런스
- `lvis-marketplace/server/src/lvis_marketplace/bootstrap.py` — git-based 부트스트랩 구현 (MANAGED_SOURCES 정의)
- `lvis-marketplace/server/README.md` — 서명 키 ID 회전, 정책 계약
