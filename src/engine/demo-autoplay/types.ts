/**
 * Live Auto-play — contract types.
 *
 * Demo-only. Shared between `ScriptedTurnEngine`, `FakeSandbox`,
 * `DemoAutoplayBanner`, and the per-script JSON fixtures under
 * `./scripts/<id>.json`. See
 * `docs/architecture/proposals/live-autoplay.md` §3 for the SOT contract.
 *
 * Invariant: types defined here never escape into `ConversationLoop`
 * or `tool-registry`. All consumers stay inside the renderer-local
 * autoplay surface so the demo trust boundary is enforceable at
 * import-time.
 */

/** Pre-recorded turn — fully self-contained, no LLM/tool runtime touched. */
export interface ScriptedTurn {
  /** Stable id (slug). Loaded from scripts/<id>.json. */
  id: string;
  /** Localized title shown in the REC indicator / audit prefix. */
  titleKo: string;
  /** Simulated user message — emitted with type-on animation. */
  userMessage: string;
  /** Tool call sequence — each call returns a sandboxed fake result. */
  toolCalls: ScriptedToolCall[];
  /** Final assistant response — emitted with type-on animation. */
  assistantResponse: string;
  /**
   * Type-on speed (ms / char). Default 25. Per-character delay keeps the
   * "user is typing" illusion consistent with the mockup cadence.
   */
  typeOnMsPerChar?: number;
}

export interface ScriptedToolCall {
  /**
   * Tool name (e.g. `meeting_list`). The string is *display only* — the
   * engine NEVER routes this through `tool-registry.ts`. Real tools never
   * see autoplay calls.
   */
  toolName: string;
  /** Korean label shown next to the tool name (mockup parity). */
  labelKo: string;
  /**
   * Pre-computed fake result — plain string only, no nested LLM JSON.
   * `fakeResultKo` is prefixed with `데모: ` at render time so the user can
   * never visually mistake it for a real tool result.
   */
  fakeResultKo: string;
  /** Optional delay before this call fires (ms). Default 600. */
  delayMs?: number;
}

/**
 * Reason a scripted turn ended. The engine reports the cause so
 * `auditLogger` and view-cleanup logic can branch.
 */
export type ScriptedAbortReason =
  | "user-takeover"
  | "user-input"
  | "external"
  | "completed";

/**
 * Sink the engine writes into. The ChatView-side implementation
 * accumulates entries with `kind: "demo-autoplay-*"` so they live in
 * a view-only history that never reaches `ConversationLoop`.
 */
export interface ScriptedSink {
  emitUserMessage(text: string, isFinal: boolean): void;
  emitToolCall(call: ScriptedToolCall, status: "running" | "done"): void;
  emitToolResult(call: ScriptedToolCall, resultKo: string): void;
  emitAssistantDelta(text: string, isFinal: boolean): void;
  /** Engine has stopped — sink should clear scripted entries from view. */
  onAborted(reason: ScriptedAbortReason): void;
}
