# Open Questions — Sandbox Isolation Research (2026-05-15)

Research deliverables: `docs/research/sandbox-isolation.md` (C1) + `docs/research/network-restricted-eval.md` (C2)

All decisions below are **required** before the build epic can start.

---

## C1 — Sandbox Isolation & Wrapper Interface (sandbox-isolation.md)

### D1 — Linux Primary Sandbox Tool

- [ ] Option: bwrap only (OS package)
- [ ] Option: bwrap + landlock v4 (fs hardening)
- [ ] Option: bwrap bundled binary
- [x] ~~Option: bwrap + bundled fallback (hybrid, **RECOMMENDED**)~~

**DECIDED: bwrap OS-only** (2026-05-16, user)
- bwrap sourced from OS package only (`dnf install bubblewrap` on RHEL/Linux).
- Bundled binary option dropped entirely — no in-app binary bundling.
- If `bwrap` unavailable on target (e.g. RHEL without bubblewrap package): isolation=none, LLM reviewer operates in conservative no-downgrade mode.
- No bundled fallback runner. No hybrid path.

---

### D2 — macOS Sandbox Strategy

- [x] ~~Option: sandbox-exec PARTIAL accepted (user visible "부분적 격리")~~ — **DECIDED**
- [ ] Option: Lima fallback default (day-1 shipped, ~~RECOMMENDED~~)
- [ ] Option: refuse-to-launch on PARTIAL OS

**DECIDED: sandbox-exec PARTIAL accepted** (2026-05-16, user)
- Use `/usr/bin/sandbox-exec` as primary isolation on macOS.
- Surface "⚠ OS 격리 부분적" to user via UI; accept known bypass paths (localhost/IPv6/DNS/Bonjour/UDS).
- Lima fallback **폐기** — not shipped, not bundled.

---

### D3 — Windows Primary Sandbox Tool

- [x] ~~Option: AppContainer+Job Object primary (verify compat test first)~~ — **DECIDED**
- [ ] Option: WSL2 primary (verified-kernel, 10–20% overhead)
- [ ] Option: AppContainer primary + WSL2 fallback (compat-test-gated, ~~RECOMMENDED~~)

**DECIDED: AppContainer only** (2026-05-16, user)
- AppContainer + Win32 Job Object is the sole Windows sandbox mechanism.
- WSL2 fallback **폐기** — not shipped, not auto-installed via MSI.
- Build epic still includes AppContainer+asar compat smoke test; if test FAIL, result is isolation=none (no WSL2 escape hatch).

---

### D4 — Capability Descriptor Shape (ADR-level)

- [x] ~~Option: narrow allowlist `{ networkBlocked, fsReadPaths, fsWritePaths, processIsolated }` (**RECOMMENDED**)~~
- [ ] Option: OCI-style fine-grained `{ capabilities, syscalls, namespaces, rlimits }`
- [ ] Option: hybrid (v1 narrow + v2 OCI extension path)

**DECIDED: Narrow allowlist** (2026-05-16, user)
- V1 shape: `{ networkBlocked: bool, fsReadPaths: string[], fsWritePaths: string[], processIsolated: bool }`.
- Reviewer LLM can reason directly about boolean/path properties. Forward path (v2 OCI hybrid) documented in ADR §Consequences.

---

### D5 — PARTIAL-Row Fallback Policy

- [ ] Option: downgrade to `kind="none"` (existing composition rule unchanged)
- [ ] Option: refuse-to-launch on PARTIAL OS
- [x] ~~Option: introduce `kind="partial"` to SandboxKind union (**RECOMMENDED**)~~

**DECIDED: Introduce `kind="partial"`** (2026-05-16, user)
- Explicit `"partial"` SandboxKind surfaces the compromise to users and composition rule.
- Composition rule: if `kind="partial"`, LLM MUST NOT downgrade MEDIUM/HIGH verdict.
- Locked with D6.

---

### D6 — SandboxKind Union Extension

- [ ] Option: keep current 4-member union (none, bubblewrap, sandbox-exec, appcontainer)
- [ ] Option: add `"partial"` for PARTIAL-evidence rows
- [ ] Option: add `"fs-only"` for landlock-only registrations
- [x] ~~Option: add both `"partial"` + `"fs-only"` (**RECOMMENDED**)~~

**DECIDED: Add both `"partial"` + `"fs-only"`** (2026-05-16, user)
- Final union: `"none" | "bubblewrap" | "sandbox-exec" | "appcontainer" | "partial" | "fs-only"`.
- `"partial"`: OS isolation present but evidence quality is PARTIAL (macOS sandbox-exec, bwrap unavailable).
- `"fs-only"`: filesystem-only isolation (landlock without network namespace).
- risk-classifier.test.ts fixtures must be updated lockstep (test gate in build epic).

---

### D7 — evaluation-context.ts Integration

- [ ] Option: extend interface with `executionSandbox?: SandboxCapability` field
- [x] ~~Option: keep prompt-side rendering via formatter (**RECOMMENDED**)~~

**DECIDED: Keep prompt-side formatter** (2026-05-16, user)
- Formatter (`sandbox-capability.ts:89-93`) remains the canonical site for capability → prompt translation.
- `evaluation-context.ts` interface unchanged. No new field injection.

---

### D8 — Deployment Model (Binary vs. Dependency vs. Hybrid)

- [ ] Option: bundled binaries only (app resources)
- [x] ~~Option: OS dependencies only (system packages)~~ — **DECIDED**
- [ ] Option: hybrid (prefer OS, fallback bundled) ~~(**RECOMMENDED**)~~

**DECIDED: OS dependencies only** (2026-05-16, user)
- All sandbox binaries (bwrap on Linux, sandbox-exec on macOS, AppContainer on Windows) sourced from OS.
- No bundled binaries. No hybrid fallback path. No Lima/WSL2 auto-install MSI.
- First boot: LVIS detects sandbox availability via OS probes. If unavailable: user-visible notification + reviewer operates at isolation=none with no-downgrade active.
- Binary bundling, version management of bundled tools, and signing pipeline: **all out of scope**.

---

### D9 — MCP Child-Process Spawn Path Inclusion

- [x] ~~Option: in-scope (MCP subprocesses adopt SandboxRunner; 5th spawn path)~~ — **DECIDED**
- [ ] Option: out-of-scope (defer post-research) ~~(**RECOMMENDED**)~~

**DECIDED: In-scope** (2026-05-16, user)
- MCP child-process spawns are the 5th spawn path, unified through `SandboxRunner.spawn()`.
- All 5 spawn paths (bash.ts, powershell.ts, python-runtime.ts, plugins/runtime.ts, MCP child-process) adopt the same wrapper interface.

---

## C2 — Network-Restricted Evaluation Framework (network-restricted-eval.md)

### E-D1 — Baseline Tool Selection

- [x] ~~Option: `curl` (HTTP client, **RECOMMENDED**)~~
- [ ] Option: Python `urllib.request.urlopen()`
- [ ] Option: custom C binary

**DECIDED: curl** (2026-05-16, user)
- Primary baseline tool for all sandbox egress tests.

---

### E-D2 — Fixture Endpoint Hosting

- [ ] Option: internal corp endpoint
- [x] ~~Option: public (httpbin.org) (**RECOMMENDED**)~~
- [x] ~~Option: local (127.0.0.1:9999) for unit only~~

**DECIDED: Public httpbin.org (E2E) + local 127.0.0.1:9999 (unit)** (2026-05-16, user)
- E2E tests: `https://httpbin.org/get` for external network realism.
- Unit tests: local `127.0.0.1:9999` for runner-level isolation verification.

---

### E-D3 — Automated vs. Manual Evaluation Cadence

- [ ] Option: fully automated (CI-gated)
- [ ] Option: manual post-build
- [x] ~~Option: hybrid (unit in CI, integration nightly, E2E manual) (**RECOMMENDED**)~~

**DECIDED: Hybrid** (2026-05-16, user)
- Unit tests: every PR (automated, fast).
- Integration tests: nightly CI matrix.
- E2E tests: manual gate before each release candidate.

---

### E-D4 — Verdict Diff Measurement Method

- [x] ~~Option: snapshot test (**RECOMMENDED**)~~
- [ ] Option: differential analysis (pair-wise comparison)

**DECIDED: Snapshot test** (2026-05-16, user)
- Baseline file: `sandbox-eval-verdicts.json`.
- CI asserts snapshot matches. Regenerate after composition rule updates.

---

### E-D5 — Observability Sink

- [x] ~~Option: `~/.lvis/audit.log` (single sink) (**RECOMMENDED**)~~
- [ ] Option: separate `~/.lvis/sandbox/events.log` (if volume >100KB/day, defer split)

**DECIDED: Single `~/.lvis/audit.log`** (2026-05-16, user)
- All sandbox + reviewer events appended to single cross-cutting audit log.
- Storage Namespace rule: `~/.lvis/audit.log` is a cross-cutting resource (acceptable at root).

---

## Recommendation Summary

| Decision | Decided Option | Status |
|---|---|---|
| D1 | bwrap OS-only (no bundled binary) | DECIDED 2026-05-16 |
| D2 | sandbox-exec PARTIAL accepted (Lima 폐기) | DECIDED 2026-05-16 |
| D3 | AppContainer only (WSL2 fallback 폐기) | DECIDED 2026-05-16 |
| D4 | Narrow allowlist | DECIDED 2026-05-16 |
| D5 | Introduce `kind="partial"` | DECIDED 2026-05-16 |
| D6 | Add both `"partial"` + `"fs-only"` | DECIDED 2026-05-16 |
| D7 | Keep prompt-side formatter | DECIDED 2026-05-16 |
| D8 | OS dependencies only (bundling 전면 폐기) | DECIDED 2026-05-16 |
| D9 | In-scope (5th spawn path via SandboxRunner) | DECIDED 2026-05-16 |
| E-D1 | curl | DECIDED 2026-05-16 |
| E-D2 | Public httpbin.org (E2E) + local 127.0.0.1:9999 (unit) | DECIDED 2026-05-16 |
| E-D3 | Hybrid (unit CI / integration nightly / E2E manual) | DECIDED 2026-05-16 |
| E-D4 | Snapshot test (`sandbox-eval-verdicts.json`) | DECIDED 2026-05-16 |
| E-D5 | Single `~/.lvis/audit.log` | DECIDED 2026-05-16 |

---

## Approval Gate

**All 13 decisions above: DECIDED (2026-05-16, user).**

Build epic can proceed with implementation of:
- SandboxRunner + per-OS runners (Linux bwrap OS-only, macOS sandbox-exec PARTIAL, Windows AppContainer-only)
- Wrapper interface integration at 5 spawn paths (bash.ts, powershell.ts, python-runtime.ts, plugins/runtime.ts, MCP child-process)
- Reviewer composition rule amendments (D5/D6 SandboxKind extensions)
- Observability pipeline → `~/.lvis/audit.log` (S2 runtime audit, 4-field JSON schema per network-restricted-eval.md §3.6)
- R-1 context no-downgrade rule, R-2 user-approval memory, R-3 LLM retry with intent, R-4 HIGH NL approval (see sandbox-isolation.md §11.5)

---

**Date**: 2026-05-15 (created) / 2026-05-16 (all decisions finalized)

**Researcher**: Writer (oh-my-claudecode:writer)

**Decider**: user (2026-05-16)

**Status**: DECIDED — build epic ready
