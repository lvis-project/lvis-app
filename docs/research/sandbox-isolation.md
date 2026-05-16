# Research: OS-Level Sandbox Isolation for LVIS Tool Execution

**Status: DECIDED** (all D1–D9 finalized 2026-05-16)

**Issue**: #691 (sandbox capability + reviewer SOT integration)

**Date**: 2026-05-15 (created) / 2026-05-16 (decisions finalized)

**Scope**: C1 deliverable — per-OS sandbox tool evaluation + wrapper interface design (research + decision items only; zero code changes)

---

## Two Evaluation Surfaces

| Surface | Scope | Audience | Cadence |
|---|---|---|---|
| S1 — Dev validation | LVIS sandbox implementation (bwrap command args, SBPL profile, AppContainer manifest correctness) | LVIS developers | PR / pre-release CI |
| S2 — Runtime audit | Production tool-call observability (sandbox enforcement triggered? bypass detected? verdict path?) | LVIS operators / users | Every tool invocation |

Decisions D1 through D9 (this document) govern the S1 implementation stack.
Decision E-D5 + R-1/R-2/R-3/R-4 audit fields govern S2. See `network-restricted-eval.md` §3.6 for S2 runtime audit JSON schema.

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

**Decision Item D7 (DECIDED: keep prompt-side rendering)**: `src/permissions/evaluation-context.ts` — the PermissionEvaluationContext interface does **NOT** currently carry an `executionSandbox` field. Sandbox capability is rendered into the reviewer system prompt via the formatter (`sandbox-capability.ts:89-93`), not via evaluation-context injection. The formatter pathway is the canonical site for capability → prompt translation. No evaluation-context change required.

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

**Linux Recommendation**: bwrap OS-only (D1 DECIDED). No bundled binary.

### macOS

| Candidate | Egress Block | Perf Overhead | License | Windows | Verdict | Notes |
|---|---|---|---|---|---|---|
| **sandbox-exec (`/usr/bin/sandbox-exec`)** | **PARTIAL** (policy-best-effort; `(deny network*)` does NOT cleanly block localhost IPv4/IPv6, system DNS resolver, Bonjour/mDNS, UNIX-domain-socket exfil to localhost services; bypass paths documented) | PASS (estimated <3% OS primitive overhead) | N/A (Apple system binary) | N/A (macOS-only) | **PARTIAL** | Undocumented but present in macOS 14.x/15.x. Custom `.sb` security profiles allow fine-grained policy. **Critical caveat**: sandbox-exec evidence quality is policy-best-effort, NOT verified-kernel. Known bypass paths: localhost binding (raw socket or UNIX domain), IPv6 link-local, system DNS via /etc/resolv.conf, Bonjour (mDNS multicast). See pre-mortem §10 Failure scenario 3. |
| **App Sandbox (Entitlements)** | PASS (verified-kernel for packaged apps) | PASS (<1% overhead, app-native) | N/A (Apple system) | N/A (macOS-only) | **FAIL** | Requires app re-codesigning + entitlements manifest. Electron asar + codesigning compatibility unverified. App Sandbox is per-app declarative (not per-tool dynamic). Rejected because LVIS dynamic tool execution cannot pre-declare all tool egress rules. |

**macOS Decision (D2 DECIDED)**: sandbox-exec PARTIAL accepted. Lima fallback dropped entirely (see §9 Considered & Rejected).

### Windows

| Candidate | Egress Block | Perf Overhead | License | Windows | Verdict | Notes |
|---|---|---|---|---|---|---|
| **AppContainer + Win32 Job Object** | PASS (verified-kernel; capability SIDs isolate network access; Job Object enforces process limits) | PASS (estimated 2–5% OS overhead) | N/A (Windows system) | PASS (native) | **PASS** | Mature Windows native isolation. AppContainer = capability SID model (no-internetClient capability blocks outbound network). Win32 Job Object = process/UI restrictions. **Caveat**: Electron + asar packaging + AppContainer manifest compatibility — smoke test required in build epic. If compat test fails: isolation=none (no fallback runner). |
| **Win32 Job Object (alone)** | FAIL (no network isolation, only process limits) | PASS (<1% OS overhead) | N/A | PASS | **FAIL** | Process/UI restrictions only; no network/fs isolation. Rejected as insufficient per criterion 1. |
| **WSL2 (Windows Subsystem for Linux)** | PASS (verified-kernel via Linux kernel inside WSL) | PARTIAL (estimated 10–20% overhead: VM boot, file sync, network relay) | PASS (free Windows feature) | PASS (one-time install) | **CONSIDERED AND REJECTED** (see §9) | WSL2 was the recommended Windows fallback in the original research. Decision D3 drops WSL2 in favor of AppContainer-only. If AppContainer compat test fails, result is isolation=none, not WSL2. |
| **Sandboxie-Plus** | PASS (user-mode isolation, API hooking) | PARTIAL (estimated 15–25% overhead; more heavyweight than OS primitives) | FAIL (GPL-3.0 + proprietary fork model; licensing ambiguity) | PARTIAL (deprecated in modern Windows) | **FAIL** | Dual-license (Classic GPL-3.0 / Plus proprietary) creates license-ambiguity risk. Deprecated in favor of AppContainer + Windows Defender Application Guard. Rejected on License criterion. |

**Windows Decision (D3 DECIDED)**: AppContainer + Win32 Job Object only. WSL2 fallback dropped entirely.

---

## 4. Surviving Candidates & Recommended Stack (DECIDED)

After applying disqualification filters and finalizing D1–D3:

### Primary — Per-OS Native + Unified TS Wrapper (DECIDED)

**Linux**: bwrap (`--unshare-net --bind-try / / --ro-bind /home ~ --bind ...`)
- Egress block: verified-kernel (CLONE_NEWNET namespace)
- Deployment: OS package only (`dnf install bubblewrap` on RHEL-family)
- **D1 DECIDED**: OS package only — no bundled binary, no hybrid fallback
- If bwrap unavailable: isolation=none + user notification + reviewer no-downgrade active

**macOS**: sandbox-exec with custom `.sb` profile
- Egress block: policy-best-effort (known bypass paths; marked PARTIAL)
- **D2 DECIDED**: PARTIAL accepted — isolation surfaced as `kind="partial"` to user and composition rule
- Lima fallback: dropped (see §9)

**Windows**: AppContainer + Win32 Job Object
- Egress block: verified-kernel (capability SID no-internetClient)
- Deployment: Electron asar with AppContainer manifest registration (OS-native)
- **D3 DECIDED**: AppContainer only — build epic includes compat smoke test; FAIL → isolation=none
- WSL2 fallback: dropped (see §9)

### Previously Considered: Fallback Runners (Option B2) — Considered and Rejected

> The original research proposed Lima (macOS) and WSL2 (Windows) as fallback container runners
> for PARTIAL OS rows. These options were evaluated and rejected during the decision review
> (2026-05-16). See §9 for rationale.

---

## 5. Wrapper Interface Design

The `SandboxRunner` interface abstracts per-OS tools and allows boot-time registration. All 5 spawn paths adopt the same interface without code duplication.

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
 * Each OS registers one primary runner.
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
   * If unavailable: boot sets kind="none", notifies user.
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
 * One primary runner per platform — no fallback chain.
 * 
 * Example:
 *   registerSandboxRunner("linux", new BwrapRunner());
 *   registerSandboxRunner("darwin", new SandboxExecRunner());
 *   registerSandboxRunner("win32", new AppContainerRunner());
 */
export function registerSandboxRunner(
  platform: "linux" | "darwin" | "win32",
  runner: SandboxRunner,
): void {
  // Boot-time wiring; 5 spawn paths call getSandboxRunner(platform)
}

export function getSandboxRunner(
  platform: "linux" | "darwin" | "win32",
): SandboxRunner | undefined {
  // Returns registered runner for platform, or undefined if detect() failed
}
```

### Integration at Spawn Paths (No Code Changes; Design Only)

**Spawn paths** in LVIS that will adopt the wrapper (5 total, D9 DECIDED in-scope):

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

5. **MCP child-process spawn** (D9 DECIDED: in-scope) — MCP tools invoked as subprocesses adopt `SandboxRunner.spawn()` as the 5th path. Same interface; no special MCP-specific runner.

---

## 6. Deployment & Distribution Model (D8 DECIDED: OS-only)

**Decision D8 DECIDED**: OS dependencies only. No bundled binaries. No hybrid path.

### OS-Dependency Model

**Linux**: `dnf install bubblewrap` (RHEL/CentOS/Fedora) or `apt install bubblewrap` (Debian/Ubuntu)
- LVIS boot calls `bwrap --version` to detect availability
- If absent: `detectSandboxCapability()` returns `{ kind: "none", confidence: "assumed" }`
- User notification: "bubblewrap not installed. Run `dnf install bubblewrap` for sandbox isolation."
- Reviewer operates with no-downgrade active (kind="none" triggers weak-sandbox predicate)

**macOS**: `/usr/bin/sandbox-exec` (OS-provided, always present on macOS 14/15)
- Detects via `sandbox-exec -n /dev/null true` (no-op test)
- Returns `kind: "sandbox-exec"`, `confidence: "policy-best-effort"` (PARTIAL)

**Windows**: AppContainer (OS-native capability in Windows 10+)
- LVIS boot runs AppContainer compat smoke test
- Pass → `kind: "appcontainer"`, `confidence: "verified-kernel"`
- Fail → `kind: "none"`, `confidence: "assumed"`, user notification

### Previously Considered: Binary Bundle vs. Hybrid (Rejected)

The original §6 proposed three options (A1 bundled, A2 OS-dependency, A3 hybrid). Decision D8 selects A2 (OS-dependency only):
- **A1 bundled** (rejected): binary verification audit burden, platform-specific build pipeline, update channel management — all out of scope.
- **A3 hybrid** (rejected): doubles audit surface; violates "No Fallback Code" principle per CLAUDE.md unless explicit deprecation plan exists. No deprecation plan was viable — hybrid is permanent cruft risk.

---

## 7. PARTIAL-Row Fallback Policy & Composition Rule Extension (DECIDED)

When an OS sandbox detection returns PARTIAL confidence or egress-block evidence is incomplete:

### Policy (D5 DECIDED: `kind="partial"`)

**DECIDED**: Introduce `kind: "partial"` to SandboxKind union — explicitly surfaces the compromise to users and composition rule.

- Effect: SandboxKind = `"none" | "bubblewrap" | "sandbox-exec" | "appcontainer" | "partial" | "fs-only"` (D6)
- UI label: "⚠ OS 격리 부분적" when `kind="partial"` or `kind="sandbox-exec"`
- Composition rule amendment: `kind="partial"` triggers no-downgrade (same as `kind="none"`)

Rejected alternatives (for reference only):
- **D5-a** (downgrade to kind="none"): loses the distinction "sandbox attempted but PARTIAL" vs "no sandbox at all". Rejected — less informative for users and audit trail.
- **D5-b** (refuse-to-launch): forces user action; interrupts workflows on macOS where sandbox-exec is the only available option. Rejected — too disruptive for PARTIAL rows.

### SandboxKind Union Extension (D6 DECIDED: add both "partial" + "fs-only")

Current: `"none" | "bubblewrap" | "sandbox-exec" | "appcontainer"`

After D5+D6:
```typescript
export type SandboxKind =
  | "none"              // no isolation active
  | "bubblewrap"        // Linux: verified-kernel network isolation
  | "sandbox-exec"      // macOS: policy-best-effort isolation (sandbox-exec + .sb profile)
  | "partial"           // OS-level isolation present but evidence quality is PARTIAL
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

## 8. Built-in Deployment & Admin Install Pathway (UPDATED — OS-only)

### Detection & User Notification Flow (replaces MSI installer model)

With D8 DECIDED (OS-only), no bundled installers or MSI auto-installs. LVIS handles missing sandbox via detection + notification:

**Boot sequence**:
1. LVIS boot calls `detectSandboxCapability()` per OS platform
2. Per-OS probe executes (e.g. `bwrap --version` on Linux, `sandbox-exec -n /dev/null true` on macOS, AppContainer compat test on Windows)
3. If probe succeeds: register runner, set appropriate `SandboxKind` + `confidence`
4. If probe fails: set `kind="none"`, `confidence="assumed"`
5. User notification (first boot only, dismissable): platform-specific install instruction
   - Linux: "Install bubblewrap: `sudo dnf install bubblewrap` (RHEL/CentOS) or `sudo apt install bubblewrap` (Debian/Ubuntu)"
   - Windows: "AppContainer incompatible with this configuration. Sandbox isolation unavailable."
6. Reviewer operates at isolation=none + no-downgrade composition rule active

**Auditing**: boot diagnostics record sandbox detection result + version (or failure reason) to `~/.lvis/audit.log`.

### Previously Considered: Lima / WSL2 MSI Installer (Rejected)

The original §8 described automatic Lima (macOS) and WSL2 (Windows) installation via LGE MSI installer. This approach was rejected in D2 (Lima 폐기) and D3 (WSL2 폐기). See §9 for full rationale.

---

## 9. Considered & Rejected Alternatives

### Option B1 — Everywhere-Container (Rejected)

Use Lima/WSL2/bwrap everywhere: all OSes route through a Linux container runtime.

**Invalidation**:
- Doubled audit surface: container orchestration + Linux profiles + host glue
- Unnecessary overhead on Linux (bwrap is already verified-kernel + lightweight)
- Opaque to Electron auto-update (app version != container image version)
- Per-tool latency penalty (10–20%) vs native (2–5% for AppContainer)
- **Decision**: rejected; native primary with OS-only dependency (D8).

### Option B2 — Linux-Container Runners for PARTIAL OS Rows (Considered and Rejected)

**Lima** (macOS fallback — rejected in D2):
- Was: one-time ~500 MB VM image download; 10–15% per-tool overhead; MIT license
- Was: shipped via signed LGE MSI installer, first-boot auto-run
- **Rejection rationale (D2)**: sandbox-exec PARTIAL accepted as sufficient for macOS. Lima adds ~500 MB bundle size, complex boot flow, and deployment pipeline complexity. PARTIAL isolation with user-visible warning is the correct trade-off. Lima bundling conflicts with D8 (OS-only deployment).

**WSL2** (Windows fallback — rejected in D3):
- Was: one-time ~3 GB distro download; 10–20% per-tool overhead; free Windows feature
- Was: shipped via signed LGE MSI installer, first-boot WSL2 init
- **Rejection rationale (D3)**: AppContainer-only for Windows. If AppContainer compat test fails, result is isolation=none — not WSL2. Adding WSL2 as fallback doubles the Windows deployment surface and conflicts with D8 (OS-only). No MSI auto-installer.

### Option C — Network-Only Isolation (Rejected)

Use only `unshare --net` (Linux), Network Extension filter (macOS), WFP (Windows) — no filesystem or process isolation.

**Invalidation**:
- Criterion 1 (egress block) is satisfied narrowly
- Criterion 1 (overall sandbox strength) is NOT — filesystem attack surface unrestricted
- Composition rule (`permission-reviewer-framework.ts:36`) presumes sandbox = meaningful isolation (fs + process + network)
- LLM reviewer would see `sandbox=true` without understanding that fs/process remain unrestricted — mis-calibration of the composition rule's protection value
- **Decision**: rejected; sandbox must isolate fs+process+network or not claim isolation.

---

## 10. Risks (Pre-Mortem) — Updated for D1–D9 Decisions

### Failure Scenario 1 — Linux bwrap Unavailable on Target

**Risk**: Deployment target (LGE corp Linux, RHEL 8/9 derivative) doesn't have `dnf list bubblewrap` or `bwrap` binary is too old (v0.4 lacks certain flags).

**Evidence Quality**: unverified (no LGE corp Linux audit yet).

**Mitigation** (updated for D1/D8 OS-only decision):
- Step 2 (external research phase) explicitly validates bwrap availability on RHEL 8/9
- Pre-deployment gate: automated bwrap version check in CI
- If unavailable: **no bundled fallback** — LVIS operates at isolation=none, reviewer no-downgrade active, user instructed to install bubblewrap via OS package manager
- LGE corp IT team must confirm `bubblewrap` package availability on target distros before launch

**Early Warning Signal**: If D1 research shows `dnf bwrap` absent on RHEL 8, escalate to infrastructure team. Mitigation is IT-side package install, not LVIS bundling.

### Failure Scenario 2 — Windows AppContainer + Electron asar Incompatibility

**Risk**: Electron + asar packaging + AppContainer capability registration conflict. Electron expects flat filesystem; AppContainer manifest expects signed/verified asar structure. Proof of compatibility unverified.

**Evidence Quality**: unverified (no Electron asar + AppContainer test yet).

**Mitigation** (updated for D3 AppContainer-only decision):
- Build epic includes `test-appcontainer-asar-compat.ts` smoke test (spin up AppContainer, execute asar app, verify sandbox enforcement works)
- If compat test fails: **no WSL2 fallback** — Windows operates at isolation=none + user notification + reviewer no-downgrade
- Documented in build epic: "compat test failure → isolation=none; WSL2 not available as escape hatch"

**Early Warning Signal**: If D3 compat test in build epic shows FAIL, log as architecture decision amendment. Windows sandbox becomes isolation=none until AppContainer compat is fixed.

### Failure Scenario 3 — macOS sandbox-exec Removal in macOS 16+

**Risk**: Apple removes `/usr/bin/sandbox-exec` in macOS 16+ (or future major). Current macOS 14/15 support is undocumented. No deprecation signal yet.

**Evidence Quality**: unverified (no Apple roadmap commitment).

**Mitigation** (updated for D2 Lima-폐기 decision):
- **No Lima fallback** — Lima was rejected in D2. Emergency runbook instead:
  - "If macOS 16 breaks sandbox-exec: swap SandboxExecRunner for NullRunner at boot (plist config change, no app re-release)"
  - Result: macOS isolation=none, reviewer no-downgrade active, user notification
- Quarterly monitoring: LVIS infra team watches Apple release notes for sandbox-exec deprecation signals

**Early Warning Signal**: If Apple WWDC or release notes mention sandbox-exec removal/deprecation, trigger pre-mortem audit. Resolution path is plist config swap to NullRunner, not Lima installation.

### Failure Scenario 4 — Wrapper Interface Lock-in Drift

**Risk**: Five spawn paths import `SandboxRunner.spawn()` before composition rule re-validation against new SandboxKind values. Later, decision items D5/D6 extend SandboxKind with `"partial"` or `"fs-only"`, but reviewer composition rule test fixtures aren't updated lockstep.

**Evidence Quality**: organizational (no technical blocker, but coordination failure mode).

**Mitigation**:
- Decision items D5 + D6 (SandboxKind extensions) DECIDED before build epic begins
- Build epic includes risk-classifier test fixture updates (`src/permissions/reviewer/risk-classifier.test.ts` lines ~309 + surrounding composition rule test cases) as mandatory gate
- No spawn-path code changes without concurrent risk-classifier.test.ts amendments
- R-1 context no-downgrade rule (§11.5) adds additional test cases for weak-context + weak-sandbox combinations

**Early Warning Signal**: Build epic review shows `SandboxKind` extension in source but NO test fixture change — block merge.

---

## 11. 결정 완료 (User Decision Items — All DECIDED 2026-05-16)

All decisions finalized. Build epic can start.

### Decision D1 — Linux Primary Sandbox Tool

**DECIDED: bwrap OS-only** (2026-05-16)

Selected option: **bwrap OS package only** — rely on `dnf install bubblewrap` (RHEL/CentOS) or `apt install bubblewrap` (Debian/Ubuntu). No bundled binary. No hybrid fallback.

Rationale: D8 (OS-only deployment) eliminates the bundled binary option. If bwrap unavailable: isolation=none + user install instruction.

Rejected options (for record):
- bwrap + landlock v4: deepens audit, minimal benefit over bwrap alone for v1
- bwrap bundled binary: conflicts with D8 OS-only decision
- bwrap + bundled fallback: conflicts with D8 OS-only decision + "No Fallback Code" rule

**Owner**: Infrastructure + Security team (validate bwrap package availability on LGE corp RHEL distros)

---

### Decision D2 — macOS Sandbox Strategy

**DECIDED: sandbox-exec PARTIAL accepted** (2026-05-16)

Selected option: Use `/usr/bin/sandbox-exec` as primary. Surface "⚠ OS 격리 부분적" to user. Accept known bypass paths. `kind="sandbox-exec"`, `confidence="policy-best-effort"`.

Rationale: Lima fallback adds ~500 MB bundle size and complex deployment flow. PARTIAL isolation with user-visible warning + composition rule no-downgrade is the correct trade-off. D8 (OS-only) eliminates Lima bundling.

Rejected options (for record):
- Lima fallback default: dropped — conflicts with D8, excessive bundle size
- Refuse-to-launch on PARTIAL OS: too disruptive on macOS where sandbox-exec is the only available mechanism

**Owner**: Product team (user setting UI design showing "부분적 격리" warning)

---

### Decision D3 — Windows Primary Sandbox Tool

**DECIDED: AppContainer only** (2026-05-16)

Selected option: AppContainer + Win32 Job Object as sole Windows sandbox. Build epic includes compat smoke test. If compat FAIL → isolation=none. No WSL2.

Rationale: WSL2 fallback adds ~3 GB install + MSI complexity. D8 (OS-only) eliminates WSL2 bundled install. AppContainer is OS-native (Windows 10+).

Rejected options (for record):
- WSL2 primary: 10–20% per-tool overhead, ~3 GB install, conflicts with D8
- AppContainer primary + WSL2 fallback: fallback conflicts with D8 + "No Fallback Code" rule

**Owner**: Engineering team (AppContainer + asar compat smoke test) + Product team (isolation=none notification on Windows)

---

### Decision D4 — Capability Descriptor Shape (ADR-level)

**DECIDED: Narrow allowlist** (2026-05-16)

Selected option: `{ networkBlocked: bool, fsReadPaths: string[], fsWritePaths: string[], processIsolated: bool }`

Rationale: simple, reviewer LLM can reason about boolean/path properties. Forward path to hybrid/OCI documented in ADR §Consequences.

**Owner**: Architecture team (ADR write-up) + Reviewer system prompt team (compose rule updates)

---

### Decision D5 — PARTIAL-Row Fallback Policy

**DECIDED: Introduce `kind="partial"`** (2026-05-16)

Selected option: `kind: "partial"` added to SandboxKind union. Explicit UI + composition rule amendment. Locked with D6.

**Owner**: Architecture team (composition rule amendment) + UI team (user messaging)

---

### Decision D6 — SandboxKind Union Extension

**DECIDED: Add both `"partial"` + `"fs-only"`** (2026-05-16)

Final union: `"none" | "bubblewrap" | "sandbox-exec" | "appcontainer" | "partial" | "fs-only"`

**Locked with**: D5

**Owner**: Architecture team (union definition + test fixture updates in risk-classifier.test.ts)

---

### Decision D7 — evaluation-context.ts Integration

**DECIDED: Keep prompt-side formatter** (2026-05-16)

Selected option: formatter at `sandbox-capability.ts:89-93` remains the canonical site. `evaluation-context.ts` interface unchanged.

**Owner**: Reviewer system prompt team (confirm formatter pathway sufficient)

---

### Decision D8 — Deployment Model (Binary vs. Dependency vs. Hybrid)

**DECIDED: OS dependencies only** (2026-05-16)

Selected option: all sandbox mechanisms sourced from OS. No bundled binaries. No hybrid fallback. No Lima/WSL2 auto-install MSI.

Rationale: bundling creates binary audit burden, platform-specific build pipeline, and update channel management. Hybrid conflicts with "No Fallback Code" rule without explicit removal date. OS-only is the clean path.

**Owner**: Build team (remove any bundled sandbox binary references from build pipeline) + Deployment team (OS package validation per LGE corp Linux distro)

---

### Decision D9 — MCP Child-Process Spawn Path Inclusion

**DECIDED: In-scope** (2026-05-16)

Selected option: MCP child-process spawns are the **5th spawn path**, unified through `SandboxRunner.spawn()`.

Rationale: MCP tools invoked as subprocesses carry the same egress/fs risk as other spawn paths. Excluding MCP would create an unmonitored escape hatch. `SandboxRunner` interface already supports arbitrary `cmd`/`args`.

**Owner**: Build epic planning team (MCP spawn path integration spec)

---

## 11.5 Reviewer & UX Design Directives (R-1 to R-4)

The following design rules supplement the composition rule framework and were
locked alongside the C1 sandbox decisions to address reviewer/UX scope gaps
surfaced during decision review (2026-05-16).

### R-1 — Context-quality no-downgrade rule

Extend the composition rule at `src/shared/permission-reviewer-framework.ts:36`:

> If conversation context lacks an explicit stated purpose/intent for the tool
> call, the LLM MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW.
> (Mirrors the weak-sandbox no-downgrade pattern.)

**Trigger detection**: reviewer evaluates whether `conversationContext` carries
an explicit intent signal (most recent user message or in-conversation
justification). LLM self-assessment is acceptable but must default to "weak"
when ambiguous.

**Test fixture**: `risk-classifier.test.ts` adds cases for empty-intent +
LLM=LOW + rule=MEDIUM → expected finalVerdict=MEDIUM.

---

### R-2 — User-approval memory layer

New storage: `~/.lvis/permissions/user-approvals.json` (per Storage Namespace
per Feature rule; 0o700 dir / 0o600 file).

Schema:
```json
{
  "approvals": {
    "<toolName>::<argHashSha256>::<source>": {
      "approvedAt": "ISO8601",
      "scope": "session|persistent",
      "verdictAtApproval": "low|medium|high",
      "nlJustification": "user-typed natural language (HIGH only)",
      "revokedAt": null
    }
  }
}
```

Reviewer flow integration:
1. Rule classifier runs
2. **User-approval memory lookup** — match → skip LLM, finalVerdict=APPROVE
   (sandbox kind/composition rule still evaluated for audit)
3. Miss → LLM classifier + composition rule

Pattern matching: exact (toolName + args SHA-256 + source). Argument-prefix or
fuzzy matching deferred to future epic.

Default scope: "session". User selects "persistent" via approval dialog
checkbox. UI revocation list lives in PermissionsTab.

---

### R-3 — Conversation-loop retry with intent enrichment

Reject response shape (returned from reviewer):
```ts
type RejectResponse = {
  verdict: "reject";
  reason: string;   // human-readable
  hint?: string;    // "providing X would make this approvable"
  retryable: boolean;
};
```

LLM loop behavior on reject:
- Read reason + hint
- Option A: enrich intent and retry SAME (toolName, args)
- Option B: ask user for clarification

Anti-abuse cap: max 2 automatic retries for identical (toolName, args). Beyond
that, escalate to user. Args modification resets the counter (fresh review),
preventing argument-narrowing exploit.

---

### R-4 — Natural-language explicit approval for HIGH risk

Trigger: composition rule finalVerdict = HIGH.

UI requirement (`src/ui/renderer/components/ToolApprovalDialog.tsx`):
- Display tool + args + reviewer reason + expected impact
- **Natural-language input field** with placeholder "이 작업의 목적을 한 문장으로 입력"
- Approve button disabled until NL field is non-empty
- NL text saved as `nlJustification` in R-2 memory + appended to audit.log

MEDIUM/LOW: existing button-only approval remains.

R-2 memory match for HIGH verdict: NL field still shown each time (no silent
re-approval). R-2 memory caches LOW/MEDIUM aggressively; HIGH always prompts NL.

---

### Cross-impact on C2 evaluation framework

- R-1 adds test scenario "D" to C2 §2: weak-context + benign tool → verdict
  shift measurement.
- R-2/R-3/R-4 audit fields added to S2 runtime audit JSON (see `network-restricted-eval.md` §3.6).

---

## 12. See Also

- `docs/research/network-restricted-eval.md` — Evaluation framework design (C2 deliverable); §3.6 S2 runtime audit JSON schema
- `docs/architecture/permission-policy-design.md` — Full permission policy specification
- `docs/architecture/architecture.md` — § 6 (Core Engines) sandbox capability layer context
- `.omc/plans/open-questions.md` — All 13 decision items from C1 + C2 (all DECIDED 2026-05-16)

---

**Research Status**: DECIDED (all D1–D9 finalized 2026-05-16 by user)

**Citation Verification**: All file:line citations in §1 have been grep-verified against current codebase.

**Evidence Sources**: Indexed via context-mode from bubblewrap GitHub, Landlock LSM docs, Windows AppContainer MSDN, Lima VM, Sandboxie-Plus GitHub (2026-05-15 snapshot).
