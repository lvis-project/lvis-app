# LVIS 마켓플레이스 퍼블리싱 가이드

> **상태**: Phase 2-final 적용 (2026-04-26)
> **대상**: 플러그인 / MCP 서버 퍼블리셔
> **선행 읽음**: [플러그인 개발 가이드](./plugin-development.md), [Phase 2 마켓플레이스 디자인](../blueprints/phase2-proper-marketplace-design.md)

---

## 한 줄 요약

LVIS 마켓플레이스는 **서명된 zip 단일 경로**로 운영됩니다. 퍼블리셔는 `lvis-marketplace` 서버에 git push 또는 CLI로 release하면 서버가 자동 서명·배포하고, 사용자는 LVIS 앱의 마켓플레이스 탭에서 다운로드 → 자동 설치를 수행합니다.

```
[퍼블리셔 repo] → git push → [lvis-marketplace 서버: zip 빌드 + ed25519 서명]
                                          ↓
                                  [LVIS 앱: 카탈로그 조회 → 다운로드 → 검증 → 설치]
```

---

## 목차

1. [전제 조건](#전제-조건)
2. [퍼블리셔 키 발급](#퍼블리셔-키-발급)
3. [플러그인 매니페스트 작성](#플러그인-매니페스트-작성)
4. [MCP 서버 매니페스트 작성](#mcp-서버-매니페스트-작성)
5. [로컬 검증](#로컬-검증)
6. [퍼블리시 (CLI)](#퍼블리시-cli)
7. [LVIS 앱 사이드 확인](#lvis-앱-사이드-확인)
8. [개발 환경 셋업](#개발-환경-셋업)
9. [트러블슈팅](#트러블슈팅)

---

## 전제 조건

- LVIS 마켓플레이스 서버 접근 권한 (사내: `https://marketplace.lge.internal`, 개발: `http://localhost:8000`)
- 퍼블리셔 API 키 (관리자에게 발급 요청)
- `lvis-marketplace/cli` 도구 (`uv run lvm publish ...`) — 또는 마켓플레이스 web admin UI
- ed25519 키페어 — `lvm keygen` 으로 생성 (서버가 별도로 서명하므로 클라이언트 키는 인증용)

---

## 퍼블리셔 키 발급

```bash
cd lvis-marketplace
uv run lvm keygen --label "lge-it-publisher" --role publisher
# → 출력된 API 키를 ~/.lvis/marketplace-publisher.token 에 저장
```

서버는 키 hash를 저장하고, 모든 publish 호출은 `Authorization: Bearer <key>` 헤더로 인증됩니다. 키가 유출되면 admin이 `lvm key revoke`로 즉시 무효화 가능 — 이미 게시된 버전은 영향받지 않습니다.

---

## 플러그인 매니페스트 작성

`plugin.json` 의 전체 스키마는 [플러그인 개발 가이드 §매니페스트](./plugin-development.md#플러그인-매니페스트-pluginjson) 참조. 마켓플레이스 게시 관점에서 **반드시** 챙겨야 하는 필드:

| 필드 | 비고 |
|------|------|
| `$schema` | `"https://lvis.lge.com/schemas/plugin.schema.json"` 고정 — 서버가 이 값을 보고 일반 플러그인으로 분류 |
| `id` | 마켓플레이스 카탈로그 키. 게시 후 변경 불가. flat (`agent-hub`) / 도트 (`com.lge.agent-hub`) 모두 허용 |
| `version` | semver. 서버가 `(plugin_id, version)` 유니크 제약을 강제 — 동일 버전 재업로드는 거절 |
| `tools` | LLM이 호출할 수 있는 tool 이름 배열. 다른 플러그인과 namespace 충돌 시 publish 시점에 거절 (lvis-marketplace#51) |
| `installPolicy` | `"admin"` 이면 관리형 (사용자 임의 제거 불가); `"user"` 이면 일반 사용자 설치 |
| `publisher` | 사람이 읽을 수 있는 퍼블리셔 식별자 — UI 카드에 표시 |

### 의존성

```jsonc
{
  "dependencies": [
    "lvis-plugin-shared-utils",
    { "pluginId": "lvis-plugin-calendar", "versionRange": "^1.0.0", "required": false }
  ]
}
```

서버는 의존성 그래프를 검증하지 않습니다 — 누락된 의존성은 LVIS 앱의 install 시점에 사용자에게 안내됩니다.

---

## MCP 서버 매니페스트 작성

MCP 서버는 일반 플러그인과 별개의 스키마(`mcp.schema.json`)를 사용합니다. 핵심 차이는 **`runtime` 블록**:

```jsonc
{
  "$schema": "https://lvis.lge.com/schemas/mcp.schema.json",
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

### `runtime` 필드 요약

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

**runtime 블록에는 절대 시크릿을 넣지 마세요.** 카탈로그는 공개 채널이며 어떤 자격 증명도 카탈로그에 들어가서는 안 됩니다. `auth: "api-key"` 로 표시하면 LVIS 앱이 install 시점에 사용자에게 키를 요구하고 OS keychain에 암호화 저장합니다.

---

## 로컬 검증

publish 전 매니페스트가 스키마를 통과하는지 빠르게 확인:

```bash
cd lvis-marketplace
uv run lvm validate path/to/plugin.json
# stdio MCP 의 경우
uv run lvm validate path/to/mcp-plugin.json --schema mcp
```

zip 검증 (path traversal, symlink 거절, 압축 비율 가드 등):

```bash
uv run lvm zip-validate path/to/plugin-1.0.0.zip
```

> 💡 **CI 권장**: 퍼블리셔 repo의 PR 단계에서 `lvm validate + zip-validate` 를 돌려 매니페스트 오류를 조기에 잡으세요.

---

## 퍼블리시 (CLI)

```bash
# 1. 빌드 — node 플러그인은 보통 `npm run build`, python MCP 는 `uv build` 등
npm run build

# 2. zip 패키징
zip -r my-plugin-1.0.0.zip plugin.json dist/ icons/

# 3. 마켓플레이스에 업로드 (서버가 ed25519 서명을 자동 생성)
uv run lvm publish my-plugin-1.0.0.zip \
  --base-url https://marketplace.lge.internal \
  --token "$(cat ~/.lvis/marketplace-publisher.token)"
```

서버는 다음을 수행합니다:

1. zip 검증 (`zip_validator.py`) — 절대경로/심볼릭 링크/압축 비율 거절
2. 매니페스트 추출 후 schema validation (`$schema` 값으로 plugin / mcp 분류)
3. `(plugin_id, version)` 중복 체크
4. `tools[]` namespace 충돌 검사 (다른 플러그인과 같은 tool 이름이면 거절)
5. ed25519 서명 envelope 생성 — 서버 sign-key 로 zip의 sha256 서명
6. 카탈로그에 등록 — `plugin_type ∈ ("plugin", "mcp")` 결정은 schema URI 로 자동

### 관리형 (managed) 게시

`installPolicy: "admin"` 으로 publish 한 버전은 자동으로 `pending_review` 상태로 들어갑니다. 마켓플레이스 admin UI 에서 검토 후 `approved` 로 승격해야 사용자에게 노출됩니다.

---

## LVIS 앱 사이드 확인

### 마켓플레이스 엔드포인트 설정

LVIS 앱 → 설정 → **마켓플레이스** 탭 — Phase 2-final FU (PR #258) 에서 추가됨:

- 서버 URL (예: `https://marketplace.lge.internal`)
- API 키 (선택, 서버가 인증을 요구할 때만)
- 사설 네트워크 허용 토글 (loopback/RFC1918 사용 시)

설정 변경 후 **부트스트랩 배너의 "다시 시도"** 버튼으로 재시도 가능 (앱 재시작 불필요). API 키 변경은 fetcher 재구성을 위해 앱 재시작이 필요합니다.

### 다운로드/설치 동작

1. 사용자가 마켓플레이스 탭에서 플러그인 카드 → "설치"
2. 앱이 `GET /api/v1/plugins/<slug>/versions/<version>/download` 호출
3. 서버 ed25519 envelope 검증 — 키 ID가 번들된 publisher key set 에 있는지 확인
4. zip → `userData/plugins/<id>/` 추출 (atomic stage → swap rename)
5. registry.json 업데이트 → `pluginRuntime.restartAll()`

### MCP 서버 설치 (이슈 #259, FU)

MCP 서버 marketplace install 의 consumer-side 구현은 lvis-marketplace#52 (runtime block 스키마) 위에 별도 PR 로 이어집니다. 현재는 schema 만 정의되어 있고, LVIS 앱은 `~/.lvis/mcp-servers.json` 직접 편집 경로만 동작합니다. 진행 상황은 [issue #259](https://github.com/lvis-project/lvis-app/issues/259) 참조.

---

## 개발 환경 셋업

### 1. 마켓플레이스 서버 로컬 실행

```bash
cd lvis-marketplace/server
uv sync
uv run alembic upgrade head
uv run uvicorn lvis_marketplace.main:app --reload --host 127.0.0.1 --port 8000
# 사내 인증서 등이 필요한 경우 deploy/ 디렉터리의 nginx + caddy 설정 참고
```

### 2. LVIS 앱 dev 모드

```bash
cd lvis-app
LVIS_DEV=1 bun run dev
```

| 플래그 | 효과 |
|--------|------|
| `LVIS_DEV=1` | linked entry 등 개발 전용 경로만 허용 — marketplace artifact signature 검증은 서버/호스트 경로에서 유지 |

⚠️ 모든 `LVIS_DEV*` 플래그는 `app.isPackaged === true` 일 때 hard-gate 되어 무시됩니다 ([dev-flags.ts](../../src/boot/dev-flags.ts)). packaged 빌드에 env 가 흘러들어와도 보안 약화 없음.

### 3. 첫 게시 흐름

```bash
# 1. 키 발급
uv run lvm keygen --label "dev-publisher" --role publisher

# 2. 매니페스트 검증
uv run lvm validate examples/agent-hub/plugin.json

# 3. zip 빌드 + publish
cd examples/agent-hub
zip -r agent-hub-0.1.0.zip plugin.json dist/
uv run lvm publish agent-hub-0.1.0.zip --base-url http://localhost:8000 --token <DEV_TOKEN>

# 4. LVIS 앱 마켓플레이스 탭에서 새로고침 → 카드 → 설치
```

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| `signature verification failed` 에러 | 사용자가 packaged 빌드를 사용 중인데 dev key 로 서명된 zip을 설치 시도 — 서버 prod 사인키로 재서명 후 재게시 |
| 카탈로그에 새 버전이 보이지 않음 | (a) `pending_review` 상태 — admin 승인 필요. (b) 사용자 디바이스 UUID 가 카나리 롤아웃 비대상 — `rollout_percent` 확인 |
| 부트스트랩 배너 빨간색 (`catalog fetch failed`) | (a) 마켓플레이스 URL 오타 / 서버 다운. (b) 사설 네트워크인데 toggle 안켜짐. 배너의 "다시 시도" 로 재호출 가능 |
| `plugin_integrity_rejected` audit | 설치 영수증의 파일 해시와 디스크 파일이 불일치 — 플러그인을 marketplace에서 재설치 |
| `plugin_type` 가 `"plugin"` 으로 등록됐는데 MCP 였음 | 매니페스트의 `$schema` URI 가 `mcp.schema.json` 가 아닌 `plugin.schema.json` 으로 들어감 — 매니페스트 수정 후 새 버전으로 재게시 |
| `tool_name namespace conflict` 거절 | 다른 플러그인이 이미 같은 tool 이름을 등록함 (lvis-marketplace#51 publish-time 가드) — tool 이름에 publisher prefix 추가 권장 (예: `agenthub_search`) |

---

## 관련 자료

- [플러그인 개발 가이드](./plugin-development.md) — 매니페스트 + HostApi 계약 + 빌드/테스트
- [Phase 2 마켓플레이스 디자인](../blueprints/phase2-proper-marketplace-design.md) — 서버측 단일 경로 / 단일 트러스트 루트 결정 기록
- [GitHub: Epic A — MS Graph MCP 분리](https://github.com/lvis-project/lvis-app/issues/255)
- [GitHub: Epic B — MCP Apps 호스트 구현](https://github.com/lvis-project/lvis-app/issues/256)
- [GitHub: lvis-marketplace#52 — MCP runtime 블록 스키마](https://github.com/lvis-project/lvis-marketplace/pull/52)
- [GitHub: lvis-app#259 — MCP 마켓플레이스 install consumer FU](https://github.com/lvis-project/lvis-app/issues/259)
