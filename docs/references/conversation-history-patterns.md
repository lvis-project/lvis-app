# Conversation History & Context Compaction — Reference Patterns

**Purpose**: Capture how peer/reference projects manage LLM conversation history and context-window compaction, for future LVIS design decisions. Prepared 2026-04-17 during the microcompact adoption work.

## TL;DR

All references confirm the same canonical pattern LVIS already follows:

1. **LLM APIs are stateless** — client re-transmits the full message array on every call.
2. **Compaction is client-side** — when usage approaches the context window, the client replaces old messages with a summary.
3. **2-stage compact is the converging best practice**: cheap per-turn stub replacement + threshold-gated LLM summary.

LVIS currently implements only Stage 2. This reference set motivated the Stage 1 (microcompact) + boundary-marker PR.

---

## 1. claw-code (`emmarktech/claw-code`) — Rust runtime

**File**: `rust/crates/runtime/src/conversation.rs`

- `run_turn()` (line ~155): `messages: self.session.messages.clone()` — **full history re-transmitted** every turn.
- `compact()` (line ~257): **manually invoked** by caller. Config: `CompactionConfig { preserve_recent: usize, summary_budget: usize }`.
- No automatic per-turn stripping; no boundary marker.
- Takeaway: simplest model — re-transmit all, compact only when explicitly asked.

## 2. OpenHarness (`HKUDS/OpenHarness`) — Python engine

**Files**: `src/openharness/engine/query.py`, `src/openharness/services/compact/*`

- **2-stage compaction**:
  - **Stage 1 — microcompact** (per turn, always): strips bodies of old `tool_result` messages, replaces with small stub. O(n), no LLM cost, idempotent.
  - **Stage 2 — full compact** (threshold-gated): `auto_compact_if_needed()` triggers when `auto_compact_threshold_tokens` exceeded. LLM summarizes removed range.
- **Reactive trigger**: catches `prompt_too_long` / context-exceeded errors mid-turn and retries after compaction (`trigger = "auto" | "reactive"`).
- **Carryover metadata**: `context.tool_metadata` preserves goals/artifacts across compaction boundaries (capped lists).
- Takeaway: richest reference. LVIS adopted Stage 1 + boundary marker in this PR; reactive + carryover deferred to follow-up PRs.

## 3. paperclip (`paperclipai/paperclip`) — TypeScript agent

**File**: `doc/memory-landscape.md` (branch `master`, not `main`)

- **External memory provider abstraction** — memory is a pluggable layer outside the prompt path, not per-call compaction.
- Different problem framing: persistent cross-session memory vs. in-turn context window management.
- Takeaway: orthogonal to our compact work; relevant later for LVIS long-term memory (§5 architecture).

## Cross-reference — where LVIS implements each concept

| Concept | LVIS location |
|---|---|
| In-memory message array | `src/engine/conversation-history.ts:13` — `private messages: GenericMessage[]` |
| Full re-transmit per turn | `ConversationHistory.getAll()` called by `conversation-loop.ts` |
| Threshold check | `src/engine/auto-compact.ts` — `shouldCompact()` (80% default) |
| Full compact (Stage 2) | `src/engine/auto-compact.ts` — `compactMessages()` |
| Microcompact (Stage 1) | `src/engine/auto-compact.ts` — `microcompactMessages()` (added in this PR) |
| Boundary marker | `MessageMeta.compactBoundary` on generated summary (added in this PR) |
| Post-turn orchestration | `src/hooks/post-turn-hook-chain.ts` Step 1a/1b |
| Per-vendor context window | `src/engine/auto-compact.ts` — `MODEL_CONTEXT_WINDOWS` registry |

## Deferred (future PRs)

- **Reactive recovery**: catch vendor-specific `prompt_too_long` errors, compact + retry. Needs provider-level hook in `llm/*-provider.ts`.
- **Carryover metadata**: preserve goals/artifacts (capped lists) across boundaries. Needs new `ConversationContext` abstraction.
- **External memory provider** (paperclip-style): separate §5 memory work, not compact-related.

## Provenance

Captured during the Phase 3 follow-up session (2026-04-17) before context compaction. Derived from an internal session record.
