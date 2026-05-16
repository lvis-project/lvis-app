# Research: Network-Restricted Sandbox Evaluation Framework

**Status: DECIDED** (all E-D1–E-D5 finalized 2026-05-16)

**Issue**: #691 (sandbox capability + reviewer SOT integration)

**Date**: 2026-05-15 (created) / 2026-05-16 (decisions finalized)

**Scope**: C2 deliverable — evaluation framework design for validating that built-in sandbox blocks external network egress + observes reviewer verdict changes (design + decision items only; zero POC code)

---

## 1. Purpose

This document specifies how to validate that the sandbox implementation from `sandbox-isolation.md` (C1) actually blocks external network egress from sandboxed tool processes, and how reviewer verdicts change when isolation is detected.

**Key question**: Does the sandbox prevent a tool from exfiltrating data to external network?

**Secondary questions**:
- Can we reliably detect when egress is unexpectedly allowed?
- Does the reviewer verdict shift (e.g., LOW→MEDIUM) when sandbox evidence changes?
- What observability signals (audit logs, metrics) are necessary to audit the sandbox enforcement?

**Surface separation**: This document governs both S1 (dev validation, §2–§5) and S2 (runtime audit, §3.6). See `sandbox-isolation.md` intro for surface definitions.

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

### Scenario D — Weak-Context + Benign Tool (R-1 cross-impact)

**Setup** (added per R-1 design directive from `sandbox-isolation.md` §11.5):
- Tool: low-risk (e.g. `ls /tmp`) inside sandbox
- Conversation context: empty (no explicit user intent stated)
- sandboxKind: any (R-1 is independent of sandbox state)

**Expected outcome**:
- Rule classifier: LOW (benign tool)
- LLM classifier: LOW (benign tool + empty context)
- R-1 composition rule: context lacks explicit intent → LLM MUST NOT downgrade MEDIUM/HIGH
  - For LOW rule verdict: no R-1 trigger (rule is already LOW)
  - For MEDIUM rule verdict + empty context: LLM LOW → R-1 blocks → finalVerdict=MEDIUM

**Test fixture** (`risk-classifier.test.ts`):
- Case: `{ tool: "ls", context: "", sandboxKind: "bubblewrap", ruleVerdict: "medium", llmVerdict: "low" }` → `finalVerdict: "medium"`
- Case: `{ tool: "ls", context: "directory listing 위해 ls 사용", sandboxKind: "bubblewrap", ruleVerdict: "medium", llmVerdict: "low" }` → `finalVerdict: "medium"` (maxVerdict, not R-1 trigger)

---

## 3. Expanded Test Plan (Unit / Integration / E2E / Observability)

### Unit Tests — Per-Runner Egress Block

**Test scope**: each runner's egress-blocking capability in isolation (no full reviewer pipeline)

**Fixtures** (E-D2 DECIDED):
- Local HTTP server (`http://127.0.0.1:9999/test`) — always accessible (localhost) for unit-level isolation verification
- External test endpoint (`https://httpbin.org/get`) — blocked in sandbox, allowed outside
- Capability descriptor: `{ networkBlocked: true, fsReadPaths: ["/tmp"], fsWritePaths: ["/tmp"] }`

**Test cases**:

| Runner | Test | Expected Result |
|---|---|---|
| bwrap | curl to external URL inside bwrap | Connection refused / timeout |
| bwrap | curl to 127.0.0.1:9999 inside bwrap | Connection refused (loopback isolated unless explicitly allowed) |
| sandbox-exec | curl to external URL inside sandbox-exec with `(deny network*)` | Policy enforcement; bypass paths flagged as EVIDENCE-MISSING if not detected |
| AppContainer | curl to external URL inside AppContainer without internetClient capability | HRESULT_FROM_WIN32(ERROR_NETWORK_ACCESS_DENIED) |

**Note**: Lima and WSL2 runner unit tests removed — both runners dropped in D2/D3.

**Observability assertion**: each test emits audit log `"unit.sandbox_runner.${runner}.egress_test.blocked = true"`

---

### Integration Tests — Per-OS × Spawn-Path Matrix

**Test scope**: each of 5 spawn paths (D9: MCP in-scope) with each OS sandbox runner

**Matrix** (3 OS × 5 spawn paths):

| Spawn Path | Linux (bwrap) | macOS (sandbox-exec) | Windows (AppContainer) |
|---|---|---|---|
| **bash.ts** (shell exec) | Spawn `/bin/bash -c "curl https://..."` inside bwrap | Spawn `/bin/bash -c "curl https://..."` inside sandbox-exec | N/A (Bash is Unix-only) |
| **powershell.ts** (Windows shell) | N/A | N/A | Spawn `powershell -Command "Invoke-WebRequest https://..."` inside AppContainer |
| **python-runtime.ts** (uv subprocess) | Spawn `uv run script.py` (script calls `urllib.request.urlopen("https://...")`) inside bwrap | Spawn `uv run script.py` inside sandbox-exec | Spawn `uv.exe run script.py` inside AppContainer |
| **plugins/runtime.ts** (worker) | Spawn plugin worker JavaScript inside bwrap, worker makes fetch() call | Spawn plugin worker inside sandbox-exec | Spawn plugin worker inside AppContainer |
| **MCP child-process** (D9 in-scope) | Spawn MCP subprocess inside bwrap, subprocess attempts outbound connection | Spawn MCP subprocess inside sandbox-exec | Spawn MCP subprocess inside AppContainer |

**Test assertion**: all applicable cells show egress-block success (exit code ≠ 0, stderr contains network error)

**Observability**: integration log shows `"integration.spawn_path.${path}.sandbox.${runner}.egress_blocked = true"` per case

---

### E2E Tests — Full Reviewer Pipeline

**Test scope**: sandbox capability surfaced in approval UI + composition rule enforced

**Test case**: Tool request for `curl https://external-domain.com` (high-risk egress)

**Without sandbox**:
1. Rule-based classifier: category="network" + input="https://external-domain.com" → ruleVerdict=MEDIUM
2. LLM classifier: system prompt includes `executionSandbox=none` → llmVerdict=LOW (intent-based)
3. Composition rule: no-downgrade triggered (kind='none' is weak per D5/D6 composition rule)
4. Final verdict: ruleVerdict=MEDIUM (no downgrade allowed)

**With bwrap sandbox**:
1. Rule-based classifier: same as above → ruleVerdict=MEDIUM
2. LLM classifier: system prompt includes `executionSandbox=bubblewrap (verified-kernel, linux) — network egress blocked` → llmVerdict=LOW
3. Composition rule: isWeakSandbox() returns false (bwrap is verified-kernel, not weak) → no block
4. Final verdict: maxVerdict(MEDIUM, LOW) = MEDIUM

**With sandbox-exec (PARTIAL)**:
1. Rule-based classifier: → ruleVerdict=MEDIUM
2. LLM classifier: system prompt includes `executionSandbox=sandbox-exec (policy-best-effort, darwin) — network isolation via sandbox profile` → llmVerdict=LOW
3. Composition rule: isWeakSandbox() returns true (sandbox-exec is PARTIAL) → **LLM cannot downgrade MEDIUM → LOW**
4. Final verdict: ruleVerdict=MEDIUM (no downgrade allowed)

**Approval UI assertion**:
- testId `tool-approval-sandbox` is present
- Sandbox card renders with appropriate label ("⚠ OS 격리 없음" vs "OS 격리 활성 (bwrap)" vs "⚠ OS 격리 부분적 (sandbox-exec)")
- Verdict card shows ruleVerdict (MEDIUM) + composition rule blocking LLM downgrade (if applicable)

**R-4 HIGH verdict UI assertion** (new per R-4 directive):
- When finalVerdict=HIGH: ToolApprovalDialog shows NL input field ("이 작업의 목적을 한 문장으로 입력")
- Approve button disabled until NL field non-empty
- On approve: NL text captured in audit.log `reviewer.userApprovalUsed.nlJustification`

**Observability**: S2 audit log entry emitted (see §3.6).

---

### Observability — Audit Log & Telemetry (S1 Dev Signals)

**S1 telemetry counters** (dev validation signals):

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

---

### 3.6 S2 Runtime Audit JSON Schema (E-D5 DECIDED: `~/.lvis/audit.log`)

Every tool invocation emits one structured JSON entry to `~/.lvis/audit.log`.
Schema covers 4 fields: tool identity, sandbox state, reviewer verdict path, performance.

```json
{
  "timestamp": "ISO8601",
  "tool": {
    "name": "curl",
    "args": "https://httpbin.org/get",
    "source": "bash.ts|powershell.ts|python-runtime.ts|plugins/runtime.ts|mcp"
  },
  "sandbox": {
    "kind": "bubblewrap|sandbox-exec|appcontainer|partial|fs-only|none",
    "confidence": "verified-kernel|policy-best-effort|assumed",
    "events": [
      { "type": "egress_attempted", "blocked": true, "target": "https://httpbin.org/get" },
      { "type": "fs_write_attempted", "blocked": false, "path": "/tmp/out.txt" }
    ],
    "spawnLatencyMs": 12,
    "overheadPercent": 4.2
  },
  "reviewer": {
    "ruleVerdict": "medium",
    "llmVerdict": "low",
    "finalVerdict": "medium",
    "compositionRulesTriggered": [
      { "rule": "weak-sandbox-no-downgrade", "reason": "kind='partial'" },
      { "rule": "weak-context-no-downgrade", "reason": "intent_missing" }
    ],
    "userApprovalUsed": {
      "memoryHit": false,
      "nlJustification": "이 파일 디렉터리 조회 위해 ls 사용",
      "verdictAtApproval": "low"
    }
  }
}
```

**Field definitions**:

| Field path | Type | Description |
|---|---|---|
| `timestamp` | ISO8601 string | UTC timestamp of tool invocation |
| `tool.name` | string | Tool name (registry name, underscore format) |
| `tool.args` | string | Serialized tool arguments (truncated at 512 chars) |
| `tool.source` | string | Spawn path identifier — one of the 5 paths + MCP |
| `sandbox.kind` | SandboxKind | Active sandbox type (see D6 union: none/bubblewrap/sandbox-exec/appcontainer/partial/fs-only) |
| `sandbox.confidence` | string | Evidence quality: verified-kernel / policy-best-effort / assumed |
| `sandbox.events[]` | array | Runtime sandbox events: egress attempts, fs write attempts, blocked/allowed |
| `sandbox.spawnLatencyMs` | number | Time from SandboxRunner.spawn() call to process ready (ms) |
| `sandbox.overheadPercent` | number | Overhead vs unsandboxed baseline (gauge, updated per measurement window) |
| `reviewer.ruleVerdict` | low/medium/high | Output of rule-based classifier |
| `reviewer.llmVerdict` | low/medium/high | Output of LLM classifier |
| `reviewer.finalVerdict` | low/medium/high/approve/reject | After composition rule application |
| `reviewer.compositionRulesTriggered[]` | array | Each composition rule that fired, with reason |
| `reviewer.userApprovalUsed.memoryHit` | boolean | Whether R-2 user-approval memory matched (skipped LLM) |
| `reviewer.userApprovalUsed.nlJustification` | string | NL text entered by user (R-4, HIGH only); null for LOW/MEDIUM |
| `reviewer.userApprovalUsed.verdictAtApproval` | low/medium/high | Verdict level at time of user approval |

**Sink** (E-D5 DECIDED): `~/.lvis/audit.log` — single cross-cutting sink. Storage Namespace rule permits cross-cutting resources at `~/.lvis/` root.

---

## 4. Test Harness Outline (Design Only — No Code)

### Baseline Tool Selection (E-D1 DECIDED: curl)

**DECIDED**: `curl` as primary baseline tool.

Rationale: simplest, deterministic, widely available, clear success/failure signals.
- Three failure points: DNS (NXDOMAIN if blocked), socket (ECONNREFUSED if network namespace isolated), TLS (timeout if packet loss)
- Fallback: Python `urllib` for language runtime escape test (secondary)

Rejected options (for record):
- Python `urllib.request.urlopen()`: Python must be available in sandbox context (not guaranteed)
- Custom C binary: requires compilation per platform; less relatable to real tools

**Owner**: QA team (test harness implementation)

---

### Fixture Endpoint Hosting (E-D2 DECIDED: public httpbin.org + local 127.0.0.1:9999)

**DECIDED**: Public `https://httpbin.org/get` for E2E + local `http://127.0.0.1:9999` for unit tests.

- Unit tests (runner-level): local fixture ensures true network isolation (not localhost loopback escape)
- E2E tests (full reviewer): public endpoint (httpbin.org) for realism + CI simplicity

Rejected options (for record):
- Internal corp endpoint: requires corp VPN in CI, slower feedback on endpoint unreachable

**Owner**: Infrastructure (httpbin.org reliability SLA) + test team (local fixture server setup)

---

### Automated vs. Manual Evaluation (E-D3 DECIDED: hybrid)

**DECIDED**: Hybrid — unit CI / integration nightly / E2E manual.

- Unit tests: every PR (automated, fast, ~10 sec)
- Integration tests: nightly CI matrix (~30–60 sec per OS combo)
- E2E + full matrix: manual gate before each release candidate

Rejected options (for record):
- Fully automated (CI-gated): CI infra may not support sandboxing in containerized CI; flakes block PRs
- Manual post-build only: slow feedback loop; latent issues discovered post-build

**Owner**: Build team (CI/CD pipeline configuration)

---

## 5. Metrics & Measurement

### Reviewer Verdict Differential (E-D4 DECIDED: snapshot test)

**DECIDED**: Snapshot test approach.

- Baseline file: `sandbox-eval-verdicts.json`
- CI asserts snapshot matches baseline (regression detection)
- Regenerate snapshot after composition rule updates
- Testid: `risk-classifier.test.ts` adds `describe("sandbox-eval-verdicts")`

Rejected options (for record):
- Differential analysis: more complex to maintain; snapshot is simpler and auditable

**Owner**: Engineering team (test fixture design)

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

**Expected** (OS-native runners only; Lima/WSL2 dropped):
- bwrap: 2–5% overhead (namespace creation, bind mounts)
- sandbox-exec: 3–5% (profile policy evaluation)
- AppContainer: 2–5% (capability SID check)

**Percentiles**: p50, p95, p99 (detect tail latency spikes)

**Decision**: build epic gates on "no sandbox runner exceeds 30% overhead" (per disqualification criterion). If measured overhead breaches 30%, runner is FAIL and must be replaced.

---

## 6. Cross-Link to sandbox-isolation.md Decisions

The following decisions from C1 (sandbox-isolation.md) gate the eval framework:

- **D1** (Linux primary tool: bwrap OS-only) → Unit test fixture for bwrap launch + network namespace verification
- **D2** (macOS: sandbox-exec PARTIAL accepted, Lima dropped) → Integration test for sandbox-exec PARTIAL bypass detection; no Lima runner tests
- **D3** (Windows: AppContainer only, WSL2 dropped) → AppContainer compat test (must pass before AppContainer becomes primary); no WSL2 runner tests
- **D5** (PARTIAL-row: kind="partial") → E2E test for verdict shift when sandboxKind changes; test fixtures include kind="partial" cases
- **D6** (SandboxKind union: +partial +fs-only) → Test fixture updates for new kinds
- **D8** (deployment: OS-only) → Performance overhead measurement for OS-native runners only (no bundled runner benchmarks)
- **D9** (MCP in-scope) → 5th spawn path included in integration matrix

All C1 decisions DECIDED (2026-05-16). Evaluation framework can proceed.

---

## 7. 결정 완료 (User Decision Items — All DECIDED 2026-05-16)

### Decision E-D1 — Baseline Tool

**DECIDED: curl** (2026-05-16)

**Owner**: QA team (test harness implementation)

---

### Decision E-D2 — Fixture Endpoint Hosting

**DECIDED: Public httpbin.org (E2E) + local 127.0.0.1:9999 (unit)** (2026-05-16)

**Owner**: Infrastructure + test team

---

### Decision E-D3 — Automation Cadence

**DECIDED: Hybrid** — unit CI every PR / integration nightly / E2E manual per RC (2026-05-16)

**Owner**: Build team (CI/CD pipeline configuration)

---

### Decision E-D4 — Verdict Diff Measurement Method

**DECIDED: Snapshot test** (`sandbox-eval-verdicts.json`) (2026-05-16)

**Owner**: Engineering team (test fixture design)

---

### Decision E-D5 — Observability Sink

**DECIDED: Single `~/.lvis/audit.log`** (2026-05-16)

S2 runtime audit JSON (§3.6) appended to this sink. Storage Namespace rule: cross-cutting resource at `~/.lvis/` root.

**Owner**: Deployment + observability team (log retention, Splunk/ELK sink)

---

## 8. See Also

- `docs/research/sandbox-isolation.md` — Per-OS sandbox candidate evaluation + wrapper design (C1 deliverable); §11.5 R-1–R-4 design directives; Two Evaluation Surfaces
- `docs/architecture/permission-policy-design.md` — Composition rule specification
- `.omc/plans/open-questions.md` — All 13 decision items (C1 D1–D9 + C2 E-D1–E-D5), all DECIDED 2026-05-16

---

**Research Status**: DECIDED (all E-D1–E-D5 finalized 2026-05-16 by user)

**Evaluation Framework**: Design outline only. POC code implemented in post-research build epic after decisions finalized.
