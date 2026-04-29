# LVIS Phase 2 Proper — Marketplace Design

**Status**: 📘 DESIGN ONLY (coding Phase 2 proper 다음 세션)
**Author**: Claude Opus 4.6 (LVIS 오토파일럿)
**Decision date**: 2026-04-15 KST
**Decision by**: user (ken) — 경로 β 선택 rationale: 비개발자 publisher 요구

---

## 1. Context & Goals

Phase 1 은 `MockCloudMarketplaceAdapter` 로 시작되었고 Phase 1.5 는 managed plugin guard + deployment model 을 확립했다. Phase 2 proper 에서는 **실 마켓플레이스 서버** 를 만들어 다음 요구사항을 충족한다:

1. **IT admin 이 플러그인을 사내 배포** — install 이 managed 정책과 자동 연동
2. **개발자가 아닌 사용자 (기획, 운영, 영업 등) 도 플러그인 publish 가능** — 브라우저 Web UI
3. **LVIS client 가 사내망에서만 catalog / zip 을 fetch** — 외부 노출 없음
4. **Phase 1.5 의 `MockCloudMarketplaceAdapter` 를 adapter-only 교체** — 호스트 host 코드 변경 최소화
5. **§17 corporate TLS** + **§16.2 SSO** 와 일관된 auth 모델

**Non-goals (Phase 3 이월)**:
- beta/canary channel 분리
- cross-tenant multi-org support
- external (사외) plugin ingestion
- plugin 자동 security scan (SAST / dependency audit)
- automated plugin signing (PKI)

---

## 2. Decision — 경로 β (FastAPI 서버)

7 질문에 대한 기본값 확정 (사용자 승인 2026-04-15):

| Q | 항목 | 결정 | Rationale |
|---|---|---|---|
| Q1 | 서버 호스팅 | 별도 repo `lvis-marketplace-server/`, 사내망 Linux VM 배포 | 통제 + 비개발자 UI 요구 |
| Q2 | 서버 언어 | **FastAPI (Python 3.12)** | pageindex 팀 python stack 재사용, uv 런타임 재활용, OpenAPI 자동 생성 → client 스펙 lock |
| Q3 | Auth | **MVP: API key per publisher (Bearer)** / Phase 3: SSO (newep.lge.com OIDC) passthrough | API key 로 단순하게 시작, SSO 로 성숙도 올리기 |
| Q4 | Artifact | **zip** | Phase 1.5 `MockCloudMarketplaceAdapter` 와 호환, 기존 `plugin.json` parser 재사용 |
| Q5 | Versioning + rollback | **semver 강제, single "stable" channel, server-side rollback/yank API** | Phase 3 에서 channel 분리 |
| Q6 | Publishing workflow | **Web UI 주 + CLI 보조 (동일 API)** | 비개발자 = UI, 개발자 = CLI |
| Q7 | Managed enforcement | **서버 + client 이중 (admin 이 `organization_allowed` flag + policy.json allow-list 둘 다 설정 가능)** | 방어 심층화 |

---

## 3. Server Architecture

### 3.1 Stack

- **Python 3.12** (uv managed, 기존 `lvis-app/resources/uv` 재활용 가능하지만 서버는 별도 VM 이므로 독립 설치 권장)
- **FastAPI 0.115+** (OpenAPI 자동 생성)
- **SQLite** (MVP, Phase 3 에서 PostgreSQL 로 승격)
- **Local filesystem storage** (`/var/lib/lvis-marketplace/artifacts/` — VM 볼륨)
- **uvicorn** (ASGI server)
- **pydantic v2** (request/response 검증)

이유: PostgreSQL 을 MVP 에 넣으면 DB 운영 부담 + IT 협조 필요. SQLite 는 단일 파일로 VM 1대 배포 가능, ~10,000 플러그인까지 충분.

### 3.2 Directory layout

```
lvis-marketplace-server/
├── pyproject.toml          # uv managed
├── python-requirements.lock
├── src/
│   ├── main.py             # FastAPI app entrypoint
│   ├── routes/
│   │   ├── catalog.py      # GET /catalog (LVIS client)
│   │   ├── plugins.py      # CRUD /plugins (publisher)
│   │   ├── admin.py        # POST /admin/* (IT admin)
│   │   └── health.py       # GET /health
│   ├── models/
│   │   ├── schema.py       # pydantic models
│   │   └── db.py           # SQLAlchemy models
│   ├── storage/
│   │   └── filesystem.py   # zip artifact read/write
│   ├── auth/
│   │   └── api_key.py      # Bearer token validation
│   ├── validation/
│   │   └── plugin_manifest.py  # plugin.json schema validation (Phase 1.5 spec)
│   └── db/
│       └── migrations/     # alembic (Phase 3 PostgreSQL migration용)
├── tests/
│   ├── test_catalog.py
│   ├── test_plugins_crud.py
│   ├── test_auth.py
│   └── test_managed_enforcement.py
├── deploy/
│   ├── systemd/lvis-marketplace.service
│   ├── nginx/lvis-marketplace.conf  # reverse proxy + TLS termination
│   └── README.md           # IT 팀용 배포 가이드
└── ui/                     # Web UI (Phase 2b 또는 별도 repo)
    └── (see §4.2)
```

### 3.3 API Spec (OpenAPI v3)

#### 3.3.1 LVIS Client 전용 (read-only)

```
GET /catalog
  → 200: { plugins: PluginSummary[], generatedAt: ISO8601 }
  auth: none (사내망 전제, Phase 3 에 SSO 추가)

GET /plugins/{pluginId}
  → 200: PluginDetail (모든 버전 정보)

GET /plugins/{pluginId}/versions/{version}/artifact
  → 200: application/zip stream
  (서버는 zip 을 그대로 stream, integrity check 는 client 에서 SHA256 대조)

GET /plugins/{pluginId}/versions/{version}/manifest
  → 200: application/json (plugin.json 내용)
```

`PluginSummary` shape:
```ts
{
  id: string,               // "meeting", "pageindex", etc.
  displayName: string,
  publisher: string,
  latestVersion: string,    // semver
  deployment: "managed" | "user" | "unknown",
  organizationAllowed: boolean,  // 서버측 enforcement flag
  yanked: boolean,          // true 면 client 가 install 거부
  sha256: string,           // artifact integrity
  sizeBytes: number,
  updatedAt: ISO8601,
}
```

`PluginDetail` 는 `PluginSummary` + `versions: VersionEntry[]` + `description: string` + `changelog?: string`.

#### 3.3.2 Publisher API (Bearer auth 필요)

```
POST /plugins
  body: { zip: multipart, apiKey: Bearer header }
  actions: zip 파싱 → plugin.json 검증 → semver 확인 → DB insert → filesystem 저장
  → 201: { pluginId, version, artifactUrl }
  → 400: { error: "invalid-manifest" | "invalid-semver" | "version-conflict" }

PATCH /plugins/{id}/versions/{v}
  body: { yanked?: boolean, changelog?: string }
  → 200: updated entry

DELETE /plugins/{id}
  (삭제는 admin only — §3.3.3 참조)
```

Publisher 권한 체크: API key 는 각 publisher 에 바인딩된 `pluginId` prefix 또는 individual plugin scope. admin 만 다른 publisher 의 plugin 수정 가능.

#### 3.3.3 Admin API (IT admin only, higher-tier Bearer)

```
POST /admin/plugins/{id}/rollback
  body: { targetVersion: string }
  action: latest pointer 를 targetVersion 으로 변경
  → 200

POST /admin/plugins/{id}/organization-allowed
  body: { allowed: boolean }
  action: catalog 노출 여부 토글 (false 면 LVIS client 가 목록에서 제외)
  → 200

POST /admin/plugins/{id}/deployment
  body: { deployment: "managed" | "user" }
  action: managed 승격 / 강등
  → 200

DELETE /admin/plugins/{id}
  action: 전체 플러그인 + 모든 버전 삭제
  → 204

POST /admin/api-keys
  body: { publisher: string, pluginId?: string, expiresAt?: ISO8601 }
  → 201: { apiKey: string (one-time display) }
```

### 3.4 Database schema (SQLite)

```sql
-- Core plugin registry
CREATE TABLE plugins (
  id                   TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  publisher            TEXT NOT NULL,
  description          TEXT,
  deployment           TEXT NOT NULL CHECK(deployment IN ('managed','user','unknown')),
  organization_allowed INTEGER NOT NULL DEFAULT 1,
  latest_version       TEXT NOT NULL,  -- semver
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- Version history
CREATE TABLE plugin_versions (
  plugin_id   TEXT NOT NULL,
  version     TEXT NOT NULL,             -- semver
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  artifact_path TEXT NOT NULL,           -- 서버 로컬 filesystem 경로
  manifest_json TEXT NOT NULL,           -- plugin.json 전체 내용
  changelog   TEXT,
  yanked      INTEGER NOT NULL DEFAULT 0,
  published_by TEXT NOT NULL,            -- API key 의 publisher 이름
  published_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
);

-- API keys
CREATE TABLE api_keys (
  key_hash    TEXT PRIMARY KEY,          -- SHA256 of raw key (stored only hashed)
  publisher   TEXT NOT NULL,
  scope       TEXT,                      -- JSON: { plugins: ['meeting'] } or null=all
  tier        TEXT NOT NULL,             -- 'publisher' | 'admin'
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT
);

-- Audit log (append-only)
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  action     TEXT NOT NULL,              -- 'publish','yank','rollback','delete','org-allowed-toggle'
  actor      TEXT NOT NULL,              -- publisher name or 'admin'
  plugin_id  TEXT,
  version    TEXT,
  details    TEXT                        -- JSON
);
```

### 3.5 Storage layout

```
/var/lib/lvis-marketplace/
├── marketplace.db          # SQLite
└── artifacts/
    ├── meeting/
    │   ├── 1.0.0.zip
    │   ├── 1.0.1.zip
    │   └── 1.1.0.zip
    ├── pageindex/
    │   └── ...
    └── email/
        └── ...
```

`artifact_path` in DB = `meeting/1.0.0.zip` (relative). Server 설정 `ARTIFACT_ROOT=/var/lib/lvis-marketplace/artifacts`.

권한: systemd unit 이 `lvis-marketplace` user 로 실행. artifacts/ 는 `0750` (user read/write, group read, world none). marketplace.db 는 `0640`.

### 3.6 Deployment

**VM requirements (IT 협조)**:
- CPU: 2 vCPU
- RAM: 4 GB
- Disk: 50 GB (artifacts 성장 고려)
- OS: Ubuntu 22.04 LTS or RHEL 9
- Network: 사내망 only, outbound HTTPS 불필요 (self-contained)

**설치 절차 (systemd unit)**:
```
1. useradd lvis-marketplace
2. mkdir -p /var/lib/lvis-marketplace/artifacts
3. chown -R lvis-marketplace:lvis-marketplace /var/lib/lvis-marketplace
4. uv python install 3.12
5. uv venv /opt/lvis-marketplace/venv
6. uv pip sync python-requirements.lock
7. systemctl enable --now lvis-marketplace
```

**nginx reverse proxy (사내 도메인)**:
- `https://marketplace.lvis.internal.lge.com` → `127.0.0.1:8080`
- TLS cert: LGE internal CA 서명 (IT 발급)
- Client max body size: 100 MB (artifact upload 상한)

---

## 4. Client Adapter Design

### 4.1 `RealCloudMarketplaceAdapter` (`lvis-app/src/plugin-runtime/real-marketplace-adapter.ts`)

Phase 1.5 의 `MockCloudMarketplaceAdapter` 를 교체. 동일한 interface 구현:

```ts
interface MarketplaceAdapter {
  list(): Promise<PluginSummary[]>;
  fetch(pluginId: string, version?: string): Promise<{ manifest: PluginManifest; zipPath: string }>;
  verify(zipPath: string, expectedSha256: string): Promise<boolean>;
}

class RealCloudMarketplaceAdapter implements MarketplaceAdapter {
  constructor(private baseUrl: string, private apiKey?: string) {}

  async list() {
    const res = await fetch(`${this.baseUrl}/catalog`);
    return (await res.json()).plugins;
  }

  async fetch(pluginId: string, version = "latest") {
    // 1. GET manifest
    const manifestRes = await fetch(`${this.baseUrl}/plugins/${pluginId}/versions/${version}/manifest`);
    const manifest = await manifestRes.json();
    // 2. GET zip → stream to temp file
    const zipRes = await fetch(`${this.baseUrl}/plugins/${pluginId}/versions/${version}/artifact`);
    const tmpPath = path.join(os.tmpdir(), `${pluginId}-${version}.zip`);
    await fs.writeFile(tmpPath, Buffer.from(await zipRes.arrayBuffer()));
    // 3. Integrity check
    const actualSha = await this.sha256(tmpPath);
    if (actualSha !== manifest.sha256) throw new Error("integrity-check-failed");
    return { manifest, zipPath: tmpPath };
  }
}
```

기존 `MockCloudMarketplaceAdapter` 는 test fixtures 용도로 유지 (`__tests__/fixtures/` 로 이동), production 경로는 `RealCloudMarketplaceAdapter`.

### 4.2 Config

`~/.lvis/marketplace.config.json`:
```json
{
  "baseUrl": "https://marketplace.lvis.internal.lge.com",
  "apiKey": null,
  "timeoutMs": 30000
}
```

LVIS client 는 read-only 이므로 `apiKey: null` 기본. Admin policy (C2 admin-dir merge) 에서 `managedMarketplaceUrl` 필드로 override 가능:

```json
// /Library/Application Support/LVIS/policy.json
{
  "managed": true,
  "marketplace": {
    "baseUrl": "https://marketplace.lvis.internal.lge.com"
  }
}
```

### 4.3 Integration with MarketplaceService

`src/plugin-runtime/marketplace.ts` 의 `MarketplaceService` constructor 가 `adapter: MarketplaceAdapter` 인자를 받도록. 현재 `MockCloudMarketplaceAdapter` 가 하드코딩되어 있다면 factory 로 분리:

```ts
function createAdapter(config: MarketplaceConfig): MarketplaceAdapter {
  if (config.useMock) return new MockCloudMarketplaceAdapter();
  return new RealCloudMarketplaceAdapter(config.baseUrl, config.apiKey);
}
```

환경변수 `LVIS_MARKETPLACE_MOCK=1` 로 dev/test 에서 mock 강제. *(future-work; not yet implemented — Round-3 1방향 정리 시 미도입 확인)*

---

## 5. Publishing Workflow

### 5.1 Web UI (`lvis-marketplace-server/ui/`)

**Stack**: React + Vite + shadcn (lvis-app renderer 와 동일 생태계). 별도 Electron 아님, 브라우저 SPA.

**페이지**:
- `/` — 로그인 (API key 입력, sessionStorage 저장)
- `/dashboard` — 내가 publish 한 플러그인 목록
- `/publish` — 신규 플러그인 업로드 (zip drag-drop + metadata form)
- `/plugins/{id}` — 특정 플러그인 상세 (버전 히스토리, yank 버튼, changelog 편집)
- `/admin` (admin tier key 일 때만) — 전체 플러그인, rollback, organization-allowed toggle, API key 관리

**비개발자 친화 설계**:
- zip 업로드 시 client-side 파싱 → plugin.json 내용을 fill-in form 으로 보여줌
- semver 자동 제안 (기존 latest version + 1)
- 미리보기: "이 플러그인이 사내망 LVIS 앱에 이렇게 보일 것입니다"
- 실패 시 Korean error message (검증 실패 사유별)

### 5.2 CLI (`lvis-marketplace` npm package)

```bash
npm install -g @lvis/marketplace-cli
lvis-marketplace config set baseUrl https://marketplace.lvis.internal.lge.com
lvis-marketplace config set apiKey $LVIS_MARKETPLACE_API_KEY
lvis-marketplace publish ./my-plugin-1.2.0.zip
lvis-marketplace yank my-plugin 1.1.0
lvis-marketplace list
```

동일 API 를 호출. CI 통합용.

---

## 6. Auth 상세

### 6.1 MVP (Phase 2 proper)

**API key** 단일 메커니즘:
- 발급: admin 이 `POST /admin/api-keys { publisher, pluginId?, tier: "publisher"|"admin" }` 로 생성
- 저장: SHA256 해시만 DB 에 저장, 원본은 발급 시 일회성 표시
- 사용: `Authorization: Bearer lvismp_<base64>` HTTP header
- 만료: `expires_at` 필드, 기본 90일
- 폐기: `revoked_at` 세팅

### 6.2 Phase 3 승격 (SSO)

**newep.lge.com OIDC passthrough**:
- LVIS client 가 OS 에 저장된 SSO refresh token 을 fetch
- marketplace server 에 `Authorization: Bearer <access_token>` 로 전달
- 서버는 token 을 newep.lge.com 에 검증 요청
- publisher 권한은 LDAP group 또는 SAML claim 으로 결정

Phase 3 승격 시에도 API key 경로는 유지 (CI 용).

### 6.3 Admin tier 분리

`tier: "admin"` API key 만 `/admin/*` 엔드포인트 접근 가능. IT 부서 에 발급, local dev 에는 dev admin key fixture.

---

## 7. Migration Plan (Phase 1.5 → Phase 2 proper)

### 7.1 Adapter swap 로드맵

1. **Pre-deploy**: `RealCloudMarketplaceAdapter` 구현 + mock 과 interface 호환 유지
2. **Server up**: IT 가 VM + nginx + LGE CA 인증서 준비, systemd 서비스 기동
3. **초기 catalog 시드**: 3개 번들 플러그인 (meeting/pageindex/email) 을 admin 이 CLI 로 publish. `deployment: "managed"` 로.
4. **LVIS client 업데이트**: `marketplace.config.json` 에 실 baseUrl 주입, next release 에 적용
5. **A/B**: `LVIS_MARKETPLACE_MOCK=1` env 로 dev/test 는 기존 mock 유지 (회귀 테스트)
6. **Sunset**: 6개월 후 mock adapter 삭제 (test fixtures 제외)

### 7.2 `MockCloudMarketplaceAdapter` 운명

- Phase 2 proper 커밋 후: `plugin-runtime/__tests__/fixtures/` 로 이동, test-only
- Production 경로에서 import 금지 (`eslint-plugin-import` no-restricted rule 추가)

---

## 8. Phase breakdown / Milestones

| Milestone | Scope | 예상 소요 | Blocker |
|---|---|---:|---|
| **M1** — Server skeleton | FastAPI + SQLite + /catalog + /plugins CRUD + API key auth | 3d | 없음 |
| **M2** — Publisher API + zip validation | plugin.json schema + semver check + filesystem storage | 2d | M1 |
| **M3** — Admin API | rollback, yank, org-allowed, key 발급 | 2d | M1 |
| **M4** — Client adapter | `RealCloudMarketplaceAdapter` + config + MarketplaceService 교체 | 2d | M1 |
| **M5** — Deploy to IT VM | systemd + nginx + LGE CA cert + 초기 catalog seed | 1d | **IT 협조 (VM 프로비저닝)** |
| **M6** — Web UI | React + shadcn + publish/dashboard/admin 페이지 | 5d | M1-M3 |
| **M7** — E2E test + smoke | vitest + pytest integration, physical publish/install cycle | 2d | M1-M6 |
| **M8** — CLI publisher | npm package + CI 템플릿 | 2d | M1-M3 |
| **M9** — Migration sunset | MockAdapter → fixtures, restricted import | 0.5d | M4-M7 |

**Total MVP (M1~M5, M7, M9)**: ~10 working days
**Full (+M6, M8)**: ~17 working days

---

## 9. Open Questions / IT 협의 필요 항목

다음 세션 coding 시작 전에 IT 에 문의:

1. **VM 프로비저닝** — 사내망 Ubuntu/RHEL VM 1대 (2 vCPU / 4 GB / 50 GB) 확보 절차, 소요 시간, 요청 양식
2. **사내 도메인 등록** — `marketplace.lvis.internal.lge.com` (또는 유사) 할당 + DNS record + LGE CA 서명 cert 발급 가능 여부
3. **nginx / systemd 권한** — LVIS 팀이 직접 운영 가능한지, IT 운영팀 관리 대상인지
4. **SSO 통합 일정** — newep.lge.com OIDC client 등록 절차, 개발자가 직접 가능한지, IT 승인 필요한지
5. **API key tier "admin" 의 발급 주체** — IT 가 발급? LVIS 팀이 발급 후 audit 제출?
6. **Audit log 보존 정책** — GDPR/회사 보안 정책상 최소 보존 기간 (1년? 3년?)
7. **artifact 크기 상한** — 서버 측 upload 제한 (기본 100 MB 제안, 적절한지 확인)
8. **backup 정책** — marketplace.db + artifacts/ 의 백업 주기, DR 전략
9. **모니터링** — 회사 표준 모니터링 (Datadog / Grafana / NewRelic?) 에 지표 emit 하는 방식
10. **플러그인 publish 권한 관리** — LDAP group 기반? 수동 발급? 팀별 sub-tenant 구조 필요?

---

## 10. Non-goals (Phase 3 이월)

- **Channel 분리** — stable / beta / canary. MVP 는 stable only.
- **Multi-tenant** — organization 구분. MVP 는 single tenant (LGE 전체).
- **Automated security scan** — plugin zip 에 대한 SAST / SBOM / dependency audit.
- **Plugin signing (PKI)** — publisher 인증서 기반 서명. API key → signature 승격.
- **External federation** — 사외 마켓플레이스 / OSS catalog 와 cross-fetch.
- **Plugin telemetry** — LVIS client 가 설치한 플러그인의 usage 를 서버로 보고.
- **Publisher profile / social features** — 평점, 리뷰, popularity ranking.
- **Real-time sync** — SSE/WebSocket 기반 live catalog update.

---

## 11. Next Session Start Point

다음 세션에서 이 문서 하나 읽고 coding 시작하려면:

1. **M1 먼저** — `lvis-marketplace-server/` 신규 repo 생성, `pyproject.toml` + FastAPI skeleton + SQLite init + 첫 route `GET /catalog` (빈 array 반환) + pytest smoke
2. 그 다음 `TODO.md §20` 를 살아있는 tracker 로 활용
3. M5 (IT 협조) 는 §9 질문 답변이 도착하기 전엔 블로킹되므로, M1~M4, M6, M8 을 먼저 병렬 진행
4. Auth API key tier "admin" 은 초기엔 env 변수 `LVIS_MARKETPLACE_ADMIN_KEY` 로 단일 하드코딩 → M3 에서 DB 기반 로테이션 승격

**작성자**: Claude Opus 4.6 (LVIS 오토파일럿)
**작성일**: 2026-04-15 KST
