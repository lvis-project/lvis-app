/**
 * RoutineEngineV2 — v2-only routine execution engine.
 *
 * Each routine fire creates a dedicated ConversationLoop instance so routine
 * sessions are isolated from the interactive main loop while using the same
 * session repository and metadata model.
 */
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { createLogger } from "../../lib/logger.js";
import type { RoutineScope } from "../../shared/routines-types.js";
const log = createLogger("routine-engine-v2");

export interface RoutineV2RunInput {
  id: string;
  trigger: "shutdown" | "schedule";
  prePrompt: string;
  title?: string;
  /**
   * Permission policy Layer 4 — fully resolved scope (no `inherit` left). Boot-time
   * normalization in the dispatcher snapshots the active plugin set
   * before this method runs.
   */
  scope?: RoutineScope;
  firedAt?: string;
  /**
   * Optional abort signal. When signalled (e.g. shutdown timeout), the
   * underlying ConversationLoop.runTurn is aborted rather than only dropping
   * the Promise.race winner while the turn continues running.
   */
  signal?: AbortSignal;
}

export interface RoutineV2Result {
  routineId: string;
  trigger: "shutdown" | "schedule";
  summary: string;
  generatedAt: string;
  sessionId?: string;
}

export interface RoutineEngineV2Deps {
  /** Called once per routine fire to produce a fresh, isolated ConversationLoop. */
  createConversationLoop: (input: RoutineV2RunInput) => ConversationLoop;
  /**
   * Permission policy Layer 4 — invoked at routine fire time to snapshot the
   * currently-active plugin set. Used to translate
   * `scope.pluginIds.mode === "inherit"` into a concrete `allow` list
   * BEFORE the conversation loop is constructed, so the loop never
   * sees `inherit`. When omitted, `inherit` falls back to deny-all
   * (defensive — pre-Permission policy boot wires this dep for production).
   */
  getActivePluginIds?: () => string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the content of the first <summary>…</summary> tag from a routine
 * LLM response. The system prompt (ROUTINE_SUMMARY_TAG_INSTRUCTION) mandates
 * this tag at the end of every routine turn.
 *
 * Tag absence means the LLM violated the system prompt format — returns the
 * explicit "[요약 형식 누락]" marker so users and developers immediately notice
 * the missing annotation rather than silently getting a truncated body.
 *
 * Caps extracted content at 200 codepoints (OverlayCard surface budget).
 */
function extractSummaryTag(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (!match) {
    return "[요약 형식 누락]";
  }
  const content = match[1].trim();
  const codepoints = [...content];
  return codepoints.length <= 200 ? content : codepoints.slice(0, 200).join("");
}

export class RoutineEngineV2 {
  constructor(private readonly deps: RoutineEngineV2Deps) {}

  /**
   * Permission policy Layer 4 — snapshot `inherit` to a concrete allow-list at fire
   * time. The loop must never see `inherit`; downstream
   * `createRoutineConversationLoop` defensively coerces `inherit` to
   * deny-all, but the principled spot is here where we still have
   * access to the host's active plugin set.
   */
  private normalizeScope(scope: RoutineScope | undefined): RoutineScope {
    if (!scope) {
      return {
        pluginIds: { mode: "deny-all" },
        forcedPluginIds: [],
        directories: [],
      };
    }
    if (scope.pluginIds.mode !== "inherit") return scope;
    const active = this.deps.getActivePluginIds?.() ?? [];
    return {
      pluginIds:
        active.length > 0
          ? { mode: "allow", ids: [...active] }
          : { mode: "deny-all" },
      forcedPluginIds: scope.forcedPluginIds,
      directories: scope.directories,
    };
  }

  async runRoutine(input: RoutineV2RunInput): Promise<RoutineV2Result> {
    const generatedAt = new Date().toISOString();
    // Permission policy Layer 4 — normalize scope BEFORE building the loop so the
    // loop never observes `inherit`. `inherit` snapshots the active
    // plugin set at fire time; missing scope falls back to deny-all
    // (the safe default for headless routine sessions).
    const normalizedInput: RoutineV2RunInput = {
      ...input,
      scope: this.normalizeScope(input.scope),
    };
    // Each fire gets its own loop — no history sharing with main chat.
    const loop = this.deps.createConversationLoop(normalizedInput);
    const sessionId = await loop.startRoutineConversation(
      input.id,
      input.title ?? input.id,
      input.firedAt ?? generatedAt,
    );

    let summary = "";
    try {
      const result = await loop.runTurn(input.prePrompt, undefined, input.signal, {
        inputOrigin: "plugin-emitted",
      });
      summary = extractSummaryTag(result.text ?? "");
    } catch (err) {
      log.warn("runRoutine error (id=%s): %s", input.id, err instanceof Error ? err.message : String(err));
      summary = `루틴 실행 중 오류: ${err instanceof Error ? err.message : String(err)}`;
    }

    return {
      routineId: input.id,
      trigger: input.trigger,
      summary,
      generatedAt,
      sessionId,
    };
  }
}
