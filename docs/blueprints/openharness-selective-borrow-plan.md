# OpenHarness Selective Borrow Plan

> **Status**: Design / executed — 2026-04-15
> **Upstream**: [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) v0.1.6 (MIT License, Python CLI agent harness)
> **Decision**: Reject full fork, adopt **selective TS port + architectural inspiration**
> **Phase**: Executed as PRs #3~#7 landing on `refactor/phase3-folder-reorg`

---

## 1. Context

HKUDS/OpenHarness (9.7k stars, 14 days old at discovery, MIT) is a Python re-implementation of Claude Code's agent harness — 42 tools, plugin ecosystem, permission hooks, memory, MCP client, swarm coordination. Initial enthusiasm suggested forking as a LVIS host replacement. Deep analysis rejected the fork because:

| Axis | LVIS | OpenHarness | Verdict |
|---|---|---|---|
| Runtime | Electron + Node + TypeScript | Python 3.10+ + Ink TUI | 🔴 incompatible |
| UI target | Desktop DOM + Korean UX | Terminal TUI (Ink) | 🔴 incompatible |
| Distribution | Electron installer (MSI/dmg) | `pip install` / `curl \| bash` | 🔴 LGE non-dev users can't use pip |
| Audience | LGE non-developers | Developers + researchers | 🔴 opposite |
| Marketplace | FastAPI + Web UI (Path β, chosen) | Git-based `/plugin marketplace add repo` | 🔴 previously rejected path α |
| Corp security | LGE CA + admin policy + 0o600 fd-based | None | 🟡 must be layered on top |
| Maturity | 4 months hardening | 14 days old | 🔴 maturity inversion |
| Existing 3 plugins | meeting/pageindex/email (LGE-specific) | General agent tools | 🔴 zero overlap |

**Decision**: **selective TS port** of 5 Tier-S + 4 Tier-A patterns under MIT attribution. Zero upstream runtime dependency. Phase 3 folder refactor executed as precondition to give new modules a dedicated home.

---

## 2. Tier S — Borrowed Immediately

| ID | Pattern | Target file | PR | Why |
|---|---|---|---|---|
| **S1+S2** | `SENSITIVE_PATH_PATTERNS` (credential path blocklist) + `_policy_match_paths` trailing-slash helper | `src/permissions/sensitive-paths.ts` | #4 | LVIS had zero credential path protection. Prompt injection could read `~/.ssh/id_rsa`. Hard-block at `ApprovalGate` cannot be user-overridden. |
| **S3** | `BaseTool` abstract + `BaseToolRegistry` with Zod→JSON Schema auto-gen | `src/tools/base.ts` | #5 | Single-file-per-tool discipline, auto schema generation, `isReadOnly` declaration per-tool. Uses `zod@^3.23` + `zod-to-json-schema`. |
| **S4** | `isReadOnly` short-circuit in approval-gate | `src/permissions/approval-gate.ts` (modified) | #4 | Read-only tool invocations skip confirmation dialog in default mode. Plan mode still blocks. |
| **S5** | `UNTRUSTED_CONTENT_BANNER` prefix + `wrapUntrusted` helper | `src/tools/untrusted-banner.ts` | #5 | Prompt injection mitigation — tells LLM "this is data, not instructions" for external content. |

**LGE additions to SENSITIVE_PATH_PATTERNS**: `~/.lvis/certs/**`, `~/.lvis/secrets/**`, `~/.lvis/keys/**`, `~/.lvis/lvis-secrets.json`.

---

## 3. Tier A — Borrowed After Design Review

| ID | Pattern | Target file | PR | Notes |
|---|---|---|---|---|
| **A1** | SafeBashExecutor (preflight interactive detection + output drain + terminate→kill ladder + output cap) | `src/tools/bash.ts` | #7 | Extends `BaseTool<BashToolInputSchema>`. Preflight rejects `create-next-app`/`npm create` without `-y`. |
| **A2** | NetworkGuard SSRF defense (private IP blocklist + per-hop redirect validation + trust_env=false) | `src/core/network-guard.ts` | #3 | IPv4 ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, 0/8) + IPv6 (::1, fe80::/10, fc00::/7, IPv4-mapped ::ffff:...). |
| **A3** | SandboxPathValidator (symlink-safe boundary check) | `src/sandbox/path-validator.ts` | #3 | Uses Node `fs.realpathSync` + `path.resolve` + trailing-slash prefix match. Leaf module. |
| **A4** | Multi-type hook system — Command + HTTP external hooks | `src/hooks/{schemas,types,external-executor,config-loader}.ts` + `hook-runner.ts` modified | #6 | Skip LLM Prompt/Agent hooks (Phase 4 cost-sensitive). Config from `~/.lvis/hooks.json` + admin-dir merge. Backwards compat for existing function hooks. |

---

## 4. Tier B — Study Only, Deferred

- `hooks/hot_reload.py` — nice-to-have for plugin dev UX
- `sandbox/docker_backend.py` — overkill for Electron desktop, relevant for Phase 4 Agent Hub
- `mcp/client.py` — LVIS has own `src/mcp/` (partial), deep port is a separate strategic decision
- `enter_worktree_tool.py` — advanced dev workflow, not LVIS end-user facing

## 5. Tier C — Do NOT Borrow

- Claude Code plugin spec (LVIS plugins are a different concept per user decision)
- `voice/` tools (explicitly rejected)
- `channels/` (Feishu/Slack/Telegram/Discord gateway)
- Ink TUI frontend
- Ohmo personal agent
- Slash command system (LVIS uses IPC)
- Swarm/team coordination (LVIS has own Phase 4 design)

---

## 6. MIT License Compliance

Every ported file carries a header:

```typescript
/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/<path>.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 */
```

Files with attribution:
- `src/permissions/sensitive-paths.ts` — from `permissions/checker.py`
- `src/tools/base.ts` — from `tools/base.py`
- `src/tools/untrusted-banner.ts` — from `tools/web_fetch_tool.py` banner
- `src/sandbox/path-validator.ts` — from `sandbox/path_validator.py`
- `src/core/network-guard.ts` — from `utils/network_guard.py`
- `src/tools/bash.ts` — from `tools/bash_tool.py`
- `src/hooks/external-executor.ts` — from `hooks/executor.py`
- `src/hooks/types.ts` — from `hooks/types.py`
- `src/hooks/schemas.ts` — from `hooks/schemas.py`
- `src/hooks/config-loader.ts` — from `hooks/loader.py`

Dependencies added:
- `zod ^3.23.0` (pinned to v3 — `zod-to-json-schema` is built against v3 API)
- `zod-to-json-schema` (latest)

No runtime link to OpenHarness.

---

## 7. Validation Result (2026-04-15)

3 parallel validation agents reviewed the merged state (all 5 PRs):

| Agent | Verdict | Critical findings |
|---|---|---|
| architect | APPROVED_WITH_NOTES | ToolRegistry naming collision (renamed to BaseToolRegistry in follow-up), ApprovalRequest mirror drift in renderer.tsx |
| security-reviewer | CHANGES_REQUESTED | **C1 CRITICAL: S1 hard-block unreachable** (executor didn't populate `target.filePath`), H1 HTTP hook SSRF, H2 bash env leak, H3 path canonicalization |
| code-reviewer | APPROVED_WITH_NOTES | MIT attribution 10/10, test counts 108/108 verified, 5 MEDIUM nits |

C1 + H1 + H2 + H3 fixed in follow-up `fix/phase3-security-findings` branch grouped with architect's `BaseToolRegistry` rename + `ApprovalRequest` renderer mirror.

---

## 8. Tests

Baseline 183 → post-merge **291** (+108 new):

| Tier | Tests |
|---|---|
| S1 sensitive-paths | 24 |
| S3 BaseTool | 7 |
| S4 approval-gate additions | 3 |
| S5 untrusted-banner | 5 |
| A1 bash | 11 |
| A2 network-guard | 32 |
| A3 path-validator | 12 |
| A4 external-executor | 9 |
| A4 config-loader | 5 |
| **Total new** | **108** |

QA cycle commit: `dfbe47b` on `qa/phase3-borrow-all` (5 PRs merged, TSC 0, vitest 291/291, build success).

---

## 9. What This Doc is NOT

- NOT an authorization to fork OpenHarness as host replacement (rejected)
- NOT an adoption of Claude Code plugin spec (user rejected — LVIS plugins are different concept)
- NOT an adoption of MCP protocol as primary (separate decision for Phase 4)
- NOT a commitment to full folder refactor sprint beyond Phase 3 (done — see refactor plan)
