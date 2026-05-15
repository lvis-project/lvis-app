# Open Questions — Sandbox Isolation Research (2026-05-15)

Research deliverables: `docs/research/sandbox-isolation.md` (C1) + `docs/research/network-restricted-eval.md` (C2)

All decisions below are **required** before the build epic can start. User approval needed.

---

## C1 — Sandbox Isolation & Wrapper Interface (sandbox-isolation.md)

### D1 — Linux Primary Sandbox Tool

- [ ] Option: bwrap only (OS package)
- [ ] Option: bwrap + landlock v4 (fs hardening)
- [ ] Option: bwrap bundled binary
- [ ] Option: bwrap + bundled fallback (hybrid, **RECOMMENDED**)

**Decision**: pending user approval

---

### D2 — macOS Sandbox Strategy

- [ ] Option: sandbox-exec PARTIAL accepted (user visible "부분적 격리")
- [ ] Option: Lima fallback default (day-1 shipped, **RECOMMENDED**)
- [ ] Option: refuse-to-launch on PARTIAL OS

**Decision**: pending user approval

**Note**: locked with decision to deploy Lima (~500 MB one-time install via MSI)

---

### D3 — Windows Primary Sandbox Tool

- [ ] Option: AppContainer+Job Object primary (verify compat test first)
- [ ] Option: WSL2 primary (verified-kernel, 10–20% overhead)
- [ ] Option: AppContainer primary + WSL2 fallback (compat-test-gated, **RECOMMENDED**)

**Decision**: pending user approval

**Note**: build epic must include AppContainer+asar compatibility test; if FAIL, fallback to WSL2 automatically

---

### D4 — Capability Descriptor Shape (ADR-level)

- [ ] Option: narrow allowlist `{ networkBlocked, fsReadPaths, fsWritePaths, processIsolated }` (**RECOMMENDED**)
- [ ] Option: OCI-style fine-grained `{ capabilities, syscalls, namespaces, rlimits }`
- [ ] Option: hybrid (v1 narrow + v2 OCI extension path)

**Decision**: pending user approval

**Consequence**: affects reviewer LLM composition rule modeling; locks 4+ spawn-path interface

---

### D5 — PARTIAL-Row Fallback Policy

- [ ] Option: downgrade to `kind="none"` (existing composition rule unchanged)
- [ ] Option: refuse-to-launch on PARTIAL OS
- [ ] Option: introduce `kind="partial"` to SandboxKind union (**RECOMMENDED**)

**Decision**: pending user approval

**Locked with**: D6 (union extension must happen if D5-c chosen)

---

### D6 — SandboxKind Union Extension

- [ ] Option: keep current 4-member union (none, bubblewrap, sandbox-exec, appcontainer)
- [ ] Option: add `"partial"` for PARTIAL-evidence rows
- [ ] Option: add `"fs-only"` for landlock-only registrations
- [ ] Option: add both `"partial"` + `"fs-only"` (**RECOMMENDED**)

**Decision**: pending user approval

**Locked with**: D5 (must do D5-c + D6 together)

**Consequence**: risk-classifier.test.ts fixtures must be updated lockstep (test gate in build epic)

---

### D7 — evaluation-context.ts Integration

- [ ] Option: extend interface with `executionSandbox?: SandboxCapability` field
- [ ] Option: keep prompt-side rendering via formatter (**RECOMMENDED**)

**Decision**: pending user approval

**Note**: if Option 1, change site is `src/permissions/evaluation-context.ts`

---

### D8 — Deployment Model (Binary vs. Dependency vs. Hybrid)

- [ ] Option: bundled binaries only (app resources)
- [ ] Option: OS dependencies only (system packages)
- [ ] Option: hybrid (prefer OS, fallback bundled) (**RECOMMENDED**)

**Decision**: pending user approval

**Critical**: if hybrid chosen, **explicit deprecation plan + removal date** required per CLAUDE.md "No Fallback Code" rule. Example: "Bundled fallback removed Q3 2026 after all deployments confirm OS availability."

**Consequence**: affects binary bundling, version management, security audit scope

---

### D9 — MCP Child-Process Spawn Path Inclusion

- [ ] Option: in-scope (MCP subprocesses adopt SandboxRunner; 5th spawn path)
- [ ] Option: out-of-scope (defer post-research) (**RECOMMENDED**)

**Decision**: pending user approval

**Note**: MCP has its own capability model; can be evaluated separately

---

## C2 — Network-Restricted Evaluation Framework (network-restricted-eval.md)

### E-D1 — Baseline Tool Selection

- [ ] Option: `curl` (HTTP client, **RECOMMENDED**)
- [ ] Option: Python `urllib.request.urlopen()`
- [ ] Option: custom C binary

**Decision**: pending user approval

---

### E-D2 — Fixture Endpoint Hosting

- [ ] Option: internal LGE corp endpoint
- [ ] Option: public (httpbin.org) (**RECOMMENDED**)
- [ ] Option: local (127.0.0.1:9999) for unit only

**Decision**: pending user approval

**Note**: E2E uses public; unit tests use local for isolation verification

---

### E-D3 — Automated vs. Manual Evaluation Cadence

- [ ] Option: fully automated (CI-gated)
- [ ] Option: manual post-build
- [ ] Option: hybrid (unit in CI, integration nightly, E2E manual) (**RECOMMENDED**)

**Decision**: pending user approval

---

### E-D4 — Verdict Diff Measurement Method

- [ ] Option: snapshot test (**RECOMMENDED**)
- [ ] Option: differential analysis (pair-wise comparison)

**Decision**: pending user approval

**Consequence**: affects risk-classifier.test.ts structure (snapshot JSON file vs. differential metric)

---

### E-D5 — Observability Sink

- [ ] Option: `~/.lvis/audit.log` (single sink) (**RECOMMENDED**)
- [ ] Option: separate `~/.lvis/sandbox/events.log` (if volume >100KB/day, defer split)

**Decision**: pending user approval

**Note**: Storage Namespace rule allows both; single sink is simpler for v1

---

## Recommendation Summary

| Decision | Recommended Option |
|---|---|
| D1 | bwrap + bundled fallback (hybrid) |
| D2 | Lima fallback default (shipped day-1) |
| D3 | AppContainer primary + WSL2 fallback (compat-test-gated) |
| D4 | Narrow allowlist (v1 simplicity; v2 OCI expansion path documented) |
| D5 | Introduce `kind="partial"` |
| D6 | Add both `"partial"` + `"fs-only"` |
| D7 | Keep prompt-side formatter (minimal change) |
| D8 | Hybrid (prefer OS, bundled fallback) + explicit deprecation plan |
| D9 | Out-of-scope (defer post-research) |
| E-D1 | curl |
| E-D2 | Public (httpbin.org) for E2E + local for unit |
| E-D3 | Hybrid automation (unit CI, integration nightly, E2E manual) |
| E-D4 | Snapshot test |
| E-D5 | Single `audit.log` |

---

## Approval Gate

**All 13 decisions above must be approved by user before build epic can start.**

Research deliverables are complete + in pending-approval status. User decision checklist:
- [ ] D1–D9 (C1 sandbox isolation)
- [ ] E-D1–E-D5 (C2 network evaluation)
- [ ] Confirmed recommendations align with LVIS architecture + deployment constraints

Once approved, build epic can proceed with implementation of SandboxRunner + per-OS runners (Linux bwrap, macOS sandbox-exec/Lima, Windows AppContainer/WSL2) + wrapper interface integration at 4 spawn paths + reviewer composition rule amendments + observability pipeline.

---

**Date**: 2026-05-15

**Researcher**: Writer (oh-my-claudecode:writer)

**Status**: pending user approval
