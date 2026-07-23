# Conversation History & Context Compaction — Reference Patterns

> ⚠️ **SUPERSEDED** 2026-05-13 by **PR-2-F-2 / PR-3** (`continuous-chat-rotation-closure-report.md`).
> The runtime model described here (`microcompactMessages`, `runRotationCheck`, `decideRotation`, `rotateActive`) is **retired**. The canonical conversation-history model + compaction pipeline now lives in `docs/architecture/architecture.md` §4.5 + the Gemini Reverse Token Budget 3-layer rewrite tracked by issue #715.
> This file is preserved as a **frozen design scratchpad** capturing the peer-project survey that motivated the original adoption. New contributors: do not implement against the patterns below — they no longer match the runtime.

**Purpose**: Capture how peer/reference projects manage LLM conversation history and context-window compaction, for future LVIS design decisions. Prepared 2026-04-17 during the microcompact adoption work.

## TL;DR

All references confirm the same canonical pattern LVIS already follows:

1. **LLM APIs are stateless** — client re-transmits the full message array on every call.
2. **Compaction is client-side** — when usage approaches the context window, the client replaces old messages with a summary.
3. **2-stage compact is the converging best practice**: cheap per-turn stub replacement + threshold-gated LLM summary.

LVIS currently implements only Stage 2. This reference set motivated the Stage 1 (microcompact) + boundary-marker PR.

---

## 1. Stateless LLM API baseline

The baseline is provider-neutral: chat/completions style APIs do not retain
the local session history for the client. LVIS must therefore keep its own
message array, re-send the relevant context on each call, and compact that
client-owned state before it exceeds the active model's usable window.

Takeaway: the compaction contract is an LVIS responsibility, not something
delegated to any closed-source agent implementation.

## 2. OpenHarness (`HKUDS/OpenHarness`) — Python engine

**Files**: `src/openharness/engine/query.py`, `src/openharness/services/compact/*`

- **2-stage compaction**:
  - **Stage 1 — microcompact** (per turn, always): strips bodies of old `tool_result` messages, replaces with small stub. O(n), no LLM cost, idempotent.
  - **Stage 2 — full compact** (threshold-gated): `auto_compact_if_needed()` triggers when `auto_compact_threshold_tokens` exceeded. LLM summarizes removed range.
- **Reactive trigger**: catches `prompt_too_long` / context-exceeded errors mid-turn and retries after compaction (`trigger = "auto" | "reactive"`).
- **Carryover metadata**: `context.tool_metadata` preserves goals/artifacts across compaction boundaries (capped lists).
- Takeaway: richest reference. LVIS adopted Stage 1 + boundary marker + reactive recovery + carryover metadata in PR #30/#31; provider-level error shaping deferred to a follow-up PR.

## 3. paperclip (`paperclipai/paperclip`) — TypeScript agent

**File**: `doc/memory-landscape.md` (branch `master`, not `main`)

- **External memory provider abstraction** — memory is a pluggable layer outside the prompt path, not per-call compaction.
- Different problem framing: persistent cross-session memory vs. in-turn context window management.
- Takeaway: orthogonal to our compact work; relevant later for LVIS long-term memory (§5 architecture).

## Cross-reference — where LVIS implements each concept

| Concept | LVIS location |
|---|---|
| In-memory message array | `src/engine/conversation-history.ts:13` — `private messages: GenericMessage[]` |
| Full re-transmit per turn | `ConversationHistory.getMessages()` consumed by `engine/turn/run-turn.ts` and `engine/turn/query-loop.ts` |
| Threshold check | `src/engine/auto-compact.ts` — `shouldCompact()` (80% default) |
| Full compact (Stage 2) | `src/engine/auto-compact.ts` — `compactMessages()` |
| Microcompact (Stage 1) | `src/engine/auto-compact.ts` — `microcompactMessages()` (added in this PR) |
| Boundary marker | `MessageMeta.compactBoundary` on generated summary (added in this PR) |
| Post-turn orchestration | `src/hooks/post-turn-hook-chain.ts` Step 1a/1b |
| Per-vendor context window | `src/engine/auto-compact.ts` — `MODEL_CONTEXT_WINDOWS` registry |

## Shipped

- **Reactive recovery**: `engine/turn/query-loop.ts` detects thrown and streamed context-limit failures and calls the preflight recovery owned by `engine/turn/compaction.ts`, with a bounded retry policy. Implemented in PR #30 and later extracted without changing the contract.
- **Carryover metadata**: `extractCarryover()` in `auto-compact.ts` captures goals/artifacts/decisions into `MessageMeta.carryover` on each compact boundary. `ConversationCarryover` exported from `src/engine/llm/types.ts`. Implemented in PR #31.

## Deferred (future PRs)

- **Provider-level error shaping**: vendors currently emit context-length errors as both throws and stream `{type:"error"}` events inconsistently. Normalizing this at the provider layer (`llm/*-provider.ts`) would simplify the recovery path.
- **External memory provider** (paperclip-style): separate §5 memory work, not compact-related.

## Provenance

Captured during the Phase 3 follow-up session (2026-04-17) before context compaction. Derived from an internal session record.
