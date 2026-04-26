/**
 * Trigger Executor — orchestrates a single proactive `triggerConversation`
 * call on a *fresh* ConversationLoop instance so the user's interactive chat
 * never sees the templated proactive turn in its history (context isolation).
 *
 * Lifetime per trigger:
 *
 *   1. createLoop() → fresh ConversationLoop with its own ConversationHistory
 *      and sessionId. Stateless deps (settings, registry, memory, approval
 *      gate, permission manager) are shared with the user's chat loop.
 *   2. emit `lvis:trigger:started` so renderer can show a "thinking" indicator.
 *   3. loop.runTurn(spec.prompt, ..., {originSource}) — the templated prompt
 *      flows through the same classify→route→stream pipeline as a chat turn.
 *      Soft-validation gate (Proactive Origin Guidance section in
 *      SystemPromptBuilder) fires because originSource is set.
 *   4. on success, emit `lvis:trigger:completed` with {sessionId, source,
 *      summary}. Renderer shows TriggerCard.
 *   5. user picks: dismiss → end. accept → host imports the trigger session
 *      into the active chat history (one explicit step) and the next chat
 *      turn naturally extends the conversation.
 *
 * Concurrency: each call gets its own loop, so concurrent triggers and a
 * concurrent user chat turn never race on shared `ConversationHistory` or
 * `currentAbortController`. The host gate (rate limiter / dedupe) caps how
 * many fresh loops can be created in parallel. Note that the
 * `SystemPromptBuilder` is still a process-wide singleton; ConversationLoop
 * runs `setOriginSource` synchronously around `build()` (no await between)
 * so the per-build window stays atomic even under concurrent triggers.
 */
import type { BrowserWindow } from "electron";
import type { ConversationLoop, TurnResult } from "./conversation-loop.js";
import type { GenericMessage } from "./llm/types.js";
import { AuditLogger } from "../audit/audit-logger.js";

/** What the renderer needs to display the result. */
export interface TriggerResultPayload {
  /** Trigger-only sessionId — unique per fire, used as renderer card key. */
  sessionId: string;
  /** Plugin id that fired this trigger — used for per-plugin audit grep + cache scope. */
  pluginId: string;
  /** Origin tag (e.g. `proactive:meeting-detection`). Echoed for renderer attribution. */
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  /** Templated prompt that started the trigger turn (the original "user" message). */
  prompt: string;
  /** Final assistant text — what the LLM concluded after running tools. */
  summary: string;
  /** Captured messages so the renderer / import path can replay the turn. */
  messages: GenericMessage[];
  /** ISO timestamp of completion. */
  completedAt: string;
}

export interface TriggerStartedPayload {
  sessionId: string;
  pluginId: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  startedAt: string;
}

/** Tight reason vocabulary for renderer + audit — never echoes raw error.message. */
export type TriggerFailureReason = "provider_error" | "tool_error" | "abort" | "unknown";

export interface TriggerFailedPayload {
  sessionId: string;
  pluginId: string;
  source: string;
  reason: TriggerFailureReason;
  /** Opaque identifier for joining renderer message with the audit log. */
  errorId: string;
}

export interface TriggerSpec {
  prompt: string;
  /** Plugin that fired this trigger — required for audit + cache scoping. */
  pluginId: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  context?: Record<string, unknown>;
}

export interface TriggerExecutorDeps {
  /** Factory called per trigger — produces a fresh, isolated ConversationLoop. */
  createLoop: () => ConversationLoop;
  /**
   * Live BrowserWindow getter — must read the current binding each call
   * because Electron may close+reopen the window during the app's lifetime.
   * Capturing a one-shot reference at construction would silently break
   * trigger UX after window recreation.
   */
  getMainWindow: () => BrowserWindow | null;
  /** Shared audit logger — trigger lifecycle rows land here. */
  auditLogger: AuditLogger;
}

export type TriggerImportOutcome =
  | { ok: true; imported: number }
  | { ok: false; reason: "not_found" | "empty" | "chat_busy" | "history_capacity" };

const TRIGGER_SESSION_CACHE_LIMIT = 32;

/**
 * Classify a runTurn rejection into a coarse-grained reason vocabulary.
 * The raw `error.message` MAY include third-party content (mail subjects,
 * recipient addresses) and MUST NOT be echoed to renderer or audit log
 * verbatim.
 */
function classifyFailure(err: unknown): TriggerFailureReason {
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes("abort") || m.includes("cancel")) return "abort";
    if (m.includes("provider") || m.includes("rate") || m.includes("api")) return "provider_error";
    if (m.includes("tool")) return "tool_error";
  }
  return "unknown";
}

function deepCloneMessage(msg: GenericMessage): GenericMessage {
  // structuredClone handles all non-function fields; messages don't carry
  // functions. Avoids the cache holding references that future post-stream
  // hooks could mutate.
  return structuredClone(msg);
}

/**
 * Wrap a captured trigger session for import into the user's chat history.
 *
 * The leading templated `user` message is plugin-authored content the user
 * never typed. Surface it inside an `<imported-from-proactive source="...">`
 * envelope so:
 *   1. The user's next chat turn doesn't read raw plugin-supplied imperatives
 *      as their own prior input.
 *   2. The system prompt's `<proactive-origin-guidance>` block can refer to
 *      the envelope and tell the LLM to ignore imperatives inside it.
 *   3. Renderers / audit consumers can identify imported turns at a glance.
 */
/**
 * The host gate enforces `^proactive:[a-z][a-z0-9-]*$` upstream of the
 * executor, so `source` is always quote-safe inside `source="..."`. If a
 * future refactor relaxes the gate or a new caller bypasses it, the wrapper
 * could otherwise emit malformed XML and re-open the prompt-injection vector.
 */
const SAFE_SOURCE_PATTERN = /^proactive:[a-z][a-z0-9-]*$/;

function wrapImportedMessages(
  messages: GenericMessage[],
  source: string,
): GenericMessage[] {
  if (messages.length === 0) return messages;
  if (!SAFE_SOURCE_PATTERN.test(source)) {
    // Defensive: drop the wrap entirely rather than emit malformed
    // attribution. The leading user message still reads as user input —
    // worse for context, but never an injection vehicle.
    return messages.map(deepCloneMessage);
  }
  const [first, ...rest] = messages;
  if (first.role !== "user") return messages.map(deepCloneMessage);
  const wrapped: GenericMessage = {
    ...deepCloneMessage(first),
    content:
      `<imported-from-proactive source="${source}">\n${first.content}\n</imported-from-proactive>`,
  };
  return [wrapped, ...rest.map(deepCloneMessage)];
}

export class TriggerExecutor {
  /** Per-instance cache. Keeping it on the instance avoids cross-test leakage. */
  private readonly sessionCache = new Map<string, TriggerResultPayload>();

  constructor(private readonly deps: TriggerExecutorDeps) {}

  /** Test / debug helper. Production code should not need this. */
  getCachedSession(sessionId: string): TriggerResultPayload | null {
    return this.sessionCache.get(sessionId) ?? null;
  }

  /**
   * Run a single trigger. Returns the loop's `TurnResult`. Errors are
   * audited and surfaced via `lvis:trigger:failed`; the throw is rethrown
   * so the host gate's caller can also note the runtime error.
   */
  async run(spec: TriggerSpec): Promise<TurnResult> {
    const loop = this.deps.createLoop();
    const sessionId = loop.getSessionId();
    const startedAt = new Date().toISOString();

    this.emitStarted({
      sessionId,
      pluginId: spec.pluginId,
      source: spec.source,
      visibility: spec.visibility,
      priority: spec.priority,
      startedAt,
    });
    this.audit(
      "tool_call",
      `[trigger:${spec.pluginId}] started session=${sessionId} ` +
        `source=${spec.source} visibility=${spec.visibility} priority=${spec.priority}`,
    );

    try {
      const result = await loop.runTurn(spec.prompt, undefined, undefined, {
        originSource: spec.source,
      });

      const messagesSnapshot = loop.getHistory().getMessages().map(deepCloneMessage);
      const payload: TriggerResultPayload = {
        sessionId,
        pluginId: spec.pluginId,
        source: spec.source,
        visibility: spec.visibility,
        priority: spec.priority,
        prompt: spec.prompt,
        summary: result.text,
        messages: messagesSnapshot,
        completedAt: new Date().toISOString(),
      };
      this.cache(payload);
      this.emitCompleted(payload);
      this.audit(
        "tool_call",
        `[trigger:${spec.pluginId}] completed session=${sessionId} source=${spec.source} ` +
          `summaryLen=${result.text.length} toolCalls=${result.toolCalls.length}`,
      );
      return result;
    } catch (err) {
      const reason = classifyFailure(err);
      const errorId = `te-${sessionId.slice(0, 8)}`;
      this.emitFailed({ sessionId, pluginId: spec.pluginId, source: spec.source, reason, errorId });
      // Full message goes only to the audit log (operator-only), not to
      // renderer or the caller's caller.
      const rawMessage = err instanceof Error ? err.message : String(err);
      this.audit(
        "error",
        `[trigger:${spec.pluginId}] failed session=${sessionId} source=${spec.source} ` +
          `reason=${reason} errorId=${errorId} rawMessage=${rawMessage.slice(0, 200)}`,
      );
      throw err;
    }
  }

  /**
   * Import a captured trigger session into the user's chat loop. Called
   * from the renderer when the user clicks "지금 답하기" on a TriggerCard.
   *
   * Refuses when:
   *   - sessionId not in cache (`not_found`)
   *   - cached payload has no messages (`empty`)
   *   - target chat loop is currently mid-turn (`chat_busy`) — appending
   *     into a streaming history would corrupt the in-flight LLM request
   *   - chat history would overflow `maxMessages` (`history_capacity`) —
   *     better to refuse than to silently evict the user's older chat
   *     messages
   */
  importIntoChat(
    sessionId: string,
    chatLoop: ConversationLoop,
  ): TriggerImportOutcome {
    const payload = this.sessionCache.get(sessionId);
    if (!payload) {
      this.audit("error", `[trigger] import_failed session=${sessionId} reason=not_found`);
      return { ok: false, reason: "not_found" };
    }
    if (payload.messages.length === 0) {
      this.audit(
        "error",
        `[trigger:${payload.pluginId}] import_failed session=${sessionId} reason=empty`,
      );
      return { ok: false, reason: "empty" };
    }
    // Concurrency guard — host's chat loop is single-flight. If a turn is
    // streaming, splicing into history would interleave foreign messages
    // into the in-flight request body.
    if (chatLoop.currentAbortController !== null) {
      this.audit(
        "error",
        `[trigger:${payload.pluginId}] import_failed session=${sessionId} reason=chat_busy`,
      );
      return { ok: false, reason: "chat_busy" };
    }
    const history = chatLoop.getHistory();
    const wrapped = wrapImportedMessages(payload.messages, payload.source);
    if (wrapped.length > history.getCapacityRemaining()) {
      this.audit(
        "error",
        `[trigger:${payload.pluginId}] import_failed session=${sessionId} reason=history_capacity`,
      );
      return { ok: false, reason: "history_capacity" };
    }

    for (const msg of wrapped) history.append(msg);
    this.sessionCache.delete(sessionId);
    this.audit(
      "tool_call",
      `[trigger:${payload.pluginId}] imported session=${sessionId} source=${payload.source} ` +
        `messages=${wrapped.length} → chat=${chatLoop.getSessionId()}`,
    );
    return { ok: true, imported: wrapped.length };
  }

  /** Drop a cached trigger session — called when the renderer dismisses the card. */
  dismiss(sessionId: string): boolean {
    const entry = this.sessionCache.get(sessionId);
    const existed = this.sessionCache.delete(sessionId);
    if (existed) {
      this.audit(
        "tool_call",
        `[trigger:${entry?.pluginId ?? "?"}] dismissed session=${sessionId}`,
      );
    }
    return existed;
  }

  private cache(payload: TriggerResultPayload): void {
    if (this.sessionCache.size >= TRIGGER_SESSION_CACHE_LIMIT) {
      const oldestKey = this.sessionCache.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = this.sessionCache.get(oldestKey);
        this.sessionCache.delete(oldestKey);
        // Tell the renderer to drop any UI for the evicted session — a
        // user clicking accept on a stale card would otherwise get
        // `not_found` with no on-screen explanation.
        if (evicted) this.emitExpired(evicted);
      }
    }
    this.sessionCache.set(payload.sessionId, payload);
  }

  private emitStarted(payload: TriggerStartedPayload): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("lvis:trigger:started", payload);
  }

  private emitCompleted(payload: TriggerResultPayload): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    // Strip `messages` from the wire payload — full history stays in the
    // per-instance cache for the import path; renderer only needs the
    // summary fields to render the card.
    const wirePayload = {
      sessionId: payload.sessionId,
      pluginId: payload.pluginId,
      source: payload.source,
      visibility: payload.visibility,
      priority: payload.priority,
      prompt: payload.prompt,
      summary: payload.summary,
      completedAt: payload.completedAt,
    };
    win.webContents.send("lvis:trigger:completed", wirePayload);
  }

  private emitFailed(payload: TriggerFailedPayload): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("lvis:trigger:failed", payload);
  }

  private emitExpired(payload: TriggerResultPayload): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("lvis:trigger:expired", {
      sessionId: payload.sessionId,
      pluginId: payload.pluginId,
      source: payload.source,
    });
  }

  private audit(type: "tool_call" | "error", input: string): void {
    try {
      this.deps.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "trigger-executor",
        type,
        input,
      });
    } catch { /* audit must not break host */ }
  }
}
