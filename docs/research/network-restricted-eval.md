# Research: Network-Restricted Sandbox Evaluation Framework

**Status: pending approval**

**Issue**: #691 (sandbox capability + reviewer SOT integration)

**Date**: 2026-05-15

**Scope**: C2 deliverable — evaluation framework design for validating that built-in sandbox blocks external network egress + observes reviewer verdict changes (design + decision items only; zero POC code)

---

## 1. Purpose

This document specifies how to validate that the sandbox implementation from `sandbox-isolation.md` (C1) actually blocks external network egress from sandboxed tool processes, and how reviewer verdicts change when isolation is detected.

**Key question**: Does the sandbox prevent a tool from exfiltrating data to external network?

**Secondary questions**:
- Can we reliably detect when egress is unexpectedly allowed?
- Does the reviewer verdict shift (e.g., LOW→MEDIUM) when sandbox evidence changes?
- What observability signals (audit logs, metrics) are necessary to audit the sandbox enforcement?

---

## 2. Three-Scenario Evaluation Design

### Scenario A — Egress Successfully Blocked

**Setup**:
- Launch a test tool (e.g. `curl https://httpbin.org/get`) inside the sandbox
- Baseline runner: primary sandbox for this OS (bwrap on Linux, sandbox-exec on macOS, AppContainer on Windows)
- Capability descriptor: `{ networkBlocked: true, fsReadPaths: [...], ... }`

**Expected outcome**:
- Command exits with network error (ECONNREFUSED, timeout, "network unreachable", etc.)
- stderr shows connection failure
- Process exit code ≠ 0 (nonzero failure code)

**Observability**:
- Sandbox enforcement triggered: audit log entry `"sandbox.egress_block.triggered: true"`
- Telemetry counter: `sandbox.egress_block.triggered{runner="bwrap", kind="bubblewrap"} += 1`

**Verdict impact**: (none expected; tool failed before permission review)

---

### Scenario B — Egress Unexpectedly Allowed (Bypass Detection)

**Setup**:
- Same tool (`curl https://httpbin.org/get`) inside sandbox
- Baseline runner: sandbox-exec on macOS (known PARTIAL bypass paths: localhost IPv4/IPv6, system DNS, Bonjour)
- Capability descriptor: `{ networkBlocked: true, ... }`

**Expected outcome (if bypass occurs)**:
- Command succeeds; receives HTTP 200 response from httpbin.org
- Process exit code = 0 (success)
- stderr is empty; stdout contains response JSON

**Observability**:
- Sandbox enforcement failed: audit log entry `"sandbox.egress_block.triggered: false"`
- If egress succeeds unexpectedly, alert: `sandbox.egress_block.bypass_detected{runner="sandbox-exec", platform="darwin"}`

**Verdict impact**:
- Reviewer sees: `executionSandbox.kind = "sandbox-exec"` (PARTIAL evidence)
- Composition rule triggers: "kind='sandbox-exec' is PARTIAL; do not downgrade MEDIUM/HIGH"
- Example: rule says MEDIUM, LLM says LOW based on intent, composition rule enforces MEDIUM (no downgrade allowed)

---

### Scenario C — Verdict Distribution Under Sandbox State Change

**Setup**:
- Same tool (`curl`) invoked 3 times with identical input parameters, but different sandbox state:
  1. **sandbox=none** (baseline, no isolation)
  2. **sandbox=bwrap** (Linux: verified-kernel isolation)
  3. **sandbox=sandbox-exec** (macOS: PARTIAL isolation)

**Expected outcome**:
- Verdict distribution shifts based on composition rule strength
  - **No sandbox**: rule verdict may be downgraded by LLM (e.g. rule=MEDIUM, LLM=LOW → final=MEDIUM because maxVerdict)
  - **bwrap**: rule verdict is NOT downgraded (no-downgrade rule active)
  - **sandbox-exec**: rule verdict is NOT downgraded (PARTIAL counts as weak, triggers no-downgrade)

**Measurement**:
- Collect verdicts in a snapshot table: `(tool, input, sandboxKind) → (ruleVerdict, llmVerdict, finalVerdict)`
- Assertion: `finalVerdict ≥ ruleVerdict` always (no-downgrade enforced)
- Assertion: `finalVerdict` is identical across sandbox states for same rule verdict (sandbox cannot "improve" verdict, only prevent downgrade)

---

## 3. Expanded Test Plan (Unit / Integration / E2E / Observability)

### Unit Tests — Per-Runner Egress Block

**Test scope**: each runner's egress-blocking capability in isolation (no full reviewer pipeline)

**Fixtures**:
- Local HTTP server (e.g. `http://127.0.0.1:9999/test`) — always accessible (localhost)
- External test endpoint (e.g. `https://httpbin.org/status/200`) — blocked in sandbox, allowed outside
- Capability descriptor: `{ networkBlocked: true, fsReadPaths: ["/tmp"], fsWritePaths: ["/tmp"] }`

**Test cases**:

| Runner | Test | Expected Result |
|---|---|---|
| bwrap | curl to external URL inside bwrap | Connection refused / timeout |
| bwrap | curl to 127.0.0.1:9999 inside bwrap | Connection refused (loopback isolated unless explicitly allowed) |
| sandbox-exec | curl to external URL inside sandbox-exec with `(deny network*)` | Policy enforcement; bypass paths flagged as EVIDENCE-MISSING if not detected |
| AppContainer | curl to external URL inside AppContainer without internetClient capability | HRESULT_FROM_WIN32(ERROR_NETWORK_ACCESS_DENIED) |
| Lima | curl to external URL inside Lima container | Connection refused (Linux namespace) |
| WSL2 | curl to external URL via `wsl.exe` with isolated network | Connection error (WSL distro network isolated) |

**Observability assertion**: each test emits audit log `"unit.sandbox_runner.${runner}.egress_test.blocked = true"`

---

### Integration Tests — Per-OS × Spawn-Path Matrix

**Test scope**: each of 4 spawn paths with each OS sandbox runner

**Matrix** (3 OS × 4 spawn paths = 12 cases):

| Spawn Path | Linux (bwrap) | macOS (sandbox-exec) | Windows (AppContainer) |
|---|---|---|---|
| **bash.ts** (shell exec) | Spawn `/bin/bash -c "curl https://..."` inside bwrap | Spawn `/bin/bash -c "curl https://..."` inside sandbox-exec | N/A (Bash is Unix-only) |
| **powershell.ts** (Windows shell) | N/A (PowerShell on Linux is optional) | N/A (PowerShell on macOS available but less common spawn path) | Spawn `powershell -Command "Invoke-WebRequest https://..."` inside AppContainer |
| **python-runtime.ts** (uv subprocess) | Spawn `uv run script.py` (script calls `urllib.request.urlopen("https://...")`) inside bwrap | Spawn `uv run script.py` inside sandbox-exec | Spawn `uv.exe run script.py` inside AppContainer |
| **plugins/runtime.ts** (worker) | Spawn plugin worker JavaScript (node subprocess) inside bwrap, worker makes fetch() call | Spawn plugin worker inside sandbox-exec | Spawn plugin worker inside AppContainer |

**Test assertion**: all 12 cases show egress-block success (exit code ≠ 0, stderr contains network error)

**Observability**: integration log shows `"integration.spawn_path.${path}.sandbox.${runner}.egress_blocked = true"` per case

---

### E2E Tests — Full Reviewer Pipeline

**Test scope**: sandbox capability surfaced in approval UI + composition rule enforced

**Test case**: Tool request for `curl https://external-domain.com` (high-risk egress)

**Without sandbox**:
1. Rule-based classifier: category="network" + input="https://external-domain.com" → ruleVerdict=MEDIUM
2. LLM classifier: system prompt includes `executionSandbox=none` → llmVerdict=LOW (intent-based)
3. Composition rule: no-downgrade not triggered (kind='none' is not weak per composition rule trigger... *decision item D5/D6 determines exact semantics*)
4. Final verdict: maxVerdict(MEDIUM, LOW) = MEDIUM

**With bwrap sandbox**:
1. Rule-based classifier: same as above → ruleVerdict=MEDIUM
2. LLM classifier: system prompt includes `executionSandbox=bubblewrap (verified-kernel, linux) — network egress blocked` → llmVerdict=LOW
3. Composition rule: isWeakSandbox() returns false (bwrap is verified-kernel, not weak) → no block
4. Final verdict: maxVerdict(MEDIUM, LOW) = MEDIUM

**With sandbox-exec (PARTIAL)**:
1. Rule-based classifier: → ruleVerdict=MEDIUM
2. LLM classifier: system prompt includes `executionSandbox=sandbox-exec (policy-best-effort, darwin) — network isolation via sandbox profile` → llmVerdict=LOW
3. Composition rule: isWeakSandbox() returns true (sandbox-exec confidence='assumed' or kind='partial') → **LLM cannot downgrade MEDIUM → LOW**
4. Final verdict: ruleVerdict=MEDIUM (no downgrade allowed)

**Approval UI assertion**:
- testId `tool-approval-sandbox` is present
- Sandbox card renders with appropriate label ("⚠ OS 격리 없음" vs "OS 격리 활성 (bwrap)" vs "⚠ OS 격리 부분적 (sandbox-exec)")
- Verdict card shows ruleVerdict (MEDIUM) + composition rule blocking LLM downgrade (if applicable)

**Observability**: audit log includes:
- `approval_request{tool="curl", sandboxKind="bubblewrap"}`
- `reviewer_verdict{sandboxKind="bubblewrap", ruleVerdict="medium", llmVerdict="low", finalVerdict="medium"}`
- `composition_rule.no_downgrade_applied{reason="sandbox is PARTIAL or NONE"}`

---

### Observability — Audit Log & Telemetry

**Audit log entries** (structured JSON, one per tool invocation):

```json
{
  "timestamp": "2026-05-15T10:30:00Z",
  "tool": "curl",
  "sandboxCapability": {
    "kind": "bubblewrap",
    "confidence": "verified",
    "platform": "linux",
    "reason": "network egress blocked via Linux network namespace"
  },
  "ruleVerdict": { "level": "medium", "reason": "..." },
  "llmVerdict": { "level": "low", "reason": "..." },
  "compositionRuleApplied": {
    "rule": "no-downgrade",
    "triggered": true,
    "reason": "sandboxCapability.kind='bubblewrap' is verified-kernel, no downgrade block"
  },
  "finalVerdict": { "level": "medium" },
  "egressTest": {
    "attempted": true,
    "blocked": true,
    "evidence": "network namespace isolation verified"
  }
}
```

**Telemetry counters**:

```
# Sandbox enforcement
sandbox.egress_block.triggered{runner, kind, platform} = counter
sandbox.egress_block.bypassed{runner, kind, platform} = counter

# Reviewer composition
reviewer.composition_rule.no_downgrade{sandboxKind, triggered} = counter
reviewer.verdict{sandboxKind, ruleLevel, llmLevel, finalLevel} = counter
reviewer.downgrade_prevented{sandboxKind, previousLevel, attemptedLevel} = counter

# Performance overhead
sandbox.spawn_latency_ms{runner, kind, platform} = histogram (percentiles: p50, p95, p99)
sandbox.overhead_percent{runner, kind} = gauge (measured vs unsandboxed baseline)
```

**Observability sink** (decision item D5 in network-eval): audit.log vs separate sandbox-events.log per Storage Namespace rule
- Audit entries: append to `~/.lvis/audit.log` (cross-cutting resource)
- Sandbox telemetry: can go to `~/.lvis/audit.log` OR separate `~/.lvis/sandbox/events.log` per Storage Namespace design
- Recommendation: keep sandbox events in audit.log (single sink, simpler) unless volume becomes large (>100KB/day)

---

## 4. Test Harness Outline (Design Only — No Code)

### Baseline Tool Selection (Decision Item E-D1)

**Candidates**:
1. **`curl`** — simple HTTP client, widely available, clear success/failure
   - Pros: deterministic exit codes, stderr clarity
   - Cons: HTTPS cert validation may fail in isolated network (use HTTP for test fixture)
   
2. **Python `urllib.request.urlopen()`** — cross-platform, language-level
   - Pros: test the language runtime escape, not just OS utilities
   - Cons: Python must be available in sandbox context

3. **Custom test binary** — minimal C program attempting socket creation
   - Pros: lowest-level, minimal dependencies
   - Cons: requires compilation per platform; less relatable to real tools

**Recommendation**: Option 1 (`curl` as primary baseline)
- Simple HTTP test endpoint hostname resolution → socket creation → TLS handshake
- Three failure points: DNS (NXDOMAIN if blocked), socket (ECONNREFUSED if network namespace isolated), TLS (timeout if packet loss)
- Fallback: Python `urllib` for language runtime escape test

---

### Fixture Endpoint Hosting (Decision Item E-D2)

**Options**:
1. **Internal/private test endpoint** — LGE corp internal server (e.g. corp test VPC, requires corp VPN)
   - Pros: no external dependency, predictable availability
   - Cons: requires corp network access during CI, slower CI feedback if endpoint unreachable

2. **Public test endpoint** — httpbin.org, example.com, dedicated public test server
   - Pros: always available, zero corp network requirement
   - Cons: external dependency (network failure = test flake); potential for endpoint outage

3. **Local test fixture** — spin up `python -m http.server` on `127.0.0.1:9999` per test
   - Pros: zero network (all local), guaranteed available
   - Cons: tests localhost binding instead of external network (less realistic); macOS sandbox-exec localhost bypass would pass this test

**Recommendation**: Option 2 (public test endpoint) for E2E + Option 3 (local fixture) for unit tests
- Unit tests (runner-level): local fixture ensures true network isolation (not localhost loopback escape)
- E2E tests (full reviewer): public endpoint (httpbin.org) for realism + CI simplicity
- Fallback to local if external endpoint unavailable (graceful degradation)

---

### Automated vs. Manual Evaluation (Decision Item E-D3)

**Options**:
1. **Automated (CI-gated)** — sandbox tests run in CI; failure blocks merge
   - Frequency: every PR + nightly full matrix
   - Pros: early detection, regression prevention
   - Cons: CI infra must support sandboxing (may not work in containerized CI); flakes can block PRs

2. **Manual (post-build)** — sandbox tests run by deployment team after build, before release
   - Frequency: per release candidate
   - Pros: production-like environment (real Linux, macOS, Windows VMs)
   - Cons: slower feedback loop, latent issues discovered post-build

3. **Hybrid** — unit tests (small, fast) in CI; integration/E2E in post-build manual
   - Frequency: unit in every PR; integration nightly in CI; E2E manual per RC
   - Pros: balance speed + coverage
   - Cons: dual test infrastructure

**Recommendation**: Option 3 (hybrid)
- Unit tests: always automated (fast, 10 sec)
- Integration tests: nightly CI matrix (30–60 sec per OS combo)
- E2E + full matrix: manual gate before release (comprehensive coverage)
- Decision: build epic defines which tests are required for PR merge vs. release

---

## 5. Metrics & Measurement

### Reviewer Verdict Differential (Decision Item E-D4)

**Measurement method**: Snapshot test vs. differential test

**Snapshot approach**:
- Run 100 tool invocations with sandboxKind={none, bwrap, sandbox-exec}
- Collect (tool, input, sandboxKind) → (ruleVerdict, llmVerdict, finalVerdict) tuples
- Generate snapshot JSON: `sandbox-eval-verdicts.json`
- In CI: assert snapshot matches baseline (regression detection)

**Differential approach**:
- Run 50 pairs of invocations: (sandboxKind=none, input=X) vs (sandboxKind=bwrap, input=X)
- Measure verdict shift: ΔLevel = (finalVerdict_bwrap − finalVerdict_none)
- Expected: ΔLevel ∈ {0, +1} (same or upgraded, never downgraded)
- Counter-example (regression): ΔLevel = −1 (sandbox caused downgrade, violates composition rule)

**Recommendation**: Snapshot test
- Simpler: regenerate baseline after composition rule updates
- Auditable: snapshot file shows exact verdicts that passed review
- Testid: `risk-classifier.test.ts` adds `describe("sandbox-eval-verdicts")`

---

### Egress Block Rate

**Metrics**:
- `egress_block_success_rate = (attempts where exit_code ≠ 0) / total_attempts`
- Expected: 100% for bwrap (verified-kernel)
- Expected: 95–99% for sandbox-exec (PARTIAL, allow small bypass rate due to test environment variance)
- Expected: 100% for AppContainer (verified-kernel)

**Measurement**: per runner, per OS, per tool type (curl vs python vs shell)

---

### Performance Overhead Percentile

**Measurement**: tool latency inside sandbox vs. unsandboxed baseline

```
baseline_latency = run(tool, sandboxKind=none, iterations=10)  # mean
sandboxed_latency = run(tool, sandboxKind=bwrap, iterations=10)
overhead_percent = (sandboxed_latency - baseline_latency) / baseline_latency * 100
```

**Expected**:
- bwrap: 2–5% overhead (namespace creation, bind mounts)
- sandbox-exec: 3–5% (profile policy evaluation)
- AppContainer: 2–5% (capability SID check)
- Lima: 10–20% (container intercommunication + file sync)
- WSL2: 10–20% (WSL intercommunication)

**Percentiles**: p50, p95, p99 (detect tail latency spikes)

**Decision**: build epic gates on "no sandbox runner exceeds 30% overhead" (per disqualification criterion). If measured overhead breaches 30%, runner is FAIL and must be replaced.

---

## 6. Cross-Link to sandbox-isolation.md Decisions

The following decisions from C1 (sandbox-isolation.md) gate the eval framework:

- **D1** (Linux primary tool) → Unit test fixture for bwrap launch + network namespace verification
- **D2** (macOS sandbox strategy) → Integration test for sandbox-exec PARTIAL bypass detection
- **D3** (Windows primary tool) → AppContainer compat test (must pass before AppContainer becomes primary)
- **D5** (PARTIAL-row fallback policy) → E2E test for verdict shift when sandboxKind changes
- **D6** (SandboxKind union extension) → Test fixture updates for any new kinds (e.g., "partial", "fs-only")
- **D8** (deployment model) → Performance overhead measurement for bundled vs. OS-native runners

**Evaluation cannot proceed** until D1–D3 decisions are finalized (can be done post-research in build epic).

---

## 7. 결정 필요 (User Decision Items)

### Decision E-D1 — Baseline Tool

**Options**: curl (HTTP) vs Python urllib vs custom binary

**Recommendation**: curl
- Rationale: simplest, deterministic, widely available, clear success/failure signals

**Owner**: QA team (test harness implementation)

---

### Decision E-D2 — Fixture Endpoint Hosting

**Options**: internal LGE endpoint vs public (httpbin.org) vs local (127.0.0.1:9999)

**Recommendation**: public endpoint (httpbin.org) for E2E + local for unit
- Rationale: E2E realism requires external network (tests the actual scenario); unit tests can use local for isolation verification

**Owner**: Infrastructure (httpbin.org reliability) or test team (fallback plan if endpoint unavailable)

---

### Decision E-D3 — Automation Cadence

**Options**: fully automated (CI-gated) vs manual post-build vs hybrid

**Recommendation**: hybrid (unit in CI, integration nightly, E2E manual)
- Rationale: unit tests are fast (PR feedback); integration/E2E are comprehensive but slower (release gate)

**Owner**: Build team (CI/CD pipeline configuration)

---

### Decision E-D4 — Verdict Diff Measurement Method

**Options**: snapshot test vs differential analysis

**Recommendation**: snapshot test
- Rationale: simpler, auditable, integrates with risk-classifier.test.ts

**Owner**: Engineering team (test fixture design)

---

### Decision E-D5 — Observability Sink

**Options**: append to `~/.lvis/audit.log` (single sink) vs separate `~/.lvis/sandbox/events.log` (Storage Namespace rule)

**Recommendation**: single `~/.lvis/audit.log` (unless volume >100KB/day, then move to `~/.lvis/sandbox/`)
- Rationale: simpler, unified audit trail; Storage Namespace rule allows cross-cutting resources at `~/.lvis/` root

**Owner**: Deployment + observability team (log retention, Splunk/ELK sink)

---

## 8. See Also

- `docs/research/sandbox-isolation.md` — Per-OS sandbox candidate evaluation + wrapper design (C1 deliverable)
- `docs/architecture/permission-policy-design.md` — Composition rule specification
- `.omc/plans/open-questions.md` — All 13 decision items (C1 D1–D9 + C2 E-D1–E-D5)

---

**Research Status**: pending approval (awaiting user decisions E-D1–E-D5 + cross-link to C1 decisions D1–D8)

**Evaluation Framework**: Design outline only. POC code will be implemented in post-research build epic after user decisions are finalized.
