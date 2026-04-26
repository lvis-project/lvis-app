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
import { PROACTIVE_SOURCE_PATTERN } from "./proactive-source.js";
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

/**
 * Source pattern shared with the host gate, keyword-engine bypass, and
 * ipc-bridge envelope parsing — see `engine/proactive-source.ts`. The
 * host gate (`plugin-runtime.ts`) enforces this same pattern upstream
 * of the executor, so by the time `source` reaches `importIntoChat`
 * it's always quote-safe inside `source="..."`. The single source of
 * truth ensures a future refactor on any one site can't silently
 * desync the others.
 *
 * The envelope serves two purposes:
 *   1. The user's next chat turn doesn't read raw plugin-supplied
 *      imperatives as their own prior input.
 *   2. The system prompt's `<proactive-origin-guidance>` block can
 *      refer to the envelope and tell the LLM to ignore imperatives
 *      inside it AND ask the user before running any write tool.
 */

export class TriggerExecutor {
  /** Per-instance cache. Keeping it on the instance avoids cross-test leakage. */
  private readonly sessionCache = new Map<string, TriggerResultPayload>();

  constructor(private readonly deps: TriggerExecutorDeps) {}

  /** Test / debug helper. Production code should not need this. */
  getCachedSession(sessionId: string): TriggerResultPayload | null {
    return this.sessionCache.get(sessionId) ?? null;
  }

  /**
   * Surface a single brain trigger to the renderer.
   *
   * **The trigger session does NOT run an LLM.** Earlier iterations ran
   * a fresh ConversationLoop here, which gave the LLM full tool access
   * and let it autonomously execute write actions (e.g.
   * `email_create_event`) before the user could approve. That violates
   * the brain's role — propose, never execute. Now `run()` is a pure
   * notification path: cache the spec, emit the toast/modal payload,
   * return synchronously.
   *
   * Any actual work (read body, propose details, write calendar entry)
   * happens in the user's chat session AFTER they click "지금 답하기".
   * That path goes through the host's normal approval gate, so every
   * write tool gets a confirmation modal.
   */
  async run(spec: TriggerSpec): Promise<TurnResult> {
    const sessionId = `trg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
      // No LLM — the brain prompt itself is what the user sees on the
      // toast/modal AND what later seeds the chat session on accept.
      const summaryText = spec.prompt;
      const messagesSnapshot: GenericMessage[] = [
        { role: "user", content: spec.prompt },
      ];
      const result: TurnResult = {
        text: summaryText,
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [],
        route: "proactive-trigger",
      };
      const payload: TriggerResultPayload = {
        sessionId,
        pluginId: spec.pluginId,
        source: spec.source,
        visibility: spec.visibility,
        priority: spec.priority,
        prompt: spec.prompt,
        summary: summaryText,
        messages: messagesSnapshot,
        completedAt: new Date().toISOString(),
      };
      this.cache(payload);
      this.emitCompleted(payload);
      this.audit(
        "tool_call",
        `[trigger:${spec.pluginId}] completed session=${sessionId} source=${spec.source} ` +
          `visibility=${spec.visibility} summaryLen=${summaryText.length} toolCalls=0`,
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
    // Concurrency guard — host's chat loop is single-flight. The
    // renderer fires a follow-up `chatSend(wrappedPrompt)` immediately
    // after this returns; if a turn is already streaming, that send
    // would interleave foreign messages into the in-flight request.
    if (chatLoop.currentAbortController !== null) {
      this.audit(
        "error",
        `[trigger:${payload.pluginId}] import_failed session=${sessionId} reason=chat_busy`,
      );
      return { ok: false, reason: "chat_busy" };
    }
    // History capacity check — runTurn appends one user message and
    // one assistant message at minimum.
    const history = chatLoop.getHistory();
    if (history.getCapacityRemaining() < 2) {
      this.audit(
        "error",
        `[trigger:${payload.pluginId}] import_failed session=${sessionId} reason=history_capacity`,
      );
      return { ok: false, reason: "history_capacity" };
    }

    // Build the protective envelope. Source is gate-validated upstream
    // (`^proactive:[a-z][a-z0-9-]*$`) so it's quote-safe for the
    // `source="..."` attribute. The renderer fires
    // `chatSend(wrappedPrompt)` next — runTurn appends it as a normal
    // user message, the system prompt's `<proactive-origin-guidance>`
    // block tells the LLM to ignore imperatives inside the envelope
    // and ask the user before any write op.
    const wrappedPrompt = PROACTIVE_SOURCE_PATTERN.test(payload.source)
      ? `<imported-from-proactive source="${payload.source}">\n${payload.prompt}\n</imported-from-proactive>`
      : payload.prompt;

    this.sessionCache.delete(sessionId);
    this.audit(
      "tool_call",
      `[trigger:${payload.pluginId}] imported session=${sessionId} source=${payload.source} ` +
        `→ chat=${chatLoop.getSessionId()}`,
    );

    // Renderer notification — adds the consolidated `imported_trigger`
    // card AND fires the follow-up chatSend with the wrappedPrompt.
    // Note: trigger-executor does NOT call runTurn itself — that path
    // owns its own streaming hooks (renderer IPC channels) which this
    // executor doesn't have direct access to. The renderer-driven
    // chatSend reuses the existing chat streaming wiring.
    this.emitImported({
      sessionId,
      source: payload.source,
      prompt: payload.prompt,
      summary: payload.summary,
      toolCallCount: 0,
      importedAt: new Date().toISOString(),
      wrappedPrompt,
    });
    return { ok: true, imported: 1 };
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

  private emitImported(payload: {
    sessionId: string;
    source: string;
    prompt: string;
    summary: string;
    toolCallCount: number;
    importedAt: string;
    /** The wrapped prompt the renderer should chatSend immediately. */
    wrappedPrompt: string;
  }): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("lvis:trigger:imported", payload);
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
