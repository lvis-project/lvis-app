# 로컬 마켓플레이스로 플러그인 테스트하기

> **대상**: 사내 prod 마켓플레이스에 올리기 전, **end-to-end 마켓플레이스 흐름**(서버 부트스트랩 → 카탈로그 노출 → 앱 install)이 잘 도는지 로컬에서 검증하고 싶은 플러그인 개발자.
>
> **이 문서가 다루는 범위**: 로컬 `lvis-marketplace` 서버 띄우기 → 플러그인 git 레포에서 빌드/버전 bump → 서버가 자동으로 카탈로그에 등록 → `lvis-app` 에서 install. 마켓플레이스 없이 그냥 사이드로드만 하려면 [`local-plugin-development.md`](./local-plugin-development.md). prod 카탈로그 publish 절차는 [`marketplace-publishing.md`](./marketplace-publishing.md).

---

## 한 줄 요약 — 배포 모델

LVIS 마켓플레이스는 **git-based publish**입니다. Go 모듈 프록시처럼, 서버가 등록된 플러그인 git 레포를 직접 풀(pull)하고 packaging/signing 까지 서버 사이드에서 수행합니다. **개발자는 zip 을 만들 필요도, CLI 로 업로드할 필요도 없습니다.**

```
[plugin git repo: bun run build → package.json version bump → push]
                              ↓
[lvis-marketplace server: bootstrap on startup]
   git pull --ff-only → plugin.json + dist/ + prod node_modules → 결정적 zip → ed25519 서명 → DB UPSERT
                              ↓
[lvis-app: catalog refresh → 카드 → install]
   서버에서 zip 다운로드 → envelope 검증 → 추출 → registry 등록
```

> 서버가 만드는 zip 은 클라이언트 전송 포맷일 뿐, 개발자 산출물이 아닙니다. 서명도 서버가 합니다 (`MARKETPLACE_SIGNING_PRIVATE_KEY_*` 키들).

---

## 등록된 managed 플러그인

`bootstrap.py` 의 `MANAGED_SOURCES` 에 하드코딩된 7개:

| slug | 레포 디렉토리명 | install policy |
|------|------------------|----------------|
| `meeting` | `lvis-plugin-meeting` | user |
| `pageindex` | `lvis-plugin-pageindex` | admin (managed) |
| `email` | `lvis-plugin-email` | user |
| `calendar` | `lvis-plugin-calendar` | user |
| `lge-api` | `lvis-plugin-lge-api` | admin (managed) |
| `work-proactive` | `lvis-plugin-work-proactive` | user |
| `agent-hub` | `lvis-plugin-agent-hub` | user |

이 7개 중 하나를 수정하고 있다면 — 별다른 등록 없이 바로 §3 의 "내 플러그인 변경 → 카탈로그 반영" 루프로 진입하면 됩니다.

새 플러그인(목록에 없음) 테스트 방법은 §6 참고.

---

## 1. 워크스페이스 레이아웃

서버는 `LVIS_PLUGIN_WORKSPACE_ROOT` 환경변수가 가리키는 디렉토리(미설정 시 `lvis-marketplace` 의 부모) 아래에서 **하드코딩된 디렉토리명**(예: `lvis-plugin-lge-api`)으로 레포를 찾습니다.

권장 레이아웃 (이 워크스페이스 그대로):

```
lvis-project/
├── lvis-app/
├── lvis-marketplace/         ← 서버
├── lvis-plugin-meeting/      ← bootstrap 이 git pull 대상으로 인식
├── lvis-plugin-pageindex/
├── lvis-plugin-email/
├── lvis-plugin-calendar/
├── lvis-plugin-lge-api/
├── lvis-plugin-work-proactive/
└── lvis-plugin-agent-hub/
```

7개 중 일부만 있어도 OK — 없는 것은 부트스트랩 시 `repo missing, skipped` 로그만 남기고 그 외 진행. 다른 위치에 있다면:

```bash
LVIS_PLUGIN_WORKSPACE_ROOT=/path/to/your/workspace uv run uvicorn ...
```

---

## 2. 마켓플레이스 서버 로컬 실행

```bash
cd lvis-marketplace/server
uv sync
cp .env.example .env                        # SQLite + dev-v1 키 기본값으로 충분
uv run alembic upgrade head
uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

부팅 로그에서 **bootstrap 라인을 확인**하세요:

```
bootstrap: meeting@1.0.0 unchanged — preserving existing artifact
bootstrap: lge-api@0.1.0 published
bootstrap: pageindex repo missing, skipped: /.../lvis-plugin-pageindex
```

확인:

```bash
curl -s http://localhost:8000/api/v1/health | jq
# { "status": "ok", "ready": true, "bootstrap_status": { "published": 4, "failures": [...] } }

curl -s http://localhost:8000/api/v1/catalog | jq '.plugins[] | {slug, latest_stable_version}'
```

### 핵심 환경변수

| 변수 | 기본 | 메모 |
|------|------|------|
| `LVIS_MARKETPLACE_STORAGE_DIR` | `./storage` | 부트스트랩이 만든 zip + 서명 envelope 저장소 |
| `LVIS_MARKETPLACE_DB_PATH` | `./lvis-marketplace.db` | SQLite. Postgres 사용 시 무시 |
| `LVIS_PLUGIN_WORKSPACE_ROOT` | (자동 탐지) | 위 §1 참고 |
| `LVIS_MARKETPLACE_SKIP_BOOTSTRAP` | 미설정 | `1` 이면 부트스트랩 자체 skip — 서버를 빠르게 띄우고 기존 DB 만 보고 싶을 때 |
| `LVIS_SCHEMA_HOST` | `lvis.local` | 매니페스트 `$schema` URI 호스트. 로컬에서는 기본값 그대로 |
| `MARKETPLACE_SIGNING_PRIVATE_KEY_DEV_V1` | `.env.example` 에 dev 값 | 서버가 zip sha256 을 서명할 키. 여러 키를 동시에 등록하면 모두로 dual-sign |

서버는 `MARKETPLACE_SIGNING_PRIVATE_KEY_<KEY_ID>` 형태로 잡히는 **모든 키로 dual-sign** 합니다. 클라이언트는 envelope 의 시그니처 중 하나라도 자기가 신뢰하는 publisher key set 에 매칭되면 OK.

---

## 3. 내 플러그인 변경 → 카탈로그 반영

managed 7개 중 하나를 작업하는 경우 — 한 사이클은 다음과 같습니다.

### 3-1. 플러그인 레포에서 빌드

```bash
cd lvis-plugin-<your-managed-slug>
bun install
bun run build           # → dist/ 갱신. 서버는 dist/ 가 커밋되어 있을 거라 가정.
bun run test            # 권장
```

### 3-2. 버전 bump

`package.json` 의 `version` 을 올립니다 (semver). 서버가 이 값을 읽어서 `PluginVersion` 행을 만듭니다.

```bash
# 패치 bump 예
npm version patch --no-git-tag-version
# 또는 직접 편집
```

> ⚠️ **동일 버전 재발행 불가**. 서버는 `(plugin_id, version)` 유니크 + 같은 버전 재빌드 시 sha256 비교까지 해서 mismatch 면 `immutable artifact mismatch` 로 거절합니다. dist/ 내용을 바꿨으면 반드시 버전을 올리세요. (DB 리셋은 §7)

### 3-3. 커밋

```bash
git add plugin.json dist/ package.json
git commit -m "chore: bump to 0.1.1"
# git push 는 선택. 서버는 working tree 를 봅니다 — push 가 없으면 git pull 단계가
# "using existing dist/" 경고만 남기고 통과.
```

### 3-4. 서버 부트스트랩 재실행

부트스트랩은 **서버 시작 시점에만** 돌므로 서버를 재시작합니다 (`--reload` 모드라도 코드 수정이 아닌 외부 git/dist 변화는 트리거되지 않음).

```bash
# 서버 터미널에서 Ctrl+C 후
uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

부팅 로그에 새 버전이 보여야 합니다:

```
bootstrap: <slug>@0.1.1 published
```

### 3-5. 앱에서 catalog refresh

`lvis-app` 의 마켓플레이스 탭에서 **다시 시도** 또는 새로고침 — 새 버전이 카드에 반영됩니다.

---

## 4. lvis-app 에서 install

### 4-1. 마켓플레이스 URL 등록

`lvis-app` 실행 후 → 설정 → **마켓플레이스** 탭:

| 필드 | 값 |
|------|----|
| 서버 URL | `http://localhost:8000` |
| API 키 | (로컬 dev 서버는 비워둬도 됨) |
| 사설 네트워크 허용 | **켜기** (loopback URL 이라 필수) |

저장 후 부트스트랩 배너의 **다시 시도** 버튼으로 catalog refresh. URL 변경은 재시도로 충분, API 키 변경은 fetcher 재구성을 위해 앱 재시작 필요.

### 4-2. dev 플래그

unpackaged 빌드는 `LVIS_DEV=1` / `LVIS_DEV_SKIP_SIG=1` 이 자동 세팅되지만, 마켓플레이스 zip 의 envelope 검증을 dev 키로 통과시키려면 추가로:

```bash
LVIS_ALLOW_TEST_MARKETPLACE_KEYS=1 bun run start
```

| 플래그 | 효과 |
|--------|------|
| `LVIS_DEV=1` | dev 게이트 활성화 (자동) |
| `LVIS_DEV_SKIP_SIG=1` | **매니페스트** 서명 검증 skip (자동). zip envelope 검증은 별개. |
| `LVIS_ALLOW_TEST_MARKETPLACE_KEYS=1` | 번들된 publisher key set 에 `dev-v1`/`poc-v1` 같은 **테스트 키 포함**. 서버가 dev 키로 서명한 zip envelope 를 받아들이려면 필수. |

모든 `LVIS_*` 플래그는 `app.isPackaged === true` 일 때 hard-gate — packaged 빌드 누수 우려 없음.

### 4-3. 두 install 경로

**A. 마켓플레이스 탭 → 카드 → 설치**

가장 흔한 흐름. 앱이:
1. `GET /api/v1/plugins/<slug>/versions/<version>/download` 로 zip 다운로드
2. ed25519 envelope 검증 — 키 ID 가 trust set 에 매칭되어야 통과
3. zip → `userData/plugins/<id>/` 추출 (atomic stage → swap rename)
4. `registry.json` 업데이트 → `pluginRuntime.restartAll()`

**B. 딥링크 (`lvis://install/<slug>`)**

OS 가 `lvis://` 핸들러를 등록한 상태에서:

```bash
# macOS
open "lvis://install/<slug>"
# Linux
xdg-open "lvis://install/<slug>"
# Windows
start "lvis://install/<slug>"
```

앱이 사용자 확인 다이얼로그를 띄우고 위 A 와 동일한 install pipeline 으로 진행. 진행률은 `lvis:plugins:install-progress`, 결과는 `lvis:plugins:install-result` IPC 로 broadcast.

### 4-4. 설치 확인

```bash
ls ~/.lvis/plugins/user/<slug>/         # 추출된 디렉토리 (또는 userData 경로)
cat ~/.lvis/plugins/registry.json       # 항목 추가됐는지
```

부팅 로그에 `plugin loaded: <id>` 가 보이고 도구가 채팅에서 호출 가능해야 정상.

---

## 5. 부트스트랩 동작 디테일 (알아두면 좋음)

`lvis-marketplace/server/src/lvis_marketplace/bootstrap.py` 가 다음을 수행:

1. `_resolve_workspace_root()` 로 워크스페이스 디렉토리 결정 (`LVIS_PLUGIN_WORKSPACE_ROOT` env 또는 자동 탐지)
2. `MANAGED_SOURCES` 의 각 항목에 대해:
   - `git pull --ff-only` (30 초 타임아웃, 실패 시 working tree 사용 + 경고)
   - `package.json` 에서 `version` 읽기
   - `npm ls --omit=dev --all --parseable` 로 production node_modules 클로저 산출 (vsce 스타일)
   - `plugin.json` + `dist/**` + `worker/**` + `resources/**` + `assets/**` + filtered `node_modules/**` 을 **결정적(deterministic) zip** 으로 패키징 (1980-01-01 타임스탬프, ZIP_DEFLATED)
   - 매니페스트의 `version` 필드를 `package.json` version 으로 강제 동기화
   - sha256 계산 → `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 모든 키로 dual-sign envelope 생성
   - storage 에 stage → atomic promote
   - `Plugin` / `PluginVersion` 행 UPSERT (`approval_state="approved"`)
3. 동기 이름이 같은 기존 버전이 있으면 sha256 비교 → 일치하면 그냥 `latest` 포인터만 갱신, 다르면 `immutable artifact mismatch` 로 실패 (이게 §3-2 의 "버전 bump 필수" 이유)

부트스트랩은 graceful — 한 레포가 깨져도 나머지 진행.

---

## 6. MANAGED_SOURCES 에 없는 새 플러그인 테스트하기

7개 등록된 슬러그가 아닌 **완전히 새로운 플러그인**은 두 가지 방법이 있습니다.

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
        install_policy="user",
        deployment="user",
    ),
]
```

서버 재시작 → 부트스트랩 → 카탈로그에 노출. 사내 prod 에 올릴 때는 `lvis-marketplace` 에 PR 로 등록.

### 6-B. `lvis-publish` CLI 직접 업로드 (ad-hoc)

git-based 부트스트랩 외에 **CLI 로 직접 zip 업로드** 경로가 보조로 남아있습니다 — `MANAGED_SOURCES` 수정이 부담스러운 일회성 테스트나, dist/ 가 git 에 안 올라간 상태에서 빠르게 시도해보고 싶을 때.

```bash
cd lvis-marketplace/cli
npm install && npm run build
./bin/lvis-publish login --base-url http://localhost:8000

cd /path/to/lvis-plugin-myplugin
bun run build
zip -r myplugin-0.1.0.zip plugin.json dist/ icons/        # zip 루트에 plugin.json
../lvis-marketplace/cli/bin/lvis-publish publish myplugin-0.1.0.zip --slug myplugin
```

이 경로는 `marketplace-publishing.md` 에서 prod 퍼블리셔용으로 더 자세히 다룹니다. 단, 일상적인 dev 루프는 6-A 가 훨씬 빠릅니다.

---

## 7. 자주 막히는 곳

| 증상 | 원인 / 해결 |
|------|-------------|
| `bootstrap: <slug> repo missing, skipped` | 워크스페이스 root 아래 디렉토리명이 `MANAGED_SOURCES` 의 `repo=_repo_path(...)` 와 다름. 디렉토리 이름 정확히 맞추거나 `LVIS_PLUGIN_WORKSPACE_ROOT` 로 override. |
| `immutable artifact mismatch — existing X != rebuilt Y` | 같은 버전인데 dist/ 내용이 바뀜. **`package.json` 버전을 올려주세요.** 또는 dev DB 리셋 (§아래). |
| `bootstrap: <slug>@<v>: missing build output` | `dist/` 가 비어있거나 누락. `bun run build` 가 실제로 출력했는지, `.gitignore` 가 `dist/` 를 빼버리지 않았는지 확인. |
| `git pull failed — using existing dist/` (경고만) | 정상. 로컬 전용 작업이거나 origin 미설정/네트워크 끊김. working tree 의 dist/ 가 그대로 패키징됨. |
| `signature verification failed` (앱 install 시) | (a) `LVIS_ALLOW_TEST_MARKETPLACE_KEYS=1` 누락. (b) 서버의 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 키 ID 와 lvis-app 의 trust set 이 안 맞음. SDK 의 `MARKETPLACE_PUBLIC_KEYS` 와 keys/dev-v1.pub 등이 짝인지 확인. |
| `manifest signature missing` (managed install) | `installPolicy: "admin"` 인데 매니페스트 서명(`plugin.json.sig`)이 zip 에 없음. dev 에서는 `LVIS_DEV_SKIP_SIG=1` (자동), prod 에서는 `sign-manifest.mjs` 로 서명 후 dist/ 옆에 커밋. |
| `tool_name namespace conflict` (publish 시) | 다른 등록 플러그인이 같은 tool 이름을 이미 등록. publisher prefix 추가 (예: `myplugin_search`). |
| 카탈로그가 비어 보임 | (a) 부트스트랩 배너 빨간색 — URL 오타 / 사설 네트워크 토글 꺼짐 / 서버 다운. (b) `LVIS_MARKETPLACE_HOST=127.0.0.1` 인데 앱 설정은 `localhost` — IPv6 가 끼어들기 쉬움. 양쪽 모두 `127.0.0.1` 로 통일 권장. |
| 딥링크 클릭해도 앱이 안 뜸 | OS 가 `lvis://` 핸들러를 다른 인스턴스에 라우팅. macOS 는 packaged 빌드를 한 번 띄워 protocol 등록, Windows 는 `HKCR\lvis` 레지스트리 확인. |

### dev DB 리셋

같은 버전을 강제로 다시 publish 하고 싶거나 상태를 초기화하려면:

```bash
cd lvis-marketplace/server
# 서버 중지 후
rm -f lvis-marketplace*.db
rm -rf storage/
uv run alembic upgrade head        # 빈 DB 재생성
# 다시 uv run uvicorn ... → 부트스트랩이 모든 managed 플러그인 재발행
```

---

## 8. 한 줄 정리 (managed 플러그인 dev loop)

```bash
# 플러그인 레포에서
bun run build && \
  npm version patch --no-git-tag-version && \
  git add plugin.json dist/ package.json && \
  git commit -m "test: bump"

# 마켓플레이스 서버 터미널에서 — Ctrl+C 후
uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000

# lvis-app — 마켓플레이스 탭 새로고침 → 새 버전 install
```

---

## 관련 문서

- [`local-plugin-development.md`](./local-plugin-development.md) — 마켓플레이스 없이 사이드로드만으로 dev 루프 돌리기
- [`marketplace-publishing.md`](./marketplace-publishing.md) — prod 마켓플레이스 publish 절차 (lvis-publish CLI 보조 경로 포함)
- [`plugin-development.md`](./plugin-development.md) — 매니페스트·HostApi·서명 깊은 레퍼런스
- `lvis-marketplace/server/src/lvis_marketplace/bootstrap.py` — git-based 부트스트랩 구현 (MANAGED_SOURCES 정의)
- `lvis-marketplace/server/README.md` — 서명 키 ID 회전, 정책 계약
