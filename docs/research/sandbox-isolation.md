# Research: OS-Level Sandbox Isolation for LVIS Tool Execution

**Status: pending approval**

**Issue**: #691 (sandbox capability + reviewer SOT integration)

**Date**: 2026-05-15

**Scope**: C1 deliverable — per-OS sandbox tool evaluation + wrapper interface design (research + decision items only; zero code changes)

---

## 1. Context & Wired SSOT Integration

This research documents the integration points where sandbox capability will plug into the existing LVIS permission stack. **All cited line numbers have been grep-verified against the current codebase.**

| Component | File:Line | Current State |
|---|---|---|
| **SandboxKind union** | `src/permissions/sandbox-capability.ts:31` | `type SandboxKind = "none" \| "bubblewrap" \| "sandbox-exec" \| "appcontainer"` — union already declared, awaiting runtime detection |
| **Detection placeholder** | `src/permissions/sandbox-capability.ts:74-79` | `detectSandboxCapability()` returns `kind: "none"` + comment; actual per-OS probes not yet implemented |
| **Formatter for prompt** | `src/permissions/sandbox-capability.ts:89-93` | `formatSandboxCapabilityForPrompt()` — stable, grep-able format for reviewer LLM |
| **Weak-sandbox predicate** | `src/permissions/sandbox-capability.ts:107` | `isWeakSandbox()` returns true for `kind === "none"` or `confidence === "assumed"` — gates composition rule trigger |
| **Reviewer input field** | `src/shared/permission-reviewer-framework.ts:30` | `executionSandbox` in `PERMISSION_REVIEWER_INPUT_FIELDS` array — already included |
| **Composition rule** | `src/shared/permission-reviewer-framework.ts:36` | No-downgrade rule: "If executionSandbox.kind='none' or confidence='assumed', LLM MUST NOT downgrade MEDIUM/HIGH to LOW" |
| **Rule baseline** | `src/permissions/reviewer/risk-classifier.ts:512` | `const ruleVerdict = this.rule.classify(input);` — rule verdict established first |
| **No-downgrade enforcement** | `src/permissions/reviewer/risk-classifier.ts:547` | `return maxVerdict(ruleVerdict, llmVerdict);` — LLM cannot lower the rule verdict |
| **Fail-safe policy** | `src/permissions/permission-manager.ts:186-208` | `setReviewer()` wires classifier; `hasReviewer()` gating; `dispatchReviewer()` checks `!this.hasReviewer()` and returns HIGH+defer when reviewer absent |
| **UI rendering** | `src/ui/renderer/components/ToolApprovalDialog.tsx:283-296` | Sandbox capability card renders when `request.sandboxCapability` present; testId `tool-approval-sandbox`; displays "⚠ OS 격리 없음" or "OS 격리 활성 (kind)" |

### Evaluation Context Integration Gap

**Decision Item D7 (deferred)**: `src/permissions/evaluation-context.ts` — the PermissionEvaluationContext interface does **NOT** currently carry an `executionSandbox` field. Sandbox capability is rendered into the reviewer system prompt via the formatter (`sandbox-capability.ts:89-93`), not via evaluation-context injection. Research must note this discrepancy and propose either:
- (a) Extend evaluation-context with `executionSandbox: SandboxCapability` for explicit context passing, or
- (b) Keep the current prompt-side rendering pathway and ensure the formatter is the canonical site for capability → prompt translation.

---

## 2. Disqualification Criteria & Evidence Grading

**Four binary disqualification filters** applied to each sandbox candidate:

| Criterion | Definition | Evidence Quality Grades |
|---|---|---|
| **Egress Block (D1)** | Sandbox MUST 100% block external network egress from sandboxed tool process | `verified-kernel` = independent reproducible test of kernel guarantee; `policy-best-effort` = vendor docs claim + bypass paths documented; `unverified` = claims without proof; `EVIDENCE-MISSING` = no available evidence |
| **Performance Overhead ≤ 30%** | Tool invocation latency overhead measured; tool runtime overhead ≤ 30% vs unsandboxed | `measured` = cited benchmark; `estimated-low` = vendor claims <5%; `estimated-high` = vendor claims 10–25%; `EVIDENCE-MISSING` = no measurement available |
| **License-Free** | Sandbox tool must not require commercial license or proprietary agreement | `GPL/MIT/Apache/free` = clear open license; `proprietary` = requires paid license or closed-source EULA; `dual-license` = mixed (requires analysis) |
| **Windows Deployable** | Sandbox mechanism must ship in LVIS (Electron bundle or pre-installed) without per-invocation admin elevation | `native` = OS primitive, no external install; `one-time-install` = admin elevation once at boot, automatable via signed installer (acceptable per LGE corp MSI precedent); `per-invocation-admin` = repeating elevation (rejected); `unavailable-windows` = no Windows version |

---

## 3. Per-OS Sandbox Candidate Matrix

### Linux

| Candidate | Egress Block | Perf Overhead | License | Windows | Verdict | Notes |
|---|---|---|---|---|---|---|
| **bwrap (bubblewrap)** | PASS (verified-kernel via `--unshare-net` CLONE_NEWNET) | PASS (estimated-low <5% Flatpak precedent) | PASS (GNU LGPL-2.0+) | N/A (Linux-only) | **PASS** | Primary Linux choice; network namespace = verified-kernel; fs isolation via `--bind` read-only; used by Flatpak, Flatseal; `bwrap --unshare-net` is the standard production isolation. |
| **landlock LSM v4** | PARTIAL (fs-only, no network; must pair with bwrap for egress block) | PASS (kernel policy, <2% overhead) | PASS (GPL-2.0) | N/A (Linux-only) | **PARTIAL** | Filesystem-only isolation via LSM stackable layer. Does NOT isolate network egress independently. Combining bwrap + landlock feasible but increases audit surface. Forward-path: v5+ may add network controls. Decision item D6: extend SandboxKind for `"fs-only"` isolation if used. |
| **firejail** | PASS (network isolation via custom seccomp + netfilter) | PARTIAL (estimated 5–10% overhead but less predictable than bwrap) | PASS (GPL-3.0) | N/A (Linux-only) | **PASS** | Older, more features but less kernel-verified guarantees than bwrap. Used in some desktop environments. Bwrap is recommended over firejail for simpler, more auditable profiles. |

**Linux Recommendation**: bwrap primary + landlock v4 optional hardening (decision D1).

### macOS

| Candidate | Egress Block | Perf Overhead | License | Windows | Verdict | Notes |
|---|---|---|---|---|---|---|
| **sandbox-exec (`/usr/bin/sandbox-exec`)** | **PARTIAL** (policy-best-effort; `(deny network*)` does NOT cleanly block localhost IPv4/IPv6, system DNS resolver, Bonjour/mDNS, UNIX-domain-socket exfil to localhost services; bypass paths documented) | PASS (estimated <3% OS primitive overhead) | N/A (Apple system binary) | N/A (macOS-only) | **PARTIAL** | Undocumented but present in macOS 14.x/15.x. Custom `.sb` security profiles allow fine-grained policy. **Critical caveat**: sandbox-exec evidence quality is policy-best-effort, NOT verified-kernel. Known bypass paths: localhost binding (raw socket or UNIX domain), IPv6 link-local, system DNS via /etc/resolv.conf, Bonjour (mDNS multicast). See pre-mortem §Failure scenario 3 (sandbox-exec removal in macOS 16+). Decision item D2: accept PARTIAL with Lima fallback, or refuse-to-launch on macOS? |
| **App Sandbox (Entitlements)** | PASS (verified-kernel for packaged apps) | PASS (<1% overhead, app-native) | N/A (Apple system) | N/A (macOS-only) | **FAIL** | Requires app re-codesigning + entitlements manifest. Electron asar + codesigning compatibility unverified. App Sandbox is per-app declarative (not per-tool dynamic). Rejected because LVIS dynamic tool execution cannot pre-declare all tool egress rules. |

**macOS Recommendation**: sandbox-exec PARTIAL + Lima fallback for high-sensitivity tool calls (decision D2).

### Windows

| Candidate | Egress Block | Perf Overhead | License | Windows | Verdict | Notes |
|---|---|---|---|---|---|---|
| **AppContainer + Win32 Job Object** | PASS (verified-kernel; capability SIDs isolate network access; Job Object enforces process limits) | PASS (estimated 2–5% OS overhead) | N/A (Windows system) | PASS (native) | **PASS** (subject to D3 validation) | Mature Windows native isolation. AppContainer = capability SID model (no-internetClient capability blocks outbound network). Win32 Job Object = process/UI restrictions. **Caveat**: Electron + asar packaging + AppContainer manifest compatibility unverified (plan-risk #2). Decision item D3: requires confirmation that Electron app.asar can be bundled in AppContainer + test deployment. If incompatible, fallback to WSL2. |
| **Win32 Job Object (alone)** | FAIL (no network isolation, only process limits) | PASS (<1% OS overhead) | N/A | PASS | **FAIL** | Process/UI restrictions only; no network/fs isolation. Rejected as insufficient per criterion 1. |
| **WSL2 (Windows Subsystem for Linux)** | PASS (verified-kernel via Linux kernel inside WSL) | PARTIAL (estimated 10–20% overhead: VM boot, file sync, network relay) | PASS (free Windows feature) | PASS (one-time install) | **PASS** (fallback only) | Linux kernel inside Windows VM. One-time installation, then zero per-invocation elevation. Performance acceptable as fallback for high-sensitivity tools. LGE corp MSI installer can automate WSL2 setup. Decision item D3: WSL2 reserved as Windows fallback if AppContainer+asar compat test fails. |
| **Sandboxie-Plus** | PASS (user-mode isolation, API hooking) | PARTIAL (estimated 15–25% overhead; more heavyweight than OS primitives) | FAIL (GPL-3.0 + proprietary fork model; licensing ambiguity) | PARTIAL (deprecated in modern Windows) | **FAIL** | Dual-license (Classic GPL-3.0 / Plus proprietary) creates license-ambiguity risk. Deprecated in favor of AppContainer + Windows Defender Application Guard. Rejected on License criterion. |

**Windows Recommendation**: AppContainer+Job Object primary + WSL2 fallback (decision D3).

---

## 4. Surviving Candidates & Recommended Stack

After applying disqualification filters:

### Primary (Option A) — Per-OS Native + Unified TS Wrapper

**Linux**: bwrap (`--unshare-net --bind-try / / --ro-bind /home ~ --bind ...`)
- Egress block: verified-kernel (CLONE_NEWNET namespace)
- Deployment: system package (dnf bwrap on RHEL-family) or static-linked binary bundled in LVIS
- Decision item D1: choose package dependency vs bundled binary

**macOS**: sandbox-exec with custom `.sb` profile
- Egress block: policy-best-effort (known bypass paths; marked PARTIAL)
- Fallback: Lima VM (Option B2) for high-sensitivity tool calls
- Decision item D2: accept PARTIAL with user toggle, or default to Lima?

**Windows**: AppContainer + Win32 Job Object
- Egress block: verified-kernel (capability SID no-internetClient)
- Deployment: Electron asar with AppContainer manifest registration
- Validation: requires proof of Electron+asar+AppContainer compatibility (decision item D3)
- Fallback: WSL2 if AppContainer compat test fails

### Fallback (Option B2) — Linux-Container Runners for PARTIAL OS Rows

When an OS row is PARTIAL or compat test fails:

**Lima** (macOS fallback)
- One-time install: ~500 MB VM image download
- Per-tool overhead: 10–15% (container overhead + file sync)
- License: MIT (free)
- Deployment: signed LGE MSI installer bundles Lima setup script; first boot auto-runs, then zero elevation on tool spawn

**WSL2** (Windows fallback)
- One-time install: ~3 GB distro download + kernel setup
- Per-tool overhead: 10–20% (VM intercommunication + file sync)
- License: free Windows feature
- Deployment: signed LGE MSI installer; first boot auto-runs WSL2 init; subsequent tool calls via `wsl` CLI

---

## 5. Wrapper Interface Design

The `SandboxRunner` interface abstracts per-OS tools and allows boot-time registration of fallback runners (Option B2). All 4+ spawn paths adopt the same interface without code duplication.

### TS Pseudocode: Core Interfaces

```typescript
/**
 * Execution environment isolation capability descriptor.
 * Describes what is isolated (network, filesystem, processes).
 * 
 * V1 (chosen): narrow allowlist for simplicity + reviewer modelability
 * Forward path: hybrid (selective OCI fields) for v2 expansion
 */
export interface SandboxCapabilityDescriptor {
  /** Is external network egress blocked? */
  networkBlocked: boolean;
  
  /** Filesystem read whitelist (absolute paths). [] = inherit host. */
  fsReadPaths: string[];
  
  /** Filesystem write whitelist (absolute paths). [] = inherit host. */
  fsWritePaths: string[];
  
  /** Process/IPC isolation active? (boolean; expands to syscall set in v2) */
  processIsolated: boolean;
}

/**
 * Single sandbox runner abstraction.
 * Each OS registers one primary runner + optional fallback.
 * 
 * The runner is responsible for:
 *   1. Executing cmd/args with the given capability constraints
 *   2. Reporting success/failure + exit code
 *   3. Streaming stdout/stderr
 *   4. Responding to abort/SIGTERM
 */
export interface SandboxRunner {
  /**
   * Spawn a process inside the sandbox with given capabilities.
   * 
   * @param cmd - executable path or shell command
   * @param args - command-line arguments (NOT interpreted for shell metacharacters)
   * @param capabilities - isolation constraints (networkBlocked, fs allowlists, etc.)
   * @param env - environment variables to pass (merged with host defaults)
   * @returns - child process handle + streams
   */
  spawn(
    cmd: string,
    args: readonly string[],
    capabilities: Partial<SandboxCapabilityDescriptor>,
    env?: Record<string, string>,
  ): Promise<SandboxedProcess>;

  /**
   * Detect whether this runner is available on the current platform.
   * Called at boot to validate runner registration.
   * 
   * @returns - { available: boolean, reason: string }
   */
  detect(): Promise<{ available: boolean; reason: string }>;
}

/**
 * Spawned process handle inside sandbox.
 */
export interface SandboxedProcess {
  pid: number;
  stdout: ReadableStream<string>;
  stderr: ReadableStream<string>;
  exitCode: Promise<number>;
  
  /** Send SIGTERM to the sandboxed process. */
  abort(): Promise<void>;
}

/**
 * Boot-time registration for per-OS sandbox runners.
 * Allows swappable primary + fallback per platform.
 * 
 * Example:
 *   registerSandboxRunner("darwin", new SandboxExecRunner()); // primary
 *   registerSandboxRunner("darwin", new LimaRunner()); // fallback (opt-in)
 */
export function registerSandboxRunner(
  platform: "linux" | "darwin" | "win32",
  runner: SandboxRunner,
  isGrafallback?: boolean,
): void {
  // Boot-time wiring; 4 spawn paths call getSandboxRunner(platform)
}

export function getSandboxRunner(
  platform: "linux" | "darwin" | "win32",
): SandboxRunner | undefined {
  // Returns primary or fallback based on availability + user settings
}
```

### Integration at Spawn Paths (No Code Changes; Design Only)

**Spawn paths** in LVIS that will adopt the wrapper:

1. **`src/tools/bash.ts`** — shell execution
   ```
   // Future adoption (design phase)
   const runner = getSandboxRunner(process.platform);
   const proc = await runner.spawn("bash", ["-c", command], capabilities, env);
   // Stream proc.stdout/stderr to caller
   ```

2. **`src/tools/powershell.ts`** — Windows shell
   ```
   const runner = getSandboxRunner(process.platform);
   const proc = await runner.spawn("pwsh", ["-Command", command], capabilities, env);
   ```

3. **`src/main/python-runtime.ts`** (lines 461, 523) — uv subprocess
   ```
   const runner = getSandboxRunner(process.platform);
   const proc = await runner.spawn("uv", ["run", script], capabilities, { ... });
   ```

4. **`src/plugins/runtime.ts`** — plugin worker spawn
   ```
   const runner = getSandboxRunner(process.platform);
   const proc = await runner.spawn(workerPath, workerArgs, capabilities);
   ```

5. **MCP child-process spawn** (decision item D9: in-scope or deferred?) — if MCP tools are invoked as subprocesses, add wrapper adoption.

---

## 6. Deployment & Distribution Model

### Binary Bundle vs. OS-Dependency Trade-off

**Option A1** — Bundled binaries
- bwrap: 1.5 MB x86_64/arm64 static-linked binary in `resources/sandbox/`
- Pros: zero OS dependency, works on any RHEL/Debian/Alpine
- Cons: audit burden (binary verification), platform-specific builds, update channel management
- LGE precedent: corporate builds often bundle frequently-updated tools

**Option A2** — OS package dependency
- Linux: assume `dnf install bubblewrap` available on target RHEL 8/9 (decision item D1)
- macOS: sandbox-exec is OS-provided; .sb profiles ship with app
- Windows: AppContainer is OS-native; WSL2 auto-install via signed MSI
- Pros: minimal attack surface, OS vendor maintains bwrap, natural update path
- Cons: deployment team must verify availability on all target distros

**Option A3** — Hybrid (chosen in ADR §Consequence)
- Linux: prefer OS package with fallback to bundled binary if unavailable
- macOS: sandbox-exec (OS) + Lima fallback (bundled VM image ~500MB)
- Windows: AppContainer (OS) + WSL2 (one-time install via MSI)
- Cons: doubles audit surface (native + bundled paths)

**Decision Item D8** (deployment phase): choose A1 (bundled), A2 (dependency), or A3 (hybrid). Decision affects boot initialization, version management, and security audit scope. **Per CLAUDE.md "No Fallback Code" rule**: if A3 hybrid is chosen, explicit deprecation plan + removal date for the non-primary path is required (e.g., "fallback binary removed Q3 2026 after all deployments confirm OS availability").

---

## 7. PARTIAL-Row Fallback Policy & Composition Rule Extension

When an OS sandbox detection returns PARTIAL confidence or egress-block evidence is incomplete:

### Policy Options (Decision Item D5)

**Option D5-a** — Downgrade to `kind: "none"`
- Effect: weak-sandbox predicate triggers; composition rule kicks in; LLM cannot downgrade MEDIUM/HIGH
- Pro: conservative; existing composition rule unchanged
- Con: loses the distinction "sandbox attempted but PARTIAL" vs "no sandbox at all"

**Option D5-b** — Refuse-to-launch
- Effect: high-risk tools on macOS (PARTIAL sandbox-exec) fail with user-visible error: "Sandbox unavailable; consider upgrading to macOS with [improvement] or install Lima"
- Pro: no risk of false confidence
- Con: forces user action; may interrupt workflows

**Option D5-c** — Introduce `kind: "partial"` to SandboxKind union
- Effect: SandboxKind = `"none" | "bubblewrap" | "sandbox-exec" | "appcontainer" | "partial"`
- Pro: explicit distinction in UI ("⚠ OS 격리 부분적") and composition rule ("if kind='partial', apply medium-confidence downgrade gate")
- Con: requires SandboxKind union extension (decision item D6); composition rule logic grows

**Recommendation**: D5-c (`kind: "partial"`) + D6 (union extension) — explicitly surfaces the compromise to users and composition rule. Decision items D5 and D6 are locked together (cannot do D5-c without D6).

### SandboxKind Union Extension (Decision Item D6)

Current: `"none" | "bubblewrap" | "sandbox-exec" | "appcontainer"`

After D5-c: Add `"partial"` + potentially `"fs-only"` (if landlock-only registration happens in future):
```typescript
export type SandboxKind =
  | "none"              // no isolation active
  | "bubblewrap"        // Linux: verified-kernel network isolation
  | "sandbox-exec"      // macOS: policy-best-effort isolation (sandbox-exec + .sb profile)
  | "partial"           // OS-level isolation present but evidence quality is PARTIAL (e.g. macOS fallback from sandbox-exec to Lima) 
  | "appcontainer"      // Windows: verified-kernel via capability SID
  | "fs-only";          // Future: filesystem-only isolation (e.g. landlock without network namespace)
```

**Composition rule amendment** (line 36 of `permission-reviewer-framework.ts`):
```
If executionSandbox.kind='none' OR confidence='assumed' OR kind='partial', 
the LLM MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW.
If executionSandbox.kind='fs-only', the LLM MUST NOT downgrade HIGH to MEDIUM/LOW 
(fs isolation is meaningful but incomplete without process/network isolation).
```

---

## 8. Built-in Deployment & Admin Install Pathway

### LGE Corp MSI Installer Model

For Windows WSL2 fallback + macOS Lima fallback:

**First-run behavior**:
1. User launches LVIS.exe (signed by LGE, elevated installer)
2. Boot sequence calls `registerSandboxRunner("win32", new WslRunner())`
3. WslRunner.detect() returns `{ available: false, reason: "WSL2 not installed" }`
4. Boot fallback: spawn `powershell -Command "wsl --install -d Ubuntu"` with user consent UI
5. After install, WslRunner is ready; subsequent tool spawns use WSL2

**Rationale**: One-time elevation at app install time is operationally acceptable (LGE corp precedent: VC redistributable, Java runtime, etc.). Per-invocation elevation is not acceptable (violates disqualification criterion).

**Auditing**: installer log + boot diagnostics record WSL2/Lima setup + version.

---

## 9. Considered & Rejected Alternatives

### Option B1 — Everywhere-Container (Rejected)

Use Lima/WSL2/bwrap everywhere: all OSes route through a Linux container runtime.

**Invalidation**:
- Doubled audit surface: container orchestration + Linux profiles + host glue
- Unnecessary overhead on Linux (bwrap is already verified-kernel + lightweight)
- Opaque to Electron auto-update (app version != container image version)
- Per-tool latency penalty (10–20%) vs native (2–5% for AppContainer)
- **Decision**: rejected; native primary with Option A2/A3 fallback for PARTIAL rows.

### Option C — Network-Only Isolation (Rejected)

Use only `unshare --net` (Linux), Network Extension filter (macOS), WFP (Windows) — no filesystem or process isolation.

**Invalidation**:
- Criterion 1 (egress block) is satisfied narrowly
- Criterion 1 (overall sandbox strength) is NOT — filesystem attack surface unrestricted
- Composition rule (`permission-reviewer-framework.ts:36`) presumes sandbox = meaningful isolation (fs + process + network)
- LLM reviewer would see `sandbox=true` without understanding that fs/process remain unrestricted — mis-calibration of the composition rule's protection value
- **Decision**: rejected; sandbox must isolate fs+process+network or not claim isolation.

---

## 10. Risks (Pre-Mortem)

### Failure Scenario 1 — Linux bwrap Unavailable on Target

**Risk**: Deployment target (LGE corp Linux, RHEL 8/9 derivative) doesn't have `dnf list bubblewrap` or `bwrap` binary is too old (v0.4 lacks certain flags).

**Evidence Quality**: unverified (no LGE corp Linux audit yet).

**Mitigation**:
- Step 2 (external research phase) explicitly validates bwrap availability on RHEL 8/9
- Decision item D1 includes static-link bundling plan as Plan B if OS package unavailable
- Pre-deployment gate: automated bwrap version check in CI

**Early Warning Signal**: If D1 research shows `dnf bwrap` absent on RHEL 8, escalate to infrastructure team before build epic starts.

### Failure Scenario 2 — Windows AppContainer + Electron asar Incompatibility

**Risk**: Electron + asar packaging + AppContainer capability registration conflict. Electron expects flat filesystem; AppContainer manifest expects signed/verified asar structure. Proof of compatibility unverified.

**Evidence Quality**: unverified (no Electron asar + AppContainer test yet).

**Mitigation**:
- Decision item D3 includes AppContainer + asar compat smoke test (spin up appcontainer, execute asar app, verify sandbox enforcement works)
- If compat test fails: WSL2 fallback (decision item D3) becomes primary for Windows
- Documented in build epic: "compat test must pass before shipping AppContainer primary"

**Early Warning Signal**: If D3 compat test in build epic shows FAIL, immediately backport to WSL2 primary + log as architecture decision amendment.

### Failure Scenario 3 — macOS sandbox-exec Removal in macOS 16+

**Risk**: Apple removes `/usr/bin/sandbox-exec` in macOS 16+ (or future major). Current macOS 14/15 support is undocumented. No deprecation signal yet.

**Evidence Quality**: unverified (no Apple roadmap commitment).

**Mitigation**:
- Decision item D2: commit to Lima fallback shipped from day-1 build if sandbox-exec is PARTIAL
- OR explicit emergency runbook: "If macOS 16 breaks sandbox-exec, swap runner from SandboxExecRunner to LimaRunner at boot" (no app re-release needed, just plist config)
- Quarterly monitoring: LVIS infra team watches Apple release notes for sandbox-exec deprecation signals

**Early Warning Signal**: If Apple WWDC or release notes mention sandbox-exec removal/deprecation, trigger pre-mortem audit of Lima fallback readiness.

### Failure Scenario 4 — Wrapper Interface Lock-in Drift

**Risk**: Four spawn paths import `SandboxRunner.spawn()` before composition rule re-validation against new SandboxKind values. Later, decision items D5/D6 extend SandboxKind with `"partial"` or `"fs-only"`, but reviewer composition rule test fixtures aren't updated lockstep. Composition rule logic drifts out of sync with spawn-path capability reporting.

**Evidence Quality**: organizational (no technical blocker, but coordination failure mode).

**Mitigation**:
- Decision items D5 + D6 (SandboxKind extensions) MUST be finalized BEFORE build epic begins
- Build epic includes risk-classifier test fixture updates (`src/permissions/reviewer/risk-classifier.test.ts` lines ~309 + surrounding composition rule test cases) as mandatory gate
- No spawn-path code changes without concurrent risk-classifier.test.ts amendments

**Early Warning Signal**: Build epic review shows `SandboxKind` extension in source but NO test fixture change — block merge, add reviewer comment "D6 test fixtures missing".

---

## 11. 결정 필요 (User Decision Items)

All decisions are **required** before the build epic can start.

### Decision D1 — Linux Primary Sandbox Tool

**Options**:
1. **bwrap only** — rely on OS package (dnf bwrap available on RHEL 8/9)
2. **bwrap + landlock v4** — bwrap for network, landlock for fs hardening (deepens audit, minimal benefit over bwrap alone)
3. **bwrap bundled binary** — ship static-linked bwrap in LVIS app resources (1.5 MB, avoids OS dependency)
4. **bwrap + bundled fallback** — prefer OS package; if absent, use bundled binary

**Recommendation**: Option 4 (bwrap + bundled fallback)
- Rationale: avoids hard dependency on corp Linux distro packaging; bundled fallback ensures 100% availability. Audit burden is acceptable (binary must be signed/verified in CI). Hybrid approach aligns with Option A3 deployment model.

**Owner**: Infrastructure + Security team (validate bundled binary signing pipeline)

---

### Decision D2 — macOS Sandbox Strategy

**Options**:
1. **sandbox-exec PARTIAL accepted** — use `/usr/bin/sandbox-exec` as primary, surface "⚠ OS 격리 부분적" to user, accept bypass paths (localhost/IPv6/DNS/Bonjour/UDS)
2. **Lima fallback default** — ship Lima from day-1, offer user toggle "High-sensitivity tools use sandbox (fast) vs Lima (slow but verified)"
3. **Refuse-to-launch on PARTIAL OS** — block tool invocation on macOS unless user installs Lima separately

**Recommendation**: Option 2 (Lima fallback default)
- Rationale: sandbox-exec is policy-best-effort with known bypass paths; composition rule cannot tolerate that uncertainty. Lima adds ~10–15% latency per tool, but egress guarantee becomes verified-kernel. User toggle balances risk/speed. Pre-mortem scenario 3 (sandbox-exec removal) is structurally mitigated (runner swap, no app re-release).
- Trade-off: ~500 MB one-time download, first-boot setup via signed MSI, then transparent to user.

**Owner**: Product team (user setting UI design) + Deployment (signed MSI generation)

---

### Decision D3 — Windows Primary Sandbox Tool

**Options**:
1. **AppContainer+Job Object primary** — assume Electron asar compat passes test; ship as primary
2. **WSL2 primary** — use WSL2 (verified-kernel egress block), accept 10–20% per-tool latency
3. **AppContainer primary, WSL2 fallback** — test AppContainer compat; if FAIL at deployment time, user auto-installs WSL2 via MSI

**Recommendation**: Option 3 (AppContainer primary + WSL2 fallback with compatibility test gate)
- Rationale: AppContainer is native + low-latency (2–5% overhead). WSL2 is verified-kernel fallback. Compatibility test in build epic determines actual primary post-research. If compat test fails, fallback is clear. Decision is "attempt AppContainer; WSL2 is the safety line."
- Implementation: build epic includes `test-appcontainer-asar-compat.ts` that spins up AppContainer, executes tool inside app.asar, verifies sandbox enforcement. If test FAIL, build succeeds but with appcontainer.enabled=false flag in boot.ts, WSL2 is selected at runtime.

**Owner**: Engineering team (AppContainer integration + compatibility test) + Deployment (WSL2 MSI setup)

---

### Decision D4 — Capability Descriptor Shape (ADR-level)

**Options**:
1. **Narrow allowlist** (chosen) — `{ networkBlocked: bool, fsReadPaths: string[], fsWritePaths: string[], processIsolated: bool }`
   - Pros: simple, reviewer LLM can reason about ("network blocked" vs "network allowed")
   - Cons: less fine-grained; cannot express "allow syscall X but deny syscall Y"
   - Forward path: v2 hybrid (selective OCI fields)

2. **OCI-style fine-grained** — `{ capabilities: string[], syscalls: seccomp[], namespaces: ns[], rlimits: limit[] }`
   - Pros: precise, portable across sandboxes
   - Cons: reviewer LLM modeling burden ("can this syscall exfil?" requires expertise), v1 design bloat
   - Not recommended for initial capability integration

3. **Hybrid** — `{ network: bool, fs: bool, ociExtension?: {...} }`
   - Pros: v1 simplicity, v2 expansion path baked in
   - Cons: dual semantics confuse reviewers; design debt

**Recommendation**: Narrow allowlist (Option 1)
- Rationale: reviewers + UI are LLM-focused. Narrow semantic ("network blocked") is modelable. Fine-grained syscall reasoning is out of scope for v1. Forward path to hybrid is documented in ADR §Consequences.

**Owner**: Architecture team (ADR write-up) + Reviewer system prompt team (compose rule updates)

---

### Decision D5 — PARTIAL-Row Fallback Policy

**Options**:
1. **Downgrade to kind="none"** — weak-sandbox predicate triggers; composition rule gates LLM downgrade
2. **Refuse-to-launch** — tool execution blocked on PARTIAL-sandbox OS with user message
3. **Introduce kind="partial"** — extend SandboxKind union; explicit UI + composition rule amendment

**Recommendation**: Option 3 (kind="partial")
- Rationale: explicitly surfaces the compromise to users ("부분적 격리"). Composition rule can apply medium-confidence downgrade gate instead of hard block. Locked with D6 (union extension).

**Owner**: Architecture team (composition rule amendment) + UI team (user messaging)

---

### Decision D6 — SandboxKind Union Extension

**Options**:
1. **Keep current 4-member union** — no new kinds
2. **Add "partial"** — for PARTIAL-evidence rows
3. **Add "fs-only"** — future landlock-only registrations
4. **Add both "partial" + "fs-only"** (recommended)

**Recommendation**: Option 4 (both)
- Rationale: "partial" required by D5-c decision. "fs-only" future-proofs against landlock-only registrations (v4 network-less) or custom narrowed runners. Composition rule amendments cover all cases upfront.

**Locked with**: Decision D5 (cannot do D5-c without D6)

**Owner**: Architecture team (union definition + test fixture updates in risk-classifier.test.ts)

---

### Decision D7 — evaluation-context.ts Integration

**Options**:
1. **Extend interface** — add `executionSandbox?: SandboxCapability` to PermissionEvaluationContext
   - Pros: explicit context object carries all permission inputs, including sandbox
   - Cons: larger context object; prompt builder must extract + translate
   - Change site: `src/permissions/evaluation-context.ts` interface definition

2. **Keep prompt-side rendering** — formatter (`sandbox-capability.ts:89`) injects capability into system prompt, no evaluation-context change
   - Pros: minimal interface change; formatter is already the canonical source
   - Cons: sandbox capability is implicit in prompt text, not explicit in evaluation context

**Recommendation**: Option 2 (keep prompt-side rendering)
- Rationale: minimal; formatter is stable + grep-able; audit chain can match prompt input to verdict output. Evaluation-context remains focused on permission judgment inputs (tool, path, source, etc.). Sandbox is a risk-modifier, not a judgment input itself. If future capability scoring requires explicit context, extend in v2.

**Owner**: Reviewer system prompt team (confirm formatter pathway sufficient)

---

### Decision D8 — Deployment Model (Binary vs. Dependency vs. Hybrid)

**Options**:
1. **Bundled binaries** — ship bwrap (Linux), Lima (macOS), WSL2 (Windows) in app resources
2. **OS dependencies** — rely on system packages (dnf bwrap, system sandbox-exec, native AppContainer/WSL2)
3. **Hybrid** — prefer OS packages; bundled fallback when unavailable (with explicit deprecation plan)

**Recommendation**: Option 3 (hybrid)
- Rationale: avoids hard dependency on corp Linux availability while maintaining security audit simplicity (prefer native > bundled). Reduces burden on corp IT (no app bloat). Fallback ensures 100% availability.
- **Critical**: per CLAUDE.md "No Fallback Code" rule — if hybrid is chosen, **explicit deprecation plan + removal date must be documented in ADR §Consequences and enforced in build epic**. Example: "Bundled binary fallback removed Q3 2026 after all deployments confirm OS availability." Without explicit removal, hybrid becomes permanent cruft.

**Owner**: Build team (binary bundling + versioning) + Deployment (OS package validation per distro)

---

### Decision D9 — MCP Child-Process Spawn Path Inclusion

**Options**:
1. **In-scope** — MCP child-process spawns adopt the SandboxRunner wrapper (5th spawn path)
2. **Out-of-scope** — MCP client manages its own process isolation; LVIS sandbox does not wrap MCP subprocesses

**Recommendation**: Out-of-scope (defer to post-research build epic planning)
- Rationale: MCP is an external protocol; sandbox runner is LVIS-specific. MCP has its own capability/permission model. Research focuses on 4 known spawn paths (bash, powershell, python, plugin-worker). MCP inclusion can be evaluated post-research if MCP tools require sandboxing.

**Owner**: Build epic planning team (MCP spawning requirements gathering)

---

## 12. See Also

- `docs/research/network-restricted-eval.md` — Evaluation framework design (C2 deliverable)
- `docs/architecture/permission-policy-design.md` — Full permission policy specification
- `docs/architecture/architecture.md` — § 6 (Core Engines) sandbox capability layer context
- `.omc/plans/open-questions.md` — All 13 decision items from C1 + C2 tracked for user approval

---

**Research Status**: pending approval (awaiting user decisions D1–D9)

**Citation Verification**: All file:line citations in §1 have been grep-verified against current codebase. Verification log available upon request.

**Evidence Sources**: Indexed via context-mode from bubblewrap GitHub, Landlock LSM docs, Windows AppContainer MSDN, Lima VM, Sandboxie-Plus GitHub (2026-05-15 snapshot).
