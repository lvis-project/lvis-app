/**
 * Live Auto-play — fake sandbox.
 *
 * Closed-loop lookup that returns the pre-recorded result for a given
 * `ScriptedToolCall`. Trust boundary invariants:
 *
 *   1. No filesystem access (no `fs`, no `~/.lvis/` reads).
 *   2. No network access (no fetch / http).
 *   3. Not registered in `tool-registry.ts` — `ConversationLoop` cannot
 *      reach FakeSandbox even if a real LLM emits the same `toolName`.
 *   4. Results are *strings only* — no nested JSON that could be parsed
 *      as a tool response by downstream consumers.
 *
 * See `docs/architecture/proposals/live-autoplay.md` §3.2 + §6 (R5).
 */
import type { ScriptedToolCall } from "./types.js";

export interface FakeSandboxResolveOk {
  ok: true;
  /** Display string — always prefixed with `데모: ` at the UI layer. */
  result: string;
}

export interface FakeSandboxResolveErr {
  ok: false;
  /** kebab-case English. Renderer maps to Korean toast if surfaced. */
  error: "unknown-tool" | "empty-result";
}

export type FakeSandboxResult = FakeSandboxResolveOk | FakeSandboxResolveErr;

export class FakeSandbox {
  /**
   * Resolve a scripted tool call to its pre-defined result.
   *
   * Throws if the call object lacks a fake result — defends against
   * a script JSON drift where a `toolCall` entry has been added without
   * its accompanying `fakeResultKo`.
   */
  async resolve(call: ScriptedToolCall): Promise<FakeSandboxResult> {
    if (!call || typeof call.toolName !== "string" || call.toolName.length === 0) {
      return { ok: false, error: "unknown-tool" };
    }
    if (typeof call.fakeResultKo !== "string" || call.fakeResultKo.length === 0) {
      return { ok: false, error: "empty-result" };
    }
    return { ok: true, result: call.fakeResultKo };
  }
}
