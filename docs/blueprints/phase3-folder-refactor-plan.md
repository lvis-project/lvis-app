# Phase 3 Folder Refactor Plan

> **Status**: Executed — 2026-04-15 (`refactor/phase3-folder-reorg` @ `0d78b8a`, PR #2)
> **Scope**: `lvis-app/src/` module reorganization — precondition to OpenHarness Tier S/A borrow
> **Reference**: `docs/architecture/architecture.md §4.6`, `docs/blueprints/openharness-selective-borrow-plan.md`

---

## 1. Motivation

Pre-refactor `src/` had two structural overloads identified during OpenHarness comparison (OpenHarness has 30 focused subdirs vs LVIS's 7):

- `src/agent/` — 11 files across 7 distinct concerns (conversation loop, hooks, prompts, tool executor, LLM providers, DLP, audit, knowledge search, agent-action-requester)
- `src/core/` — engines (keyword/route/memory/tool-registry) mixed with the entire permission stack (permission-manager, permissions-store, policy-store, approval-gate)

New Tier S/A borrowed modules (`sensitive-paths`, `BaseTool`, `path-validator`, `network-guard`, `bash.ts`, etc.) had no dedicated home. Refactor is the precondition that creates those homes.

---

## 2. Target Layout

See `architecture.md §4.6.1` for the canonical map. Summary:

```
src/
├── engine/     (was src/agent/ — agent loop + LLM providers)
├── tools/      (1-file-per-tool discipline — includes new BaseToolRegistry, bash, untrusted-banner)
├── prompts/    (system-prompt-builder)
├── hooks/      (hook-runner + post-turn-hook-chain + new A4 external executor + schemas + config-loader)
├── permissions/ (permission-manager, permissions-store, policy-store, approval-gate, agent-action-requester, sensitive-paths)
├── sandbox/    (NEW — path-validator leaf module)
├── memory/     (memory-manager)
├── audit/      (audit-logger, dlp-filter)
├── core/       (remaining: keyword/route engines + tool-registry legacy + network-guard)
├── mcp/        (unchanged)
├── plugins/    (renamed from plugin-runtime/)
├── data/, main/, lib/, components/ui/, ui/, __tests__/
```

---

## 3. File Migration Map (authoritative)

Every `git mv` preserved git history. Tests moved together with their source.

### 3.1 `src/agent/*` → split

| From | To |
|---|---|
| `src/agent/conversation-loop.ts` | `src/engine/conversation-loop.ts` |
| `src/agent/conversation-history.ts` | `src/engine/conversation-history.ts` |
| `src/agent/auto-compact.ts` | `src/engine/auto-compact.ts` |
| `src/agent/llm/*` | `src/engine/llm/*` |
| `src/agent/tool-executor.ts` | `src/tools/executor.ts` |
| `src/agent/knowledge-search-tool.ts` | `src/tools/knowledge-search.ts` |
| `src/agent/system-prompt-builder.ts` | `src/prompts/system-prompt-builder.ts` |
| `src/agent/hook-runner.ts` | `src/hooks/hook-runner.ts` |
| `src/agent/post-turn-hook-chain.ts` | `src/hooks/post-turn-hook-chain.ts` |
| `src/agent/audit-logger.ts` | `src/audit/audit-logger.ts` |
| `src/agent/dlp-filter.ts` | `src/audit/dlp-filter.ts` |
| `src/agent/agent-action-requester.ts` | `src/permissions/agent-action-requester.ts` |
| `src/agent/__tests__/*` | co-located with new destinations |
| `src/agent/` | DELETED after all files moved |

### 3.2 `src/core/*` — permissions + memory extraction

| From | To |
|---|---|
| `src/core/permission-manager.ts` | `src/permissions/permission-manager.ts` |
| `src/core/permissions-store.ts` | `src/permissions/permissions-store.ts` |
| `src/core/policy-store.ts` | `src/permissions/policy-store.ts` |
| `src/core/approval-gate.ts` | `src/permissions/approval-gate.ts` |
| `src/core/memory-manager.ts` | `src/memory/memory-manager.ts` |
| `src/core/keyword-engine.ts` | **STAYS** |
| `src/core/route-engine.ts` | **STAYS** |
| `src/core/tool-registry.ts` | **STAYS** (legacy, deprecated by Tier S3 `src/tools/base.ts BaseToolRegistry`) |

### 3.3 `src/plugin-runtime/` → `src/plugins/`

Directory rename. All 5 files moved: types.ts, runtime.ts, registry.ts, marketplace.ts, deployment-guard.ts. Tests follow.

---

## 4. Execution Result (2026-04-15)

- 32 files moved via `git mv` (history preserved)
- 14 files had import path edits
- 3 `scripts/*.ts` files needed path fixes (not listed in original plan but tsconfig `include` caught them)
- Empty `src/core/__tests__/` directory removed (all tests migrated to new homes)
- `CLAUDE.md` Project Structure section updated in same commit
- TSC 0 errors (baseline match), vitest 183/183 pass (baseline match), build success

**Branch**: `refactor/phase3-folder-reorg`
**Commit**: `0d78b8a`
**PR**: https://github.com/lvis-project/lvis-app/pull/2 → `main`

---

## 5. What This Refactor Does NOT Do

- No behavior change — zero functional modification
- No API removal — all public exports preserved at new paths
- No tool name changes (underscore convention unchanged)
- No plugin manifest changes (`plugin.json` format unchanged)
- No dependency updates in `package.json`
- No database/file-state format changes
- No breaking changes for existing tests — all 183 pass at new paths

Subsequent borrow PRs (#3-#7) add NEW files into the new directories without modifying existing behavior.

---

## 6. Follow-ups (post-refactor)

1. **Gradual `src/core/tool-registry.ts` → `src/tools/base.ts BaseToolRegistry` migration** — each existing tool registered with the new pattern in follow-up PRs
2. **Integration wiring** for the new Tier S/A modules into existing executors (C1 fix in `fix/phase3-security-findings` branch handles the critical executor wiring for S1 hard-block)
3. **renderer.tsx `ApprovalRequest` mirror type** — extend with S4 fields (target, isReadOnly, mode)
4. **Admin-dir hook config** — wire `loadHooksConfig()` into `boot.ts` post-settings init

---

## 7. Rollback

If unforeseen issues emerge post-merge:
- `git revert` the squash-merge commit on main (preserves history)
- All borrow PRs (#3-#7) can be reverted independently since they only ADD files
- Tier S/A borrowed code can be removed per-module without cascading changes (leaf design)
