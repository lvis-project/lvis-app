# LVIS 마켓플레이스 퍼블리싱 가이드 (prod)

> **상태**: Phase 2-final + git-based bootstrap 반영 (2026-04-27)
> **대상**: 사내 prod 마켓플레이스에 플러그인 / MCP 서버를 게시하는 퍼블리셔
> **선행 읽음**: [플러그인 개발 가이드](./plugin-development.md), [Phase 2 마켓플레이스 디자인](../blueprints/phase2-proper-marketplace-design.md)
> **로컬 dev 루프**: 이 문서는 prod 흐름입니다. dev 환경에서 동일 흐름을 검증하려면 [`local-marketplace-testing.md`](./local-marketplace-testing.md). 마켓플레이스 우회 시나리오는 [`local-plugin-development.md`](./local-plugin-development.md).

---

## ⚡ 빠른 시작 (TL;DR)

**managed (권장)** — git-based bootstrap

1. 본인 플러그인 레포에서 `package.json` 버전 bump + `bun run build`
2. `dist/` + `plugin.json` 커밋, 메인 브랜치에 머지
3. `lvis-marketplace` 의 `MANAGED_SOURCES` 에 본 레포가 등록되어 있는지 확인 (없으면 마켓플레이스 PR 한 번 필요)
4. 마켓플레이스 서버가 다음 부팅 (또는 admin 트리거) 시 자동 publish — **zip / CLI / 사이닝 작업 불필요**

**ad-hoc** — CLI publish

```bash
cd <your-plugin-repo>
bun run build
lvis-publish \
  --marketplace-url https://marketplace.example.com \
  --api-key "$LVIS_PUBLISHER_KEY" \
  --slug my-plugin --version 1.2.3 \
  --plugin-dir .
```

`installPolicy: "admin"` 매니페스트는 publisher 키가 admin 역할이거나 admin 승인 필요.

**per-plugin CI** — git tag 가 SoT (lvis-plugin-* 레포 기본)

```bash
# 1. plugin.json 의 version 을 PR 으로 올림 (마켓플레이스 catalog 가 자동 bump 안 함)
#    예: "version": "0.1.0" → "0.1.25"
# 2. 머지 후 main 에서 매칭 SemVer tag 푸시
git checkout main && git pull
git tag v0.1.25 -m "release 0.1.25"
git push origin v0.1.25
# → 레포의 .github/workflows/publish.yml 가 tag-push 만 듣고 catalog 에 publish
#   tag semver 와 plugin.json.version 일치 검증 후 zip + POST
```

**branch push 는 publish 안 함** — 의도된 release tag 만 트리거. 이게 source 의 `plugin.json.version` 과 catalog 의 version 을 항상 일치시키는 결정적 룰. 자세한 것은 [`plugin-tool-schema-design.md` 의 version SoT 박스](../references/plugin-tool-schema-design.md#2-pluginmanifest-필드별-스펙) 참조.

**서명 키 모델**: 런타임 trust root 는 앱 호스트가 소유합니다. SDK 는 타입/소스 계약만 제공하며, 앱의 `src/plugins/marketplace-keys.ts` 와 서버 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 가 짝을 이룹니다.

상세 흐름 / 검증 / 트러블슈팅은 아래 본문 참고.

---

## 한 줄 요약

LVIS 마켓플레이스는 **두 가지 publish 채널**을 운영합니다:

1. **Git-based bootstrap (managed 플러그인 권장)**: 퍼블리셔가 자기 git 레포에 빌드 산출물(`plugin.json` + `dist/`)을 커밋 → 마켓플레이스 서버가 부팅 시 git pull → 서버 사이드에서 deterministic zip 패키징 + ed25519 서명 → DB UPSERT. **퍼블리셔는 zip 도, CLI publish 도 만들 필요 없음**. (Go 모듈 프록시 스타일)
2. **CLI publish (ad-hoc / non-managed)**: `lvis-publish` 로 사인된 zip 을 직접 업로드. 서버가 envelope 서명 후 카탈로그 등록.

```
[퍼블리셔 repo: bun build → version bump → git push (또는 commit only)]
                              ↓
[lvis-marketplace 서버: bootstrap on startup]
   git pull → deterministic zip → ed25519 dual-sign → DB UPSERT (approval_state="approved")
                              ↓
[LVIS 앱: 카탈로그 → 다운로드 → envelope 검증 → 추출]
```

---

## 목차

1. [전제 조건](#전제-조건)
2. [채널 선택: bootstrap vs CLI](#채널-선택)
3. [퍼블리셔 API 키와 서버 서명 키](#퍼블리셔-api-키와-서버-서명-키)
4. [플러그인 매니페스트 작성](#플러그인-매니페스트-작성)
5. [MCP 서버 매니페스트 작성](#mcp-서버-매니페스트-작성)
6. [채널 1 — Git-based bootstrap](#채널-1--git-based-bootstrap)
7. [채널 2 — CLI publish](#채널-2--cli-publish)
8. [LVIS 앱 사이드 확인](#lvis-앱-사이드-확인)
9. [개발 환경 셋업](#개발-환경-셋업)
10. [트러블슈팅](#트러블슈팅)

---

## 전제 조건

- LVIS 마켓플레이스 서버 접근 권한 (사내 prod URL 은 운영팀에 문의 / 로컬 dev 는 `http://127.0.0.1:8000`)
- Channel 1 (bootstrap) 사용 시: 마켓플레이스 서버가 접근 가능한 git 레포에 산출물 커밋 권한 + `lvis-marketplace` 의 `MANAGED_SOURCES` 등록 PR
- Channel 2 (CLI publish) 사용 시: 퍼블리셔 API 키 발급 (관리자에게 요청)
- `lvis-marketplace/cli` 빌드 (CLI 사용 시) — `lvis-publish` 바이너리

---

## 채널 선택

| 항목 | Channel 1 — Git Bootstrap | Channel 2 — CLI Publish |
|------|-------------------------|-------------------------|
| 권장 시점 | managed 사내 플러그인 (long-lived, 정식 등록) | ad-hoc 외부 플러그인, 단발성 게시, third-party |
| 등록 절차 | `lvis-marketplace` 서버의 `MANAGED_SOURCES` 에 슬러그 등록 PR + 운영팀 머지/배포 | 퍼블리셔 API 키 발급 → `lvis-publish login` |
| 매번 publish 작업 | git push + 서버 재배포 (또는 운영팀 트리거) | `lvis-publish publish <zip> --slug <s>` |
| 매니페스트 서명 (`plugin.json.sig`) | 현재 bootstrap 은 `.sig` 를 zip 에 번들하지 않음 → `installPolicy: "user"` 권장 (`admin` 정책은 별도 서명 파이프라인 필요) | 퍼블리셔가 zip 안에 직접 포함 가능 |
| `installPolicy: "admin"` | bootstrap 자동 `approved` | `pending_review` → admin approve 필요 |
| 검증 | 서버 부팅 로그 + LVIS 앱 마켓플레이스 탭 | `lvis-publish list/show` + 앱 탭 |

기본 권장: **사내 정식 플러그인은 Channel 1**, **외부/단발성은 Channel 2**.

---

## 퍼블리셔 API 키와 서버 서명 키

서로 다른 두 종류의 키를 혼동하지 마세요.

### A. **퍼블리셔 API 키** (인증용 — Channel 2 만 필요)

운영팀이 admin 콘솔(또는 admin API)로 발급합니다. 퍼블리셔가 직접 생성하지 않습니다.

```bash
# CLI 가 받은 키를 저장:
lvis-publish login --base-url https://<your-marketplace-host>
# → 프롬프트로 API key 입력
# → ~/.lvis/marketplace-cli.json (mode 0600) 에 저장
```

`lvis-marketplace/cli/src/lib/config.ts` 가 `~/.lvis/marketplace-cli.json` (mode 0o600) 으로 저장. 키 무효화는 admin 측에서 즉시 가능 — 이미 게시된 버전은 영향 없음.

### B. **서버 서명 키** (artifact 서명용 — 운영팀만)

마켓플레이스 서버가 publish 받은 모든 zip 을 ed25519 envelope 으로 자동 서명할 때 쓰는 키. 운영팀이 관리하며 일반 퍼블리셔는 다룰 일 없음.

```bash
# 운영팀의 키 생성 절차 (참고용):
cd lvis-marketplace/server
uv run python -m lvis_marketplace.keygen --key-id prod-v2 --out-file schemas/keys/prod-v2.pub
# → stderr 에 base64 private key 와 env-var block 출력
# → schemas/keys/prod-v2.pub 에 base64 공개키 저장
```

env 주입은 per-key 형식 — `MARKETPLACE_SIGNING_PRIVATE_KEY_<KEY_ID_UPPER_UNDERSCORE>`:

```
MARKETPLACE_SIGNING_PRIVATE_KEY_PROD_V2=<base64>
```

서버는 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 형태로 잡히는 모든 키로 서명합니다. 클라이언트(`lvis-app`)는 envelope 의 시그니처 중 하나라도 호스트에 내장된 publisher key set (`src/plugins/marketplace-keys.ts`) 에 매칭되면 OK. 키 회전은 서버 서명 키와 앱 호스트 trust anchor 를 함께 배포하는 방식으로 처리합니다.

**프로덕션 환경 보호**: `LVIS_ENV=production` 인 서버는 POC 키(`poc-v1` 등 공개 키 ID) 가 등록되어 있으면 부팅을 거절합니다 (`lvis-marketplace/server/src/lvis_marketplace/signing.py` 참조).

---

## 플러그인 매니페스트 작성

`plugin.json` 의 전체 스키마는 [플러그인 개발 가이드 §매니페스트](./plugin-development.md#플러그인-매니페스트-pluginjson) 참조. 마켓플레이스 게시 관점에서 **반드시** 챙겨야 하는 필드:

| 필드 | 비고 |
|------|------|
| `$schema` | `"https://${LVIS_SCHEMA_HOST}/schemas/plugin.schema.json"` — 서버가 이 값을 보고 일반 플러그인으로 분류. dev 기본 `lvis.local`, prod 빌드 시 운영팀이 `LVIS_SCHEMA_HOST=<prod-host>` 로 build-time 치환 (lvis-marketplace#54). URL 자체는 fetch 되지 않는 식별자 |
| `id` | 마켓플레이스 카탈로그 키 (manifest `id` = catalog `slug`). 게시 후 변경 불가. flat (`agent-hub`) 또는 도트 (`com.lge.agent-hub`) 모두 허용 |
| `version` | semver. 서버가 `(plugin_id, version)` 유니크 + sha256 immutability 강제 — 동일 버전 + 다른 sha256 은 거절 |
| `tools` | LLM tool 이름 배열. 다른 플러그인과 namespace 충돌 시 publish 시점 거절 |
| `installPolicy` | `"admin"` (관리형 — 사용자 임의 제거 불가) / `"user"` (사용자 직접 설치). bootstrap 채널에서 admin policy 는 §채널-선택 표 참고 |
| `publisher` | 사람이 읽는 식별자 — UI 카드에 표시 |

### 의존성 / pluginAccess

```jsonc
{
  "dependencies": [
    "lvis-plugin-shared-utils",
    { "pluginId": "lvis-plugin-calendar", "versionRange": "^1.0.0", "required": false }
  ],
  "pluginAccess": {
    "plugins": [{ "pluginId": "calendar", "tools": ["calendar_today"] }]
  }
}
```

서버는 의존성 그래프를 검증하지 않습니다 — 누락된 의존성은 LVIS 앱 install 시점에 사용자에게 안내됩니다.

---

## MCP 서버 매니페스트 작성

MCP 서버는 일반 플러그인과 별개의 스키마(`mcp.schema.json`)를 사용합니다. 핵심 차이는 **`runtime` 블록**:

```jsonc
{
  "$schema": "https://${LVIS_SCHEMA_HOST}/schemas/mcp.schema.json",
  "id": "weather-mcp",
  "name": "Weather MCP",
  "version": "1.0.0",
  "main": "dist/server.js",
  "runtime": {
    "transport": "stdio",
    "command": "node",
    "args": ["$PLUGIN_DIR/dist/server.js"],
    "env": { "WEATHER_API_BASE": "https://api.example.com" },
    "auth": "api-key"
  }
}
```

### `runtime` 필드 요약 (lvis-marketplace#52)

| 필드 | stdio | http | 설명 |
|------|-------|------|------|
| `transport` | ✅ `"stdio"` | ✅ `"http"` | 전송 방식 |
| `command` | ✅ 필수 | — | `node`, `python`, `uvx`, 또는 패키징된 실행파일 |
| `args` | 선택 | — | 호스트 치환 토큰 사용 가능: `$PLUGIN_DIR`, `$PYTHON`, `$NODE` |
| `env` | 선택 | — | 기본 env 변수. 사용자가 mcp-servers.json 에서 override 가능 |
| `url` | — | ✅ 필수 | Streamable HTTP 엔드포인트 |
| `auth` | 선택 | 선택 | `"none"` / `"api-key"` / `"sso"`. api-key/sso 는 LVIS 앱이 사용자에게 prompt |
| `allowPrivateNetworks` | — | 선택 | loopback / RFC1918 허용 (사내 배포 시) |

### 시크릿 정책

**runtime 블록에는 절대 시크릿을 넣지 마세요.** 카탈로그는 공개 채널이며 어떤 자격 증명도 카탈로그에 들어가서는 안 됩니다. `auth: "api-key"` 로 표시하면 LVIS 앱이 install 시점에 사용자에게 키를 요구하고 OS keychain 에 암호화 저장합니다.

---

## 채널 1 — Git-based bootstrap

### 1-1. `MANAGED_SOURCES` 등록

`lvis-marketplace/server/src/lvis_marketplace/bootstrap.py` 의 `MANAGED_SOURCES` 리스트에 슬러그 추가하는 PR:

```python
MANAGED_SOURCES: list[dict[str, Any]] = [
    # ... 기존 항목 ...
    dict(
        slug="myplugin",                                # plugin.json `id` 와 일치
        repo=_repo_path("lvis-plugin-myplugin"),        # 워크스페이스 root 기준 디렉토리명
        display_name="My Plugin",
        description="...",
        category="productivity",
        plugin_type="plugin",                           # "plugin" | "mcp"
        install_policy="user",                          # 명시 — 생략하면 admin 으로 fallback
        deployment="user",                              # 명시 — 동일
    ),
]
```

> ⚠️ `install_policy` / `deployment` 를 둘 다 생략하면 `admin`/`managed` 로 간주됩니다 (`bootstrap.py:643-646` fallback). 의도된 admin 플러그인이 아니면 반드시 `"user"` 명시.

### 1-2. 레포에 빌드 산출물 커밋

```bash
cd lvis-plugin-myplugin
bun run build
# package.json version bump
npm version patch --no-git-tag-version

git add plugin.json dist/ package.json
git commit -m "release: v0.1.1"
git push origin main
```

> bootstrap 은 working tree 의 `dist/` 를 봅니다. 로컬에서는 commit 없이도 동작 (working tree fallback). prod 에서는 서버가 git pull 하므로 push 가 필요.

### 1-3. 서버가 패키징하는 것

`bootstrap.py:_build_plugin_zip_from_repo` 동작:

- **번들 대상**: `plugin.json` + `dist/**` + `worker/**` + `resources/**` + `assets/**` + filtered `node_modules/**` (`npm ls --omit=dev --all --parseable` 로 production closure 산출 — vsce 스타일)
- **자동 제외**: `.map`, `.d.ts`, `__pycache__/`, `*.pyc`, `node_modules/.bin`, `.cache`, `.vite`, `.package-lock.json`
- **결정성**: 1980-01-01 타임스탬프, ZIP_DEFLATED — 같은 입력은 항상 같은 sha256
- **매니페스트 동기화**: 매니페스트의 `version` 필드를 `package.json` 의 version 으로 강제 덮어쓰기

### 1-4. 서버 재배포

운영팀이 마켓플레이스 서버를 재시작하면 부트스트랩이 git pull 후 새 버전을 publish 합니다.

```
bootstrap: myplugin@0.1.1 published (123456 bytes, abcdef012345…)
```

`(plugin_id, version)` 이 같은데 sha256 이 다르면 거절:

```
myplugin@0.1.1: immutable artifact mismatch (existing 0123456789ab != rebuilt fedcba987654)
```

→ 반드시 새 버전으로 bump.

---

## 채널 2 — CLI publish

### 2-1. CLI 빌드

```bash
cd lvis-marketplace/cli
bun install                # 또는 npm install — 둘 다 동작
bun run build              # → ./bin/lvis-publish
npm link                   # 선택 — 전역 등록 (bun 은 link subcommand 가 다름)
```

### 2-2. 인증

```bash
lvis-publish login --base-url https://<your-marketplace-host>
# API key 입력 (운영팀에서 발급받은 값)
lvis-publish status        # 서버 health + login state 출력
```

### 2-3. zip 빌드 + publish

```bash
cd lvis-plugin-myplugin
bun run build

# zip 루트에 plugin.json 위치해야 함 — 서브폴더 들어가면 거절
zip -r myplugin-0.1.0.zip plugin.json dist/ icons/
# 서명을 했다면
zip -r myplugin-0.1.0.zip plugin.json plugin.json.sig dist/ icons/

lvis-publish publish myplugin-0.1.0.zip --slug myplugin
# 서버 응답 예: { "plugin_id": 7, "version": "0.1.0", "sha256": "abc..." }
```

### 2-4. CLI 전체 명령

```
lvis-publish login                                  # base URL + API key 저장
lvis-publish logout                                 # ~/.lvis/marketplace-cli.json 삭제
lvis-publish status                                 # health + login state
lvis-publish list [--json]                          # 카탈로그 목록
lvis-publish show <slug> [--json]                   # 플러그인 상세
lvis-publish publish <zip> --slug <slug>            # zip 업로드
                                  [--base-url <url>]    # 저장된 값 override
                                  [--key <key>]         # 저장된 API 키 override
                                  [--json]
lvis-publish yank <slug> <version> [--json]         # admin: 버전 회수
lvis-publish approve pending [--json]               # admin: 대기 목록
lvis-publish approve <publish-id> [--json]          # admin: 승인
lvis-publish reject <publish-id> --reason <text> [--json]  # admin: 거절
```

> ⚠️ **로컬 dev 검증 도구 없음**. `lvm validate` / `lvm zip-validate` 같은 매니페스트 / zip 검증 CLI subcommand 는 현재 존재하지 않습니다. publish 직전 검증은 (a) 매니페스트 unit 테스트 (`bun run test` — SDK 의 `validate-manifest`), (b) `lvis-publish publish` 의 client-side guard (.zip 매직, 50 MB 상한), (c) 서버 측 `zip_validator` (path traversal / symlink / 압축비 / max uncompressed size). publish 후 거절되면 [트러블슈팅](#트러블슈팅) 참고.

### 2-5. 서버가 publish 시 검증하는 것

1. zip 매직 + 50 MB 상한
2. `zip_validator` — 절대경로/심볼릭 링크/압축 비율 거절
3. 매니페스트 추출 후 schema validation (`$schema` 값으로 plugin / mcp 분류)
4. `(plugin_id, version)` 중복 + sha256 immutability
5. `tools[]` namespace 충돌 검사 (lvis-marketplace#51)
6. ed25519 envelope 생성 — 서버 sign-key 들로 dual-sign
7. 카탈로그 등록 — `installPolicy: "admin"` 이면 `approval_state="pending_review"`, 아니면 `"approved"`

### 2-6. 관리형 (managed) 게시

`installPolicy: "admin"` 으로 publish 한 버전은 `pending_review` 상태로 들어가 카탈로그에 노출되지 않습니다. admin 이 `lvis-publish approve <publish-id>` (또는 admin UI) 로 승격해야 사용자에게 보입니다. dev 환경에서 빠르게 테스트하려면 `installPolicy: "user"` 로 publish 하거나 직접 approve.

### 2-7. Per-plugin CI publish (git tag SoT)

`lvis-plugin-*` 레포는 `lvis-publish` CLI 를 직접 호출하는 대신 자체 `.github/workflows/publish.yml` 가 마켓플레이스 API 를 호출하도록 구성되어 있습니다. **트리거는 SemVer git tag (`v*.*.*`) 푸시뿐** — branch push 는 publish 안 함. 워크플로우는:

1. tag 의 semver (`v0.1.25` → `0.1.25`) 와 `plugin.json.version` 일치를 fail-fast 검증
2. mismatch (e.g. `plugin.json.version: "0.1.0"` + tag `v0.1.25`) → step 실패 + "bump plugin.json on main BEFORE pushing the tag" 에러
3. 일치하면 `dist/ + plugin.json` zip 으로 묶어 `POST /api/v1/plugins/<slug>/versions` (`-F commit_hash=<sha>`)
4. 201 → publish 성공, 409 (already exists) → idempotent skip (warning), 그 외 → fail

**version SoT 룰** ([`plugin-tool-schema-design.md` 참조](../references/plugin-tool-schema-design.md#2-pluginmanifest-필드별-스펙)):

- 마켓플레이스 backend 는 version 을 자동 bump 하지 않음
- 플러그인 저자가 release 의도 시 plugin.json 을 PR 으로 올림 → main 머지 → 매칭 tag 푸시
- 결과: source manifest 와 catalog version 항상 일치, 사이드로드 (`Settings → 로컬 폴더에서 설치`) 와 마켓플레이스 install 결과 byte-equivalent

**release 절차 예시 (work-proactive 0.1.25)**:

```bash
cd lvis-plugin-work-proactive
# (a) plugin.json 의 version 을 0.1.25 로 PR
git checkout -b release/0.1.25
node -e 'const m=require("./plugin.json"); m.version="0.1.25"; require("fs").writeFileSync("plugin.json", JSON.stringify(m,null,2)+"\n")'
git commit -am "chore(release): 0.1.25"
git push origin release/0.1.25
# → PR 머지

# (b) main 으로 가서 tag 푸시
git checkout main && git pull
git tag v0.1.25 -m "release 0.1.25"
git push origin v0.1.25
# → publish.yml 가 tag-push 만 listen 해서 트리거됨
```

> 이전 동작 (참고용 — deprecated): `bump_version.py` 가 catalog 의 latest version + 1 으로 plugin.json 을 in-place rewrite 한 뒤 publish. CI workdir 안에서만 일어나서 source 는 stale 한 채 catalog 만 진행 → 사이드로드한 플러그인에 false-positive "업데이트 있음" 배너. tag-as-SoT 도입으로 근본 해결.

---

## LVIS 앱 사이드 확인

### 마켓플레이스 엔드포인트 설정

LVIS 앱 → 설정 → **마켓플레이스** 탭:

| 필드 | 값 |
|------|----|
| 서버 URL | prod URL (`https://marketplace.lvisai.xyz`) 또는 운영팀이 안내한 사내 URL |
| API 키 | 보통 빈 값 — read-only catalog/download 엔드포인트는 인증 없음 |
| 사설 네트워크 허용 | loopback/RFC1918 서버를 사용할 때만 켬 |

> URL/API key/사설 네트워크 토글 변경은 모두 **앱 재시작 필요** (fetcher 가 boot.ts 에서 한 번만 잡힘). 같은 URL 에서 catalog refresh 만 원하면 부트스트랩 배너의 "다시 시도".

### 다운로드/설치 동작

1. 사용자가 마켓플레이스 탭에서 플러그인 카드 → "설치"
2. 앱이 `GET /api/v1/plugins/<slug>/versions/<version>/download` 호출, `X-Plugin-SHA256` 헤더로 sha256 받음
3. `GET /api/v1/plugins/<slug>/versions/<version>/download.sig` 로 envelope 별도 fetch
4. envelope 검증 — 키 ID 가 앱 호스트의 내장 publisher key set 에 매칭되어야 통과
5. **검증된 tarball atomic write→rename**: `writeFile(tmpPath) + rename(tmpPath, tarballPath)` (`marketplace-installer.ts:298-312`) — 이 단계에서는 zip 이 verified-cache 위치(`tarballPath`)에만 안전하게 자리잡습니다
6. 이어서 install/registry 단계가 `~/.lvis/plugins/<id>/` 로 추출, `~/.lvis/plugins/registry.json` 업데이트 → `pluginRuntime.restartAll()`

### MCP 서버 install (lvis-app#267)

MCP 서버 마켓플레이스 install 의 consumer-side 구현은 **2026-04 시점 머지 완료** (`src/mcp/mcp-marketplace-install.ts`). 카탈로그에서 MCP 카드 → 설치 시 앱이 zip 다운로드 → envelope 검증 → 추출 → `mcp-servers.json` 자동 등록까지 수행. 사용자 수동 편집 불요.

`runtime.auth = "api-key"` / `"sso"` 인 경우 install 직후 LVIS 앱이 사용자에게 prompt 후 OS keychain 에 저장합니다.

---

## 개발 환경 셋업

prod publish 절차를 dev 에서 검증하려면 [`local-marketplace-testing.md`](./local-marketplace-testing.md) 참고. 핵심만 요약:

```bash
# 1) 서버 (LVIS_MARKETPLACE_LOAD_DOTENV=1 필수 — main.py:12-17)
cd lvis-marketplace/server
uv sync && cp .env.example .env && uv run alembic upgrade head
LVIS_MARKETPLACE_LOAD_DOTENV=1 \
  uv run uvicorn lvis_marketplace.main:create_app --factory --reload --host 127.0.0.1 --port 8000

# 2) lvis-app
cd ../lvis-app
bun run start
# 또는: bun run dev   (LVIS_DEV=1 + hot-reload + DevTools 자동)
```

마켓플레이스 서명 키는 앱 호스트의 내장 trust set 이 검증합니다. SDK 에서 keys subpath 를 import 하지 않습니다.

| 플래그 | 효과 |
|--------|------|
| `LVIS_DEV=1` | dev 게이트 마스터 (linked entry, hot-reload, DevTools). `bun run dev` 가 자동 세팅. `bun run start` 는 **세팅 안 함** |
| `LVIS_DEV_SKIP_SIG=1` | 매니페스트 서명 검증 skip. unpackaged 빌드 (`start`/`dev` 모두) 자동 |
| `LVIS_DEV_RELOAD=1` | `dist/` watch + reloadPlugin (수동 export) |

⚠️ 모든 `LVIS_DEV*` / `LVIS_ALLOW_*` 플래그는 `app.isPackaged === true` 일 때 hard-gate 로 무시됩니다 (`src/boot/dev-flags.ts:18-54`). packaged 빌드에 env 가 흘러들어와도 보안 약화 없음.

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| `signature verification failed` (앱) | 서버가 zip 을 앱 호스트 trust set 밖의 키로 서명. 서버 `MARKETPLACE_SIGNING_PRIVATE_KEY_*` 와 앱 `src/plugins/marketplace-keys.ts` 를 함께 확인. |
| 카탈로그에 새 버전 안 보임 | (a) `installPolicy: "admin"` + CLI publish → `pending_review` 상태. admin approve 필요. (b) 카나리 롤아웃 비대상 — `rollout_percent` 확인. (c) bootstrap 서버 `bootstrap_status="failed"` |
| 부트스트랩 배너 빨간색 (`catalog fetch failed`) | (a) 마켓플레이스 URL 오타 / 서버 다운. (b) 사설 네트워크인데 toggle 안 켜짐. 배너 "다시 시도" 로 재호출. (c) `localhost` IPv6 우선순위 → `127.0.0.1` 권장 |
| `plugin_unsigned_user_rejected` audit | 사용자 플러그인이 서명되지 않음 + 사용자가 unsigned 허용 토글 안 켬 (Phase 1 fail-closed). 정상 마켓플레이스 경로로 재설치하거나 설정 → 플러그인 → "서명되지 않은 사용자 플러그인 허용" 토글 |
| `plugin_type="plugin"` 으로 등록됐는데 MCP 서버였음 | 매니페스트 `$schema` URI 가 `mcp.schema.json` 이 아니라 `plugin.schema.json` 으로 들어감 → 매니페스트 수정 후 새 버전 재게시 |
| `tool_name namespace conflict` (publish 시) | 다른 플러그인이 같은 tool 이름 등록. publisher prefix 추가 (예: `myplugin_search`) |
| `(plugin_id, version) duplicate` (publish 시) | 동일 버전 재업로드 차단. version bump 후 재시도 |
| `<slug>@<v>: immutable artifact mismatch (...)` (bootstrap) | 같은 버전인데 dist/ 내용 변경. bump 또는 dev DB 리셋 |
| `LVIS_MARKETPLACE_LOAD_DOTENV=1` 누락 → 서명 키 미주입 | dev 환경에서 자주 발생. 위 §개발 환경 셋업 참고 |

---

## 관련 자료

- [`local-plugin-development.md`](./local-plugin-development.md) — 마켓플레이스 우회 시나리오 (제한적)
- [`local-marketplace-testing.md`](./local-marketplace-testing.md) — **권장 dev 루프** (이 문서의 dev 버전)
- [`plugin-development.md`](./plugin-development.md) — 매니페스트 + HostApi + 빌드/테스트 깊은 레퍼런스
- [Phase 2 마켓플레이스 디자인](../blueprints/phase2-proper-marketplace-design.md) — 서버 측 단일 경로 / 단일 트러스트 루트 결정 기록
- `lvis-marketplace/server/README.md` — 서명 키 ID 회전, POC 키 정책
- `lvis-marketplace/cli/src/index.ts` — CLI 서브커맨드 SoT
