/**
 * MCP Apps `ui/update-model-context` — the host's per-card model-context slots.
 *
 * The spec's semantics are precise and unusual, and every one of them is a property of
 * THIS module:
 *
 *   · OVERWRITE, not append. "Each request overwrites the previous context stored by the
 *     View" — so a card owns exactly ONE slot, and the last update wins. A card that
 *     ships a 60-fps counter costs the prompt one block, not sixty.
 *   · DEFERRED to the next model turn. The host "will typically defer sending the context
 *     to the model until the next user message". We do that structurally: the slots are
 *     read at PROMPT-BUILD time by a `SystemPromptBuilder` source. There is no push, no
 *     queue, no wake-up.
 *   · NEVER a follow-up. "Unlike messages, context updates do not trigger follow-ups."
 *     Nothing in this module can start a turn — it has no reference to the conversation
 *     loop, by construction. `ui/message` (which CAN reach a turn, and only through a
 *     user-gated card) is the other channel, and it is a different one on purpose.
 *
 * TRUST: the body is UNTRUSTED DATA authored by a third-party app's UI — the same framing
 * the host already applies to `<app-message>` bodies and to skill-catalog metadata. It is
 * fenced and labelled as data, never as instructions, and {@link serializeAppContext} is
 * the ONE place that builds a body, so the closing-fence neutralization lives there and
 * nowhere else.
 */
import { t } from "../i18n/index.js";
import { appMessageSource, isAppMessageOrigin } from "../shared/mcp-app-message-source.js";

/**
 * Hard cap on ONE card's serialized context. Sized like the `ui/message` cap
 * (`MCP_APP_MESSAGE_MAX_CHARS`, 4 096) but roomier, because this block is a structured
 * snapshot rather than a sentence — while still small enough that a card cannot spend the
 * user's context window on the host's behalf. Enforced on the SERIALIZED body, which is
 * what actually reaches the prompt.
 */
export const MCP_APP_MODEL_CONTEXT_MAX_CHARS = 8_192;

/**
 * Hard cap on live slots. Every slot is `MCP_APP_MODEL_CONTEXT_MAX_CHARS` of potential
 * prompt, so this bounds the WORST-CASE per-turn cost at a knowable number, and bounds
 * main's memory against a chat that renders hundreds of cards. Oldest slot is evicted
 * first (insertion order).
 */
export const MCP_APP_MODEL_CONTEXT_MAX_SLOTS = 16;

/** What main tells the renderer. The app itself gets an `EmptyResult` either way. */
export type McpUiModelContextOutcome =
  | { ok: true; disposition: "stored" | "cleared" }
  | { ok: false; error: string; message: string };

export interface McpAppModelContextUpdate {
  /** The chat session the card belongs to — bound by the trusted renderer. */
  sessionId: string;
  /** The card's MCP server — bound by the trusted renderer. */
  serverId: string;
  /** The card instance — bound by the trusted renderer. One card, one slot. */
  cardId: string;
  /** Spec `content` — `ContentBlock[]`. Only text blocks are serialized. */
  content?: unknown;
  /** Spec `structuredContent` — serialized as fenced JSON. */
  structuredContent?: unknown;
}

/** One card's live slot. */
interface ModelContextSlot {
  sessionId: string;
  serverId: string;
  /** The serialized, fence-safe, capped body. */
  body: string;
}

/**
 * Serialize one update into the body that will appear in the prompt.
 *
 * Returns `""` when the app sent nothing usable — which is how a card CLEARS its context
 * (send an empty update), not an error.
 */
export function serializeAppContext(update: Pick<McpAppModelContextUpdate, "content" | "structuredContent">): string {
  const parts: string[] = [];

  if (Array.isArray(update.content)) {
    const text = update.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    if (text) parts.push(text);
  }

  const structured = update.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    try {
      const json = JSON.stringify(structured, null, 2);
      if (json && json !== "{}") parts.push("```json\n" + json + "\n```");
    } catch {
      // Cyclic / non-serializable structured content is simply not carried. The app gets
      // an EmptyResult regardless, and the previous slot value is what the cap protects.
    }
  }

  // The ONE fence-safety site: the body is app-authored, so it must not be able to close
  // the block that frames it as data and continue outside it. Neutralized here, at the
  // single place a body is ever built — not re-checked downstream.
  return parts.join("\n\n").replaceAll("</mcp-app-context>", "<\\/mcp-app-context>");
}

/**
 * The per-card slots. Keyed `(sessionId, serverId, cardId)` — the same shape as
 * WindowManager's `_mcpDetachedPayloads` registry (a host-minted key for a host-owned
 * record about one card). The app supplies NONE of the three: the trusted renderer binds
 * them, so a card can neither overwrite another card's slot nor place context into a
 * conversation the user has navigated away from.
 */
export class McpAppModelContextStore {
  /** Insertion-ordered — the eviction order for the slot cap. */
  private readonly slots = new Map<string, ModelContextSlot>();

  /** NUL-separated so no component can be crafted to collide with another triple. */
  private static key(sessionId: string, serverId: string, cardId: string): string {
    return [sessionId, serverId, cardId].join("\u0000");
  }

  /**
   * Store (OVERWRITING) one card's context. An empty update clears the slot; an
   * over-cap body is REFUSED and the previous value survives — the app gets an
   * `EmptyResult` either way (the spec gives `ui/update-model-context` no error channel),
   * so the refusal is an audit fact, not a protocol one.
   */
  update(request: McpAppModelContextUpdate): McpUiModelContextOutcome {
    const { sessionId, serverId, cardId } = request;
    if (!isAppMessageOrigin(appMessageSource(serverId))) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a valid MCP server id" };
    }
    if (typeof cardId !== "string" || cardId.length === 0 || cardId.length > 128) {
      return { ok: false, error: "invalid-card-id", message: "cardId must be a bounded non-empty string" };
    }

    const key = McpAppModelContextStore.key(sessionId, serverId, cardId);
    const body = serializeAppContext(request);

    if (body.length === 0) {
      this.slots.delete(key);
      return { ok: true, disposition: "cleared" };
    }
    if (body.length > MCP_APP_MODEL_CONTEXT_MAX_CHARS) {
      return {
        ok: false,
        error: "too-large",
        message: `model context exceeds ${MCP_APP_MODEL_CONTEXT_MAX_CHARS} characters`,
      };
    }

    // OVERWRITE — one card, one slot, last update wins. A re-`set` of an existing key
    // keeps its original insertion position, so a chatty card cannot walk the eviction
    // window and starve the others.
    if (!this.slots.has(key) && this.slots.size >= MCP_APP_MODEL_CONTEXT_MAX_SLOTS) {
      const oldest = this.slots.keys().next().value;
      if (oldest !== undefined) this.slots.delete(oldest);
    }
    this.slots.set(key, { sessionId, serverId, body });
    return { ok: true, disposition: "stored" };
  }

  /**
   * The system-prompt source for ONE session's cards — read at turn build, which is what
   * makes the context "deferred to the next turn" structurally rather than by policy.
   * Returns "" when the session has no live card context, so the prompt section drops out
   * entirely on the overwhelming majority of turns.
   */
  buildSection(sessionId: string): string {
    const live = [...this.slots.values()].filter((slot) => slot.sessionId === sessionId);
    if (live.length === 0) return "";

    const lines: string[] = [
      '<mcp-app-context trust="untrusted-app-data">',
      t("be_systemPromptBuilder.appModelContextUntrusted"),
      t("be_systemPromptBuilder.appModelContextNoInstructions"),
      t("be_systemPromptBuilder.appModelContextNoFollowUp"),
    ];
    for (const slot of live) {
      lines.push("", `### app:${slot.serverId}`, slot.body);
    }
    lines.push("</mcp-app-context>");
    return lines.join("\n");
  }

  /** Live slot count — the cap's observable. */
  size(): number {
    return this.slots.size;
  }
}
