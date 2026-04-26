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
 *      messages, summary}. Renderer shows TriggerCard.
 *   5. user picks: dismiss → end. accept → host imports the trigger session
 *      into the active chat history (one explicit step) and the next chat
 *      turn naturally extends the conversation.
 *
 * Concurrency: each call gets its own loop, so concurrent triggers and a
 * concurrent user chat turn never race on shared `ConversationHistory` or
 * `currentAbortController`. The host gate (rate limiter / dedupe) caps how
 * many fresh loops can be created in parallel.
 */
import type { BrowserWindow } from "electron";
import type { ConversationLoop, TurnResult } from "./conversation-loop.js";
import type { GenericMessage } from "./llm/types.js";
import { AuditLogger } from "../audit/audit-logger.js";

/** What the renderer needs to display the result. */
export interface TriggerResultPayload {
  /** The trigger-only sessionId — unique per fire, so the renderer can key off it. */
  sessionId: string;
  /** Origin tag (e.g. `proactive:meeting-detection`). Echoed for renderer attribution. */
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  /** Templated prompt that started the trigger turn (the "user" message). */
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
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  startedAt: string;
}

export interface TriggerSpec {
  prompt: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  context?: Record<string, unknown>;
}

export interface TriggerExecutorDeps {
  /** Factory called per trigger — produces a fresh, isolated ConversationLoop. */
  createLoop: () => ConversationLoop;
  /** Resolves the renderer window for IPC delivery. May be null pre-bootstrap. */
  getMainWindow: () => BrowserWindow | null;
  /** Shared audit logger — trigger lifecycle rows land here. */
  auditLogger: AuditLogger;
}

/**
 * Static cache of trigger sessions keyed by sessionId, used so the renderer's
 * "지금 답하기" (import) action can locate the captured turn for handoff into
 * the active chat. Capped to a small number — older entries are dropped on
 * insert. Trigger sessions that nobody imports just age out silently.
 */
const TRIGGER_SESSION_CACHE = new Map<string, TriggerResultPayload>();
const TRIGGER_SESSION_CACHE_LIMIT = 32;

export function getCachedTriggerSession(sessionId: string): TriggerResultPayload | null {
  return TRIGGER_SESSION_CACHE.get(sessionId) ?? null;
}

export class TriggerExecutor {
  constructor(private readonly deps: TriggerExecutorDeps) {}

  /**
   * Run a single trigger. Returns the loop's `TurnResult` so the host gate
   * can include it in `triggerConversation`'s caller-visible result if it
   * wants — but the user-facing path is the IPC events emitted here.
   */
  async run(spec: TriggerSpec): Promise<TurnResult> {
    const loop = this.deps.createLoop();
    const sessionId = loop.getSessionId();
    const startedAt = new Date().toISOString();

    this.emitStarted({
      sessionId,
      source: spec.source,
      visibility: spec.visibility,
      priority: spec.priority,
      startedAt,
    });
    this.audit(
      "tool_call",
      `[trigger] started session=${sessionId} source=${spec.source} ` +
        `visibility=${spec.visibility} priority=${spec.priority}`,
    );

    try {
      const result = await loop.runTurn(spec.prompt, undefined, undefined, {
        originSource: spec.source,
      });

      const payload: TriggerResultPayload = {
        sessionId,
        source: spec.source,
        visibility: spec.visibility,
        priority: spec.priority,
        prompt: spec.prompt,
        summary: result.text,
        messages: loop.getHistory().getMessages(),
        completedAt: new Date().toISOString(),
      };
      this.cache(payload);
      this.emitCompleted(payload);
      this.audit(
        "tool_call",
        `[trigger] completed session=${sessionId} source=${spec.source} ` +
          `summaryLen=${result.text.length} toolCalls=${result.toolCalls.length}`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitFailed({ sessionId, source: spec.source, error: message });
      this.audit(
        "error",
        `[trigger] failed session=${sessionId} source=${spec.source} message=${message}`,
      );
      throw err;
    }
  }

  /**
   * Import a captured trigger session into the user's chat loop. Called from
   * the renderer when the user clicks "지금 답하기" on a TriggerCard. The
   * caller (ipc-bridge) supplies the active chat loop; we hydrate its history
   * with the trigger's messages so the next user turn naturally extends.
   *
   * Returns the imported message count so audit / UI can reason about it.
   */
  importIntoChat(
    sessionId: string,
    chatLoop: ConversationLoop,
  ): { ok: boolean; imported: number; reason?: "not_found" | "empty" } {
    const payload = TRIGGER_SESSION_CACHE.get(sessionId);
    if (!payload) {
      this.audit("error", `[trigger] import_failed session=${sessionId} reason=not_found`);
      return { ok: false, imported: 0, reason: "not_found" };
    }
    if (payload.messages.length === 0) {
      this.audit("error", `[trigger] import_failed session=${sessionId} reason=empty`);
      return { ok: false, imported: 0, reason: "empty" };
    }
    const history = chatLoop.getHistory();
    for (const msg of payload.messages) history.append(msg);
    TRIGGER_SESSION_CACHE.delete(sessionId);
    this.audit(
      "tool_call",
      `[trigger] imported session=${sessionId} source=${payload.source} ` +
        `messages=${payload.messages.length} → chat=${chatLoop.getSessionId()}`,
    );
    return { ok: true, imported: payload.messages.length };
  }

  /** Drop a cached trigger session — called when the renderer dismisses the card. */
  dismiss(sessionId: string): boolean {
    const existed = TRIGGER_SESSION_CACHE.delete(sessionId);
    if (existed) {
      this.audit("tool_call", `[trigger] dismissed session=${sessionId}`);
    }
    return existed;
  }

  private cache(payload: TriggerResultPayload): void {
    if (TRIGGER_SESSION_CACHE.size >= TRIGGER_SESSION_CACHE_LIMIT) {
      const oldest = TRIGGER_SESSION_CACHE.keys().next().value;
      if (oldest !== undefined) TRIGGER_SESSION_CACHE.delete(oldest);
    }
    TRIGGER_SESSION_CACHE.set(payload.sessionId, payload);
  }

  private emitStarted(payload: TriggerStartedPayload): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("lvis:trigger:started", payload);
  }

  private emitCompleted(payload: TriggerResultPayload): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    // Strip `messages` from the wire payload — full history is heavy and
    // renderer only needs sessionId/summary/source to render the card.
    // The full payload stays in TRIGGER_SESSION_CACHE for the import path.
    const wirePayload = {
      sessionId: payload.sessionId,
      source: payload.source,
      visibility: payload.visibility,
      priority: payload.priority,
      prompt: payload.prompt,
      summary: payload.summary,
      completedAt: payload.completedAt,
    };
    win.webContents.send("lvis:trigger:completed", wirePayload);
  }

  private emitFailed(payload: { sessionId: string; source: string; error: string }): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("lvis:trigger:failed", payload);
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
