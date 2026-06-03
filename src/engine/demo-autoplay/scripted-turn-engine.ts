/**
 * Live Auto-play — scripted turn engine.
 *
 * Drives the four-phase sequence:
 *   (1) user-message type-on
 *   (2) tool-call cards (sequential, each with sandboxed fake result)
 *   (3) assistant-response type-on
 *   (4) take-over footer (rendered by sink)
 *
 * Aborts are idempotent. Once `abort()` fires, the engine flushes
 * `sink.onAborted()` once and refuses to emit further events.
 *
 * Trust boundary: engine NEVER calls `ConversationLoop` or any real
 * tool. The only external surface is `FakeSandbox.resolve()` which
 * itself is a pure lookup. See proposal §3 + §5.
 */
import { t } from "../../i18n/index.js";
import { FakeSandbox } from "./fake-sandbox.js";
import type {
  ScriptedAbortReason,
  ScriptedSink,
  ScriptedToolCall,
  ScriptedTurn,
} from "./types.js";

const DEFAULT_TYPE_ON_MS_PER_CHAR = 25;
const DEFAULT_TOOL_CALL_DELAY_MS = 600;
const ASSISTANT_PRE_DELAY_MS = 400;
const TOOL_RUNNING_TO_DONE_DELAY_MS = 350;

export interface ScriptedTurnEngineOptions {
  /** Override sleep — set to a synchronous resolver in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override fake sandbox — set to a stub in tests. */
  sandbox?: FakeSandbox;
}

export class ScriptedTurnEngine {
  private running = false;
  private aborted = false;
  private abortReason: ScriptedAbortReason | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sandbox: FakeSandbox;

  constructor(opts: ScriptedTurnEngineOptions = {}) {
    this.sleep =
      opts.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.sandbox = opts.sandbox ?? new FakeSandbox();
  }

  isRunning(): boolean {
    return this.running && !this.aborted;
  }

  abort(reason: ScriptedAbortReason): void {
    // Idempotent: second call is a no-op. The first reason wins so callers
    // see the user-initiated cause (takeover/input) rather than an
    // engine-completed late report.
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
  }

  async start(turn: ScriptedTurn, sink: ScriptedSink): Promise<void> {
    if (this.running) {
      // Re-entry is a contract violation — surface explicitly so a buggy
      // mount cycle is caught rather than silently double-playing.
      throw new Error("scripted-turn-engine already running");
    }
    this.running = true;
    this.aborted = false;
    this.abortReason = null;
    const msPerChar = turn.typeOnMsPerChar ?? DEFAULT_TYPE_ON_MS_PER_CHAR;

    try {
      await this.typeOn(turn.userMessage, msPerChar, (text, isFinal) =>
        sink.emitUserMessage(text, isFinal),
      );
      if (this.aborted) return;

      for (const call of turn.toolCalls) {
        if (this.aborted) return;
        await this.sleep(call.delayMs ?? DEFAULT_TOOL_CALL_DELAY_MS);
        if (this.aborted) return;

        sink.emitToolCall(call, "running");
        await this.sleep(TOOL_RUNNING_TO_DONE_DELAY_MS);
        if (this.aborted) return;

        const resolved = await this.sandbox.resolve(call);
        if (this.aborted) return;
        sink.emitToolCall(call, "done");
        if (resolved.ok) {
          sink.emitToolResult(call, resolved.result);
        } else {
          // Script drift — surface a placeholder so the demo doesn't
          // hang on a missing fake result. Audit prefix still applies.
          sink.emitToolResult(call, t("be_scriptedTurnEngine.demoScriptMissing", { error: resolved.error }));
        }
      }

      await this.sleep(ASSISTANT_PRE_DELAY_MS);
      if (this.aborted) return;

      await this.typeOn(turn.assistantResponse, msPerChar, (text, isFinal) =>
        sink.emitAssistantDelta(text, isFinal),
      );
      if (this.aborted) return;

      this.abortReason = "completed";
      this.aborted = true; // freeze further emission after completion
    } finally {
      this.running = false;
      const reason: ScriptedAbortReason = this.abortReason ?? "external";
      sink.onAborted(reason);
    }
  }

  /**
   * Stream a string char-by-char so the renderer animates a single
   * message growing — matches the mockup's `cursor-blink` cadence.
   * Abort-aware: each iteration checks `this.aborted` so a take-over
   * stops the type-on within one tick.
   */
  private async typeOn(
    text: string,
    msPerChar: number,
    emit: (partial: string, isFinal: boolean) => void,
  ): Promise<void> {
    let buffer = "";
    for (const char of text) {
      if (this.aborted) return;
      buffer += char;
      emit(buffer, false);
      await this.sleep(msPerChar);
    }
    if (this.aborted) return;
    emit(buffer, true);
  }
}

export type { ScriptedToolCall, ScriptedSink, ScriptedTurn, ScriptedAbortReason };
