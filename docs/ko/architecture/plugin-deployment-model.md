# Plugin Deployment Model — Managed vs User-Installed

**Status**: Phase 1.5 ✅ COMPLETE (2026-04-14) — see `docs/blueprints/phase1.5-closure-report.md`
**Owner**: LVIS Platform Team
**Last Updated**: 2026-04-13
**Related**: `docs/architecture/architecture.md` §9.6, §14.2 Policy Enforcement, §6.3 Tool Permission Model

---

## 1. 문제 정의

LVIS는 개인 데스크톱에서 실행되는 AI 비서이며, 플러그인 생태계를 지원한다. 현재(Phase 1)까지는 모든 플러그인이 **동일한 lifecycle과 동일한 권한**으로 관리되어, 조직 정책으로 강제 배포해야 하는 플러그인(예: 내부 HR 통합, 보안 인덱서)과 사용자가 자율적으로 설치하는 플러그인(예: 개인 Notion, 습관 추적기)이 구분되지 않는다.

이는 다음 네 가지 실질적 문제를 낳는다:

1. **강제 배포 불가** — IT 부서가 새 버전을 push해도 사용자가 재부팅하기 전에 적용되지 않으며, 사용자가 수동으로 disable할 수 있다.
2. **삭제 권한 오남용** — 사용자가 보안 플러그인(예: DLP 스캐너)을 임의로 제거할 수 있다.
3. **긴급 대응 불가** — 특정 플러그인이 CVE로 판명되어도 사용자 전원에게 즉시 비활성화를 강제할 수 없다.
4. **감사 불가** — 사용자가 자유롭게 설치한 외부 플러그인을 회사가 추적·제어할 공식 경로가 없다.

본 설계는 플러그인을 **managed**(회사 배포)와 **user**(자율 설치) 두 모드로 구분하여 위 문제를 해결한다.

---

## 2. 설계 원칙

1. **단일 Plugin System 위에서 모드 구분** — 이미 구현된 §9.1-9.5의 PluginRuntime, HostApi, Marketplace는 그대로 두고, deployment 모드에 따라 lifecycle만 제어한다. 플러그인 코드는 자신이 어떤 모드인지 알 필요가 없다.
2. **Deny-by-Default for User 설치** — 정책이 명시적으로 allow하지 않으면 user 설치는 차단. 이는 §14.2 Policy Enforcement의 공통 원칙과 일치.
3. **Signed Policy** — managed 정책 파일은 Corporate Internal Root CA로 서명된다. 위변조 감지 시 default policy(deny all user, managed only)로 fallback.
4. **Offline Resilience** — 최근 유효한 policy cache를 보관하여 오프라인(VPN 끊김, 출장) 상황에서도 작동. TTL 초과 시 보수 모드.
5. **No Silent Failures** — managed 플러그인 설치/서명 검증 실패는 audit + 사용자 UI + (Phase 3+) IT 알림의 3중 표면화.
6. **Backward Compatible** — 기존 `deployment` 필드 없는 매니페스트는 `user`로 자동 분류. Phase 1.5 초기에는 모든 기존 플러그인이 자연스럽게 user로 잡힌다 (단, enterprise marketplace를 통해 단계적으로 managed로 마이그레이션).

---

## 3. 컴포넌트 다이어그램

```
┌─ LVIS Boot (§4.2 확장) ─────────────────────────────────────┐
│                                                              │
│  Step 0: Python Runtime Bootstrap (기존)                    │
│       │                                                      │
│       ▼                                                      │
│  Step 0.5: Managed Policy Sync (신규)                       │
│   ┌─────────────────────────────────────────────┐           │
│   │ ManagedPolicySync                           │           │
│   │  ├─ fetchPolicy(ssoToken)                   │           │
│   │  │    → HTTP GET /policy (enterprise IT admin API)│           │
│   │  │    → mTLS + SSO 토큰                     │           │
│   │  ├─ verifyPolicySignature()                 │           │
│   │  │    → Corporate Internal Root CA                 │           │
│   │  ├─ applyPolicy() → cache 갱신              │           │
│   │  └─ fallback: loadCache() (오프라인)        │           │
│   └──────────────┬──────────────────────────────┘           │
│                  │                                           │
│                  ▼                                           │
│  Step 0.6: Managed Plugin Installer (신규)                  │
│   ┌─────────────────────────────────────────────┐           │
│   │ ManagedPluginInstaller                      │           │
│   │  ├─ diff(installed/managed, policy)         │           │
│   │  ├─ install/update/remove                   │           │
│   │  ├─ downloadFromSource() (서명된 archive)   │           │
│   │  ├─ verifyHash + verifySignature            │           │
│   │  └─ writeToDirectory(~/.lvis/plugins/managed)│          │
│   └──────────────┬──────────────────────────────┘           │
│                  │                                           │
│                  ▼                                           │
│  Step 1-5: (기존)                                           │
│                  │                                           │
│                  ▼                                           │
│  Step 6: PluginRuntime.startAll() (기존 + guard 확장)       │
│   ┌─────────────────────────────────────────────┐           │
│   │ PluginRuntime                               │           │
│   │  ├─ discover from managed/ + user/          │           │
│   │  ├─ manifest validation (deployment 필드)   │           │
│   │  └─ PluginDeploymentGuard 주입              │           │
│   └──────────────┬──────────────────────────────┘           │
│                  │                                           │
│                  ▼                                           │
│  Runtime: 모든 uninstall/disable이 Guard 통과               │
│   ┌─────────────────────────────────────────────┐           │
│   │ PluginDeploymentGuard                       │           │
│   │  ├─ canUninstall(id) → managed이면 false    │           │
│   │  ├─ canDisable(id) → 정책 기반              │           │
│   │  └─ canInstall(id, source)                  │           │
│   │       → user: allowlist/denylist/ask 검증   │           │
│   │       → managed: IT admin source만          │           │
│   └──────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 디렉터리 구조

```
~/.lvis/
├── plugins/
│   ├── managed/                        # IT 강제 배포 (사용자 수정 불가)
│   │   ├── lvis-plugin-local-indexer/
│   │   │   ├── 0.2.0/                  # 버전 디렉터리 (rollback 대비)
│   │   │   │   ├── plugin.json
│   │   │   │   ├── dist/
│   │   │   │   │   ├── index.js
│   │   │   │   │   └── ...
│   │   │   │   └── .signature          # ECDSA 서명 검증 결과 캐시
│   │   │   ├── 0.1.9/                  # 이전 버전 (자동 gc 전)
│   │   │   └── current -> 0.2.0        # 심볼릭 링크 (활성 버전)
│   │   ├── lvis-plugin-meeting/
│   │   └── lvis-plugin-email/
│   ├── user/                           # 사용자 자율
│   │   ├── mcp-notion/
│   │   │   ├── plugin.json
│   │   │   └── dist/
│   │   └── personal-habit-tracker/
│   └── manifests.db                    # SQLite: 모든 설치 플러그인의 hash + 메타
├── governance/
│   ├── managed-policy.json             # IT admin push (서명됨) — 단일 진실 소스
│   ├── managed-policy.sig              # 분리된 signature (optional)
│   ├── trusted-ca.pem                  # Corporate Internal Root CA (서명 검증용)
│   └── policy-cache/
│       ├── last-valid.json             # 가장 최근 검증 성공한 정책
│       └── last-check.json             # 마지막 IT API 호출 시각 + 결과
└── audit/
    └── managed-sync.ndjson             # managed sync 이벤트 audit (기존 audit.ndjson과 분리)
```

---

## 5. Manifest 확장

```typescript
// lvis-app/src/plugin-runtime/types.ts (확장안)

export type DeploymentMode = "managed" | "user";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  methods: string[];
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  keywords?: Array<{ keyword: string; skillId: string }>;

  // ─── Phase 1.5 신규 (deployment model) ─────────────────

  /** 배포 모드 — 기본값 "user" (backward compat) */
  deployment?: DeploymentMode;

  /** managed 배포 시 publisher 식별 */
  publisher?: string;
  publisherId?: string;
  publishedAt?: string;        // ISO 8601

  /** managed 매니페스트 서명 (Phase 3 필수) */
  signature?: string;          // base64
  signatureAlgorithm?: "ECDSA-P256-SHA256";

  /** 앱 버전 범위 */
  minAppVersion?: string;
  maxAppVersion?: string;
}

export interface PluginDeploymentMetadata {
  mode: DeploymentMode;
  publisher?: string;
  publisherId?: string;
  publishedAt?: string;
  installedAt: string;         // LVIS가 실제 설치한 시점
  lastUpdatedAt?: string;
  forceInstalled?: boolean;    // IT가 강제 설치했는지
  managedSource?: string;      // 다운로드 URL (managed only)
  signatureStatus: "verified" | "unverified" | "failed" | "skipped";
}
```

**Backward compatibility**: `deployment` 필드가 없는 기존 매니페스트는 `"user"`로 해석. Phase 1에서 이미 설치된 3개 번들 플러그인(local-indexer, meeting, ms-graph)은 Phase 1.5 전까지 user로 잡히다가, IT가 정책을 push하면서 자동으로 managed로 전환된다.

---

## 6. Managed Policy 파일 구조

```typescript
// lvis-app/src/plugin-runtime/managed-policy.ts (신규)

export interface ManagedPolicy {
  /** ISO 8601 — 이 정책의 발행 시각 */
  version: string;

  /** 서명 메타 */
  signer: string;             // "example-ca"
  signature: string;          // base64(ECDSA(canonicalize(body)))
  signatureAlgorithm: "ECDSA-P256-SHA256";

  /** 정책 본문 (canonicalize 대상) */
  enforcements: PolicyEnforcements;
  denyList: DenyListEntry[];
  nextCheckAt: string;        // 다음 sync 시각

  /** 오프라인 TTL */
  offlineMaxAgeDays: number;  // default 7
  offlineStrictMaxAgeDays: number;  // default 30 (초과 시 user 설치 deny)
}

export interface PolicyEnforcements {
  managedPlugins: ManagedPluginEntry[];
  userInstallPolicy: "allow" | "deny" | "allowlist" | "denylist" | "ask";
  userAllowlist?: string[];   // pattern matching (glob)
  userDenylist?: string[];
  requireUserSignature: boolean;
  maxUserPlugins?: number;    // 자원 보호
}

export interface ManagedPluginEntry {
  id: string;
  version: string;
  /** 다운로드 URL (enterprise artifact store) */
  source: string;
  sha256: string;
  /** 자동 설치 여부 (사용자 승인 bypass) */
  forceInstall: boolean;
  /** 자동 업데이트 여부 */
  autoUpdate: boolean;
  /** 강제 비활성화 불가 */
  lockEnabled?: boolean;
  /** 최소/최대 앱 버전 */
  minAppVersion?: string;
  maxAppVersion?: string;
}

export interface DenyListEntry {
  id: string;
  versions?: string[];        // 특정 버전만 deny (undefined = 전체)
  reason: string;
  revokedAt: string;
  cveId?: string;
}
```

**정책 예시**:

```json
{
  "version": "2026-04-13T21:00:00Z",
  "signer": "example-ca",
  "signature": "MEUCIQDk...base64...==",
  "signatureAlgorithm": "ECDSA-P256-SHA256",
  "enforcements": {
    "managedPlugins": [
      {
        "id": "lvis-plugin-local-indexer",
        "version": "0.2.0",
        "source": "https://internal.your-corp.example/lvis/marketplace/api/v1/plugins/lvis-plugin-local-indexer/0.2.0.tgz",
        "sha256": "abc123def456...",
        "forceInstall": true,
        "autoUpdate": true,
        "lockEnabled": true,
        "minAppVersion": "1.0.0"
      },
      {
        "id": "lvis-plugin-meeting",
        "version": "1.1.3",
        "source": "https://internal.your-corp.example/lvis/marketplace/api/v1/plugins/lvis-plugin-meeting/1.1.3.tgz",
        "sha256": "def789abc012...",
        "forceInstall": true,
        "autoUpdate": true
      }
    ],
    "userInstallPolicy": "allowlist",
    "userAllowlist": ["mcp-notion", "mcp-jira", "personal-habit-tracker"],
    "userDenylist": [],
    "requireUserSignature": false,
    "maxUserPlugins": 10
  },
  "denyList": [
    {
      "id": "compromised-plugin",
      "reason": "CVE-2026-xxxx: arbitrary file read via HostApi.getSecret",
      "revokedAt": "2026-04-13T20:00:00Z",
      "cveId": "CVE-2026-xxxx"
    }
  ],
  "nextCheckAt": "2026-04-14T21:00:00Z",
  "offlineMaxAgeDays": 7,
  "offlineStrictMaxAgeDays": 30
}
```

---

## 7. 컴포넌트 상세 API

### 7.1 `ManagedPolicySync`

```typescript
// lvis-app/src/plugin-runtime/managed-policy-sync.ts

export class ManagedPolicySync {
  constructor(
    private readonly opts: {
      policyDir: string;            // ~/.lvis/governance
      apiEndpoint: string;          // https://internal.your-corp.example/lvis/policy
      trustedCaPath: string;        // ~/.lvis/governance/trusted-ca.pem
      auditService: AuditService;
    },
  ) {}

  /** IT admin API에서 최신 정책 가져오기 */
  async fetchPolicy(ssoToken: string): Promise<ManagedPolicy> {
    // GET apiEndpoint with Authorization: Bearer <sso>
    // Client cert: mTLS optional
    // Timeout 10s, retry 3x with exponential backoff
  }

  /** ECDSA 서명 검증 (corporate CA public key로) */
  async verifyPolicySignature(policy: ManagedPolicy): Promise<boolean> {
    // 1. load trusted-ca.pem (fs cached)
    // 2. canonicalize(policy.enforcements + denyList + nextCheckAt)
    // 3. ECDSA-P256-SHA256 verify(canonical, policy.signature, public_key)
    // 4. return bool
  }

  /** 검증된 정책을 디스크에 원자적으로 저장 */
  async applyPolicy(policy: ManagedPolicy): Promise<void> {
    // atomic write: temp + fsync + rename
    // policy-cache/last-valid.json 갱신
    // policy-cache/last-check.json 기록
  }

  /** 오프라인/실패 시 최근 cache 로드 */
  async loadCache(): Promise<ManagedPolicy | null> {
    // policy-cache/last-valid.json 읽기
    // age 계산 → offlineMaxAgeDays vs offlineStrictMaxAgeDays
    // strict 초과 시 null 반환 (user 설치 deny fallback)
  }

  /** 주기 sync (Phase 1.5는 boot 시에만, Phase 2는 30분 주기 추가) */
  async syncNow(ssoToken: string): Promise<PolicySyncResult> {
    try {
      const fresh = await this.fetchPolicy(ssoToken);
      if (!(await this.verifyPolicySignature(fresh))) {
        this.auditService.log({
          type: "error",
          payload: { scope: "managed-policy", reason: "signature verification failed" },
        });
        return { status: "signature-failed", policy: await this.loadCache() };
      }
      await this.applyPolicy(fresh);
      return { status: "success", policy: fresh };
    } catch (err) {
      this.auditService.log({
        type: "error",
        payload: { scope: "managed-policy", reason: String(err) },
      });
      return { status: "network-failed", policy: await this.loadCache() };
    }
  }
}

export type PolicySyncResult =
  | { status: "success"; policy: ManagedPolicy }
  | { status: "signature-failed"; policy: ManagedPolicy | null }
  | { status: "network-failed"; policy: ManagedPolicy | null };
```

### 7.2 `ManagedPluginInstaller`

```typescript
// lvis-app/src/plugin-runtime/managed-plugin-installer.ts

export class ManagedPluginInstaller {
  constructor(
    private readonly opts: {
      managedDir: string;           // ~/.lvis/plugins/managed
      httpClient: FetchLike;
      auditService: AuditService;
    },
  ) {}

  /** 정책과 현재 설치 상태를 diff하여 install/update/remove */
  async syncFromPolicy(policy: ManagedPolicy): Promise<SyncResult> {
    const installed = await this.listInstalled();
    const target = new Map(policy.enforcements.managedPlugins.map(p => [p.id, p]));
    const installedIds = new Set(installed.map(p => p.id));

    const toInstall: ManagedPluginEntry[] = [];
    const toUpdate: Array<{ from: InstalledPlugin; to: ManagedPluginEntry }> = [];
    const toRemove: InstalledPlugin[] = [];

    for (const entry of target.values()) {
      const existing = installed.find(p => p.id === entry.id);
      if (!existing) toInstall.push(entry);
      else if (existing.version !== entry.version) toUpdate.push({ from: existing, to: entry });
    }
    for (const p of installed) {
      if (!target.has(p.id)) toRemove.push(p);
    }

    // denyList 우선 적용
    for (const deny of policy.denyList) {
      const target = installed.find(p => p.id === deny.id);
      if (target && !toRemove.includes(target)) toRemove.push(target);
    }

    const results: InstallResult[] = [];
    for (const entry of toInstall) results.push(await this.install(entry));
    for (const upd of toUpdate) results.push(await this.update(upd.from, upd.to));
    for (const rem of toRemove) results.push(await this.remove(rem, "policy-deny"));
    return { results };
  }

  /** 서명된 archive 다운로드 + 검증 + 설치 */
  async install(entry: ManagedPluginEntry): Promise<InstallResult> {
    // 1. download tarball from entry.source (HTTPS + mTLS optional)
    // 2. sha256 검증
    // 3. extract to temp
    // 4. manifest 서명 검증 (ECDSA)
    // 5. atomic move to managed/<id>/<version>/
    // 6. update current symlink
    // 7. audit 기록
    // 8. 실패 시: rollback + audit + throw
  }

  async update(from: InstalledPlugin, to: ManagedPluginEntry): Promise<InstallResult> {
    // 1. install new version in parallel dir
    // 2. 검증 성공 시 symlink swap
    // 3. 이전 버전 유지 (다음 gc 주기까지, rollback 대비)
  }

  async remove(plugin: InstalledPlugin, reason: string): Promise<InstallResult> {
    // managed 전용 remove API (IT-triggered only)
    // PluginDeploymentGuard를 bypass할 수 있는 유일한 경로
  }

  async verifySignature(pluginPath: string, expectedSig: string): Promise<boolean> {
    // manifest 파일 로드 + canonicalize + ECDSA verify
  }

  async listInstalled(): Promise<InstalledPlugin[]> {
    // managed/ 디렉터리 스캔
  }
}
```

### 7.3 `PluginDeploymentGuard`

```typescript
// lvis-app/src/plugin-runtime/plugin-deployment-guard.ts

export class PluginDeploymentGuard {
  constructor(
    private readonly opts: {
      policy: () => ManagedPolicy | null;  // live policy accessor
      registry: () => PluginRegistry;
    },
  ) {}

  /**
   * managed 플러그인은 사용자가 제거할 수 없다.
   *
   * ⚠️ Security B-HIGH + Architect CRITICAL 정정 (2026-04-13):
   * 이전 초안은 `registry().plugins.find(...).deployment`에서 deployment를 읽었으나
   * `PluginRegistryEntry`에는 `deployment` 필드가 없고(있어도 registry JSON을
   * 사용자가 편집하여 managed→user 재분류 가능), **manifestPath 경로가 managed
   * 디렉터리 하위인지로 판정**하는 것이 올바르다. registry 파일 위변조에 독립.
   */
  canUninstall(pluginId: string, actor: "user" | "it-admin"): GuardResult {
    if (actor === "it-admin") return { allowed: true };
    const entry = this.registry().plugins.find(p => p.id === pluginId);
    if (!entry) return { allowed: false, reason: "plugin-not-found" };

    const managedDir = path.join(os.homedir(), ".lvis", "plugins", "managed");
    const manifestPath = path.resolve(entry.manifestPath);
    const isManagedDir = manifestPath.startsWith(managedDir + path.sep);

    if (isManagedDir) {
      return {
        allowed: false,
        reason: "managed-plugin-user-uninstall-blocked",
        userMessage: "이 플러그인은 회사 정책에 의해 배포되었습니다. IT 부서에 문의하세요.",
      };
    }

    // (double check) manifest.deployment 필드도 교차 검증 가능하지만
    // 파일 경로가 단일 진실 소스이므로 여기서는 생략.
    return { allowed: true };
  }

  canDisable(pluginId: string, actor: "user" | "it-admin"): GuardResult {
    if (actor === "it-admin") return { allowed: true };
    const entry = this.registry().plugins.find(p => p.id === pluginId);
    if (!entry) return { allowed: false, reason: "plugin-not-found" };

    // manifestPath 기반 판정 (위 canUninstall과 동일 원칙)
    const managedDir = path.join(os.homedir(), ".lvis", "plugins", "managed");
    const manifestPath = path.resolve(entry.manifestPath);
    const isManagedDir = manifestPath.startsWith(managedDir + path.sep);
    if (!isManagedDir) return { allowed: true };

    const policy = this.policy();
    const managedEntry = policy?.enforcements.managedPlugins.find(p => p.id === pluginId);
    if (managedEntry?.lockEnabled) {
      return {
        allowed: false,
        reason: "managed-plugin-lock-enabled",
        userMessage: "이 플러그인은 회사 정책에 의해 비활성화가 불가합니다.",
      };
    }
    return { allowed: true };
  }

  canInstall(pluginId: string, source: "user" | "managed-api"): GuardResult {
    if (source === "managed-api") return { allowed: true };  // IT만 가능

    // user install policy 검증
    const policy = this.policy();
    if (!policy) {
      return {
        allowed: false,
        reason: "no-policy-cache",
        userMessage: "정책 캐시가 만료되었습니다. 온라인 복구 후 재시도하세요.",
      };
    }

    const enf = policy.enforcements;

    // denyList 우선
    if (policy.denyList.some(d => d.id === pluginId)) {
      return { allowed: false, reason: "deny-list", userMessage: "차단된 플러그인입니다." };
    }

    switch (enf.userInstallPolicy) {
      case "allow":
        return { allowed: true };
      case "deny":
        return { allowed: false, reason: "policy-deny-all", userMessage: "회사 정책: 자율 설치 불가" };
      case "allowlist":
        if (enf.userAllowlist?.some(p => this._glob(p, pluginId))) return { allowed: true };
        return { allowed: false, reason: "not-in-allowlist" };
      case "denylist":
        if (enf.userDenylist?.some(p => this._glob(p, pluginId))) return { allowed: false, reason: "in-denylist" };
        return { allowed: true };
      case "ask":
        return { allowed: true, requiresPrompt: true };
    }
  }

  private _glob(pattern: string, id: string): boolean {
    // simple glob: *foo*, foo, foo-*
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(id);
  }
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  userMessage?: string;
  requiresPrompt?: boolean;
}
```

### 7.4 통합 지점 — `PluginMarketplaceService` + `PluginRuntime`

**⚠️ Architect CRITICAL 정정 (2026-04-13)**:
이전 초안은 `PluginRuntime.uninstall/disable/install`에 guard를 삽입한다고 기술했으나, 실제 `lvis-app/src/plugin-runtime/runtime.ts`에는 이 메서드들이 존재하지 않는다. **실제 uninstall 경로는 `PluginMarketplaceService.uninstall()` (`marketplace.ts:63-90`)** 이며, `disable` 기능은 현재 **런타임 hot-disable이 미구현**이다. Phase 1.5 scope에는 다음이 포함되어야 한다:

1. **`PluginMarketplaceService.uninstall()`에 guard 삽입** (기존 메서드)
2. **`disable()` 메서드 신규 구현** — `registry.json`의 `enabled` 토글 + 런타임 `PluginRuntime.stopAll()` 재호출
3. **`install()` 경로 guard** — 현재 `PluginMarketplaceService.install()` 기반

**actor 신뢰 경계 (Security B-HIGH 대응)**:
`actor` 파라미터는 **main process 코드 내부에서만** 결정된다. IPC/HTTP로 외부 입력을 받을 수 없으며, renderer devtools로 IPC 호출 시 actor는 항상 `"user"` 고정. `"it-admin"` 경로는 `ManagedPluginInstaller` 내부에서만 사용되며 IPC에 노출되지 않는다.

```typescript
// lvis-app/src/plugin-runtime/marketplace.ts (변경안)

export class PluginMarketplaceService {
  // 기존 필드...

  constructor(
    // 기존 deps...
    private readonly deploymentGuard?: PluginDeploymentGuard,
  ) {}

  /**
   * @param pluginId 제거할 플러그인 id
   * @param actor main process 내부에서만 결정 — IPC 노출 금지.
   *              IPC 핸들러는 항상 actor="user" 고정 전달.
   */
  async uninstall(
    pluginId: string,
    actor: "user" | "it-admin" = "user",
  ): Promise<void> {
    if (this.deploymentGuard) {
      const guard = this.deploymentGuard.canUninstall(pluginId, actor);
      if (!guard.allowed) {
        throw new Error(guard.userMessage ?? `Uninstall blocked: ${guard.reason}`);
      }
    }
    // 기존 uninstall 로직 (npm uninstall + registry 제거)
  }

  async install(
    source: InstallSource,
    actor: "user" | "managed-api" = "user",
  ): Promise<void> {
    if (this.deploymentGuard) {
      const guard = this.deploymentGuard.canInstall(source.pluginId, actor);
      if (!guard.allowed) {
        throw new Error(guard.userMessage ?? `Install blocked: ${guard.reason}`);
      }
      if (guard.requiresPrompt && actor === "user") {
        // UI approval flow (Phase 2)
      }
    }
    // 기존 install 로직
  }
}

// lvis-app/src/plugin-runtime/runtime.ts (disable 신규)

export class PluginRuntime {
  // 기존 필드...

  /**
   * 플러그인 hot-disable — Phase 1.5 신규.
   * registry.json의 enabled 토글 + 런타임에서 plugins Map 제거.
   * managed 플러그인 + lockEnabled 시 거부.
   */
  async disable(
    pluginId: string,
    actor: "user" | "it-admin" = "user",
  ): Promise<void> {
    if (this.deploymentGuard) {
      const guard = this.deploymentGuard.canDisable(pluginId, actor);
      if (!guard.allowed) {
        throw new Error(guard.userMessage ?? `Disable blocked: ${guard.reason}`);
      }
    }
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    try {
      await plugin.instance.stop?.();
    } finally {
      this.plugins.delete(pluginId);
      // registry.json 갱신 (enabled: false)
    }
  }
}

// lvis-app/src/ipc-bridge.ts (IPC 핸들러 — actor 고정)

ipcMain.handle("lvis:plugins:uninstall", async (_e, pluginId: string) => {
  // ⚠️ actor 파라미터는 IPC에서 받지 않음. 항상 "user" 고정.
  return pluginMarketplace.uninstall(pluginId, "user");
});
ipcMain.handle("lvis:plugins:disable", async (_e, pluginId: string) => {
  return pluginRuntime.disable(pluginId, "user");
});
```

**Phase 1.5 구현 주의사항**:
- `pluginMarketplace.uninstall()`은 npm uninstall + registry 파일 갱신만 담당. HostApi가 등록한 keyword/tool은 `PluginRuntime.stopAll()`/restart 시점에 재정리.
- `disable()` 신규 구현 시 hot-disable 경로(런타임 즉시 중지)와 cold-disable 경로(registry 토글 후 다음 boot에 반영) 중 **hot-disable 우선** 권장.
- Guard 단위 테스트 매트릭스: `(user/it-admin) × (managed/user) × (lockEnabled true/false) × (policy null/present)` 16조합.

---

## 8. UI 변경

```
┌── 설정 > 플러그인 관리 ──────────────────────────────┐
│                                                      │
│  📦 회사 배포 (managed)                              │
│  ─────────────────────────────────────────────       │
│  🔒 LVIS Local Indexer      v0.2.0    [활성]        │
│     → 회사 정책 — 제거 불가                          │
│                                                      │
│  🔒 LVIS Meeting            v1.1.3    [활성]        │
│     → 회사 정책 — 제거 불가                          │
│                                                      │
│  🔒 LVIS Email              v0.5.2    [활성]        │
│     → 회사 정책 — 제거 불가                          │
│                                                      │
│  👤 사용자 설치 (user)                               │
│  ─────────────────────────────────────────────       │
│  mcp-notion                 v0.1.0    [활성]  [❌]  │
│  personal-timer             v0.3.0    [활성]  [❌]  │
│                                                      │
│  + 새 플러그인 설치                                  │
│    (정책: allowlist — 허용 id만 설치 가능)          │
│                                                      │
│  ──────────────────────────                          │
│  마지막 정책 동기화: 2026-04-13 09:00                │
│  정책 유효기간: 7일 (6일 남음)                       │
└──────────────────────────────────────────────────────┘
```

**디자인 포인트**:
- Managed 그룹은 🔒 아이콘 + 회색 배경 + 제거 버튼 비활성화
- 툴팁으로 "회사 정책에 의해 배포됨" 표시
- User 그룹은 정상 토글 + ❌ 제거 버튼
- 하단에 정책 동기화 상태 표시 (사용자가 IT 정책 상태를 알 수 있음)

---

## 9. 감사 로깅

**이벤트 목록**:
- `managed-policy.sync.started`
- `managed-policy.sync.success`
- `managed-policy.sync.signature-failed` **[CRITICAL]**
- `managed-policy.sync.network-failed`
- `managed-plugin.install.success`
- `managed-plugin.install.failed` **[HIGH]**
- `managed-plugin.update.success`
- `managed-plugin.remove.forced` (정책 deny로 제거)
- `plugin.uninstall.blocked` (사용자가 managed 제거 시도)
- `plugin.install.denied` (사용자가 policy 위반 설치 시도)
- `plugin.signature.verification-failed` **[CRITICAL]**

모든 이벤트는 `~/.lvis/audit/managed-sync.ndjson`에 append-only NDJSON으로 기록되며, **Phase 3부터는 enterprise 감사 endpoint로도 push** (개인정보 제거 후).

---

## 10. 오프라인 동작

```
┌── Policy 수명주기 ─────────────────────────────────┐
│                                                      │
│  Online (정상)                                      │
│   └─ 30분 주기 sync + 정책 갱신                     │
│                                                      │
│  Online (IT API 다운)                               │
│   └─ last-valid cache 사용                          │
│   └─ 사용자 UI에 warning 배너                       │
│   └─ 1분마다 재시도                                 │
│                                                      │
│  Offline (VPN 끊김, 7일 이내)                       │
│   └─ last-valid cache 사용                          │
│   └─ UI 배너: "오프라인 — 최근 정책 적용 중"       │
│                                                      │
│  Offline (7일~30일)                                 │
│   └─ 보수 모드: user 플러그인 신규 설치 차단        │
│   └─ 기존 플러그인은 계속 작동                      │
│   └─ 매 boot 시 sync 재시도                         │
│                                                      │
│  Offline (30일 초과)                                │
│   └─ strict 모드: 모든 user 플러그인 비활성화       │
│   └─ managed 플러그인만 작동                        │
│   └─ UI 강제 sync 요구 + 오프라인 해결 가이드       │
└──────────────────────────────────────────────────────┘
```

---

## 11. Edge Cases 분석

| # | 시나리오 | 대응 |
|---|---|---|
| 1 | 정책 서명 검증 실패 | `ManagedPolicySync.syncNow`가 `signature-failed` 반환 → last-valid cache 사용 + CRITICAL audit + IT 알림 (Phase 3) |
| 2 | IT admin API 다운 | `fetchPolicy` 실패 → cache 사용 + UI 경고 배너 + 재시도 큐 |
| 3 | 오프라인 부팅 | cache 로드, TTL 확인, user 정책 상태에 따라 `canInstall()` 분기 |
| 4 | 사용자가 managed 플러그인 파일 수동 수정 | 주기적 hash 검증(Phase 3) → 복원 또는 reinstall + audit |
| 5 | 정책 파일 위변조 시도 | 서명 검증 실패 → default policy (deny all user) fallback + CRITICAL audit |
| 6 | 사용자가 user 플러그인으로 managed ID 사용 시도 | `canInstall()`에서 registry 충돌 감지 → deny + 명확한 에러 |
| 7 | Managed 플러그인 업데이트 네트워크 실패 | 기존 버전 유지 + 재시도 큐 + 사용자 알림 |
| 8 | 특정 managed 플러그인이 CVE로 판명 | 정책 denyList에 추가 → 다음 sync 시 자동 제거 + `lockEnabled: false` 덮어쓰기 |
| 9 | 멀티 CA (parent + subsidiary corp) | Phase 4: `trusted-ca.pem`이 여러 CA를 포함, 체인 검증 |
| 10 | 동일 PC 여러 사용자 | LVIS는 1인 1PC 가정 (architecture.md §14) — 지원 안 함 |
| 11 | VPN 끊김 중 정책 업데이트 긴급 필요 | cache만 사용, 온라인 복구 시 즉시 sync |
| 12 | 하이재킹된 managed 플러그인 | deny list + 서명 실패 → 즉시 비활성화 + 이전 버전 롤백 |
| 13 | 사용자가 allowlist 정책을 우회하여 파일 시스템에 직접 플러그인 배치 | `PluginRuntime.discover()`가 registry에 등록되지 않은 플러그인은 로드하지 않음 |
| 14 | 정책 파일 read 도중 write 발생 (race) | Policy 파일은 atomic write(temp + rename)로만 갱신, read는 snapshot |

---

## 12. 구현 Roadmap

### Phase 1.5 — 경량 구현 ✅ **COMPLETE** (2026-04-14)

**Closure report**: `docs/blueprints/phase1.5-closure-report.md`

**Scope** (all delivered):
- ✅ `DeploymentMode` 타입 + `PluginManifest.deployment` 필드 (types.ts)
- ✅ `PluginDeploymentGuard` **hybrid** (path check + manifest field) — 경량 구현을 spec보다 강화
- ✅ `canUninstall` / `canDisable` / `canInstall` (§13 test req)
- ✅ `PluginMarketplaceService.install/uninstall` + `PluginRuntime.disable` guard 주입
- ✅ UI 잠금 표시 (🔒 + bg-muted/40 + 버튼 disabled + tooltip)
- ✅ `plugin.json` + 설치 manifest + marketplace.json catalog 3곳 모두 `deployment: "managed"` 전파
- ✅ Bonus (추가 hardening): registry TOCTOU lock, fd-based chmod, 하드코딩 SHA256, 15 신규 테스트

**제외** (Phase 2 정식 이월): 정책 파일, 서명 검증, managed installer, IT admin API 연동

**검증**: vitest 110/110 PASS, TSC 0 errors, E2E subset 5/5, 3-reviewer APPROVE_WITH_MINOR → 추가 hardening 항목 all resolved.

**산출물 예상**:
- `lvis-app/src/plugin-runtime/types.ts` (DeploymentMode 추가)
- `lvis-app/src/plugin-runtime/plugin-deployment-guard.ts` (경량 version)
- `lvis-app/src/plugin-runtime/runtime.ts` (guard 주입)
- `lvis-app/src/renderer.tsx` (UI 잠금 표시)
- `lvis-plugin-{local-indexer,meeting,ms-graph}/plugin.json` (`deployment: "managed"` 추가)

### Phase 2 — IT Admin API 연동

**Scope**:
- `ManagedPolicySync` 구현 (fetchPolicy, applyPolicy, loadCache)
- `ManagedPluginInstaller` 구현 (sync, install, update, remove)
- Boot sequence에 Step 0.5 + Step 0.6 삽입
- enterprise marketplace API 계약 협의 + stub endpoint
- UI 정책 동기화 상태 표시

**제외**: ECDSA 서명 검증, 오프라인 TTL 강제, enterprise 감사 endpoint

### Phase 3 — 서명 검증 + 감사

**Scope**:
- ECDSA-P256-SHA256 서명 검증 (Node.js `crypto`)
- corporate Root CA 번들 + 체인 검증
- 오프라인 TTL 강제 (7일 / 30일 모드)
- enterprise 감사 endpoint 연동 (audit push)
- 주기적 sync (30분)

### Phase 4 — 고급 기능

**Scope**:
- User allowlist/denylist UI (사용자가 허용 목록 조회 + 신청)
- Remote emergency deny (IT가 특정 플러그인 즉시 비활성화)
- Kiosk 모드 (모든 user 설치 deny)
- 멀티 CA 지원 (본사 + 자회사 체인)
- Plugin update notification UI

---

## 13. 테스트 전략

### Unit Tests (Phase 1.5)
- `PluginDeploymentGuard.canUninstall/canDisable/canInstall` — 모든 분기
- Manifest 로드 시 `deployment` 필드 기본값 (`user`) 적용
- managed 플러그인 uninstall 시도 시 throw

### Integration Tests (Phase 2)
- Mock IT admin API로 policy sync 전체 흐름
- `ManagedPluginInstaller.syncFromPolicy` diff 로직
- denyList 적용 시 플러그인 제거
- 오프라인 시 cache 사용 경로

### Security Tests (Phase 3)
- 서명 위변조 시도 → CRITICAL audit 발생
- Race condition: 정책 read/write 동시 발생
- 잘못된 trusted CA → 모든 서명 실패
- 만료된 cache → 보수 모드 전환

---

## 14. 마이그레이션 계획

현재 Phase 1 종료 시점에서 번들된 3개 플러그인(`lvis-plugin-local-indexer`, `-meeting`, `-ms-graph`)은 `deployment` 필드가 없으므로 자동으로 **user**로 분류된다. IT 부서가 정책을 push하기 전까지는 사용자가 이들을 제거할 수 있다.

**마이그레이션 단계**:

1. **Phase 1.5 초기**: 3개 기본 플러그인의 `plugin.json`에 `"deployment": "managed"` 필드 추가 + 기본 manifest로 bundle
2. **Phase 1.5 중기**: 기존 사용자 PC에서 LVIS 업그레이드 시, `plugin.json`의 `deployment` 필드가 변경되면 자동 재분류 → uninstall 불가로 전환
3. **Phase 2 시작**: enterprise marketplace API에 정책 파일 배포 → `ManagedPolicySync`가 작동 시작
4. **Phase 2 안정**: 모든 기본 플러그인이 IT 서명된 managed 버전으로 교체
5. **Phase 3**: 서명 검증 활성화 → 서명 없는 기존 매니페스트는 warning 후 re-install 요구

---

## 15. 결정이 필요한 항목

1. **enterprise marketplace API 명세** — endpoint URL, SSO 토큰 경로, response 스키마는 IT 부서와 협의 필요
2. **corporate Root CA 공개키 번들 방식** — 앱 리소스에 포함? MDM push? 첫 부팅 시 다운로드?
3. **오프라인 TTL 기본값** — 7일이 적절한지 vs 14일 / 30일
4. **User 설치 기본 정책** — `allow` (자유) vs `allowlist` (보수) vs `ask` (중간)
5. **기존 Phase 1 번들 플러그인을 언제 managed로 전환** — 즉시 vs 점진적

---

## 16. References

- LVIS architecture.md §9 Plugin System
- LVIS architecture.md §9.6 Plugin Deployment Model (본 문서 요약)
- LVIS architecture.md §14.2 Policy Enforcement
- LVIS architecture.md §6.3 Tool Permission Model (유사 정책 모델)
- LVIS tool-governance.md (MCP 거버넌스 — 유사 서명 검증 패턴 참조)
- LVIS .omc/plans/autopilot-phase1-indexer.md (Phase 1 인덱서 격상 청사진)

---

**작성일**: 2026-04-13
**다음 단계**: Phase 1.5 경량 구현 라운드 — `DeploymentMode` 타입 추가 + `PluginDeploymentGuard` 경량 버전 + 3개 기본 플러그인 manifest 업데이트
