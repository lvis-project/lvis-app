/**
 * MCP Apps `ui/message` — the pure parse half of the host handler.
 *
 * The spec's params are `{ role: "user", content: ContentBlock[] }` and carry NO
 * `_meta` of their own (`additionalProperties: false`); a content BLOCK's `_meta` is
 * open, which is where LVIS's vendor key rides. So there are exactly two intents an
 * app can express, and this module is the ONE place that decides which:
 *
 *   1. NOTIFICATION — a block declares `_meta["lvisai/notification"]`. The app wants
 *      the user's attention, not the model's. It goes to `NotificationService`
 *      (focus gate + per-kind cooldown + sanitization + audit), never the transcript.
 *   2. TEXT — plain content. It belongs in the conversation, under the host's turn
 *      policy (see the IPC handler).
 *
 * Everything in here is app-authored and UNTRUSTED. This module only *classifies*,
 * *bounds*, and *narrows* it (see {@link AppNotificationMeta} — the app does not get to
 * carry host delivery policy on the wire). The sanitizing belongs to the sinks: title
 * cap / body truncate / markdown strip / control-char strip in NotificationService on one
 * side, and the `<app-message>` envelope (leading-slash strip + closing-fence
 * neutralization) on the other. No third sanitizer.
 */

/**
 * Hard cap on the text an app can push into a turn. Mirrors the plugin overlay
 * trigger's `MAX_PROMPT_LEN` — generous for a templated message, tight enough that a
 * card cannot dump a document into the context window. Well under `GUIDE_MAX_CHARS`
 * (8 000), so a message that passes here always fits the guidance queue.
 */
export const MCP_APP_MESSAGE_MAX_CHARS = 4096;

/** The ONE vendor `_meta` key that routes a message to the popup surface. */
export const APP_NOTIFICATION_META_KEY = "lvisai/notification";

export type AppNotificationSeverity = "info" | "warning" | "critical";

/**
 * The `_meta["lvisai/notification"]` shape. Every field is untrusted app text.
 *
 * Deliberately NARROW: an app may ASK for the user's attention, it may not decide that
 * its alert outranks the host's delivery policy. Two switches the wire format does NOT
 * carry, and that this parser therefore cannot lift off it:
 *
 *   · `bypassFocusGate` — an opt-in MANIFEST signal (see `notification-service.ts` and
 *     `boot/plugins.ts`): statically reviewable, covered by `manifestSha256`. Handing it
 *     to a sandboxed iframe would let a card fire an OS popup while the user is looking
 *     straight at LVIS, and burn the shared per-kind cooldown slot other plugins' real
 *     alerts depend on.
 *   · urgency — `severity` below is an app CLAIM, recorded in the audit row and nothing
 *     else. It never reaches `FireOptions.urgent`, so a card cannot promote itself to a
 *     non-silent notification.
 */
export interface AppNotificationMeta {
  title: string;
  body: string;
  /** Advisory only — audited, never a behavior switch. See the caveat above. */
  severity?: AppNotificationSeverity;
}

export type McpUiMessageIntent =
  | { kind: "notification"; notification: AppNotificationMeta }
  | { kind: "text"; text: string }
  | { kind: "invalid"; error: string; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Lift the notification an app is ASKING for — and only that. Anything the app puts on
 * the wire that is not `title` / `body` / `severity` is dropped here, at the boundary, so
 * no downstream dispatch site has to remember which app-supplied fields are safe to
 * forward (notably: a wire `bypassFocusGate` is not a field of the result type, so it
 * cannot be threaded on by accident).
 */
function parseNotificationMeta(raw: unknown): AppNotificationMeta | null {
  const meta = asRecord(raw);
  if (!meta) return null;
  const { title, body } = meta;
  if (typeof title !== "string" || typeof body !== "string") return null;
  const severity = meta.severity;
  return {
    title,
    body,
    ...(severity === "info" || severity === "warning" || severity === "critical"
      ? { severity }
      : {}),
  };
}

/**
 * Classify one `ui/message` request. Notification meta on ANY content block wins over
 * the text path — an app that wants a popup gets a popup, and that message never
 * reaches the conversation (the two paths are exclusive by construction, so there is
 * no way to smuggle text into the model under cover of a notification).
 *
 * Only `text` blocks contribute to the conversation text: the host advertises
 * `message: { text: {} }` and nothing else, so image/audio/resource blocks are ignored
 * rather than silently coerced.
 */
export function parseUiMessageIntent(params: unknown): McpUiMessageIntent {
  const record = asRecord(params);
  const content = record?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return { kind: "invalid", error: "invalid-content", message: "content must be a non-empty array" };
  }

  for (const block of content) {
    const blockRecord = asRecord(block);
    if (!blockRecord) continue;
    const meta = asRecord(blockRecord._meta);
    if (!meta) continue;
    const notification = parseNotificationMeta(meta[APP_NOTIFICATION_META_KEY]);
    if (notification) return { kind: "notification", notification };
  }

  const text = content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();

  if (text.length === 0) {
    return { kind: "invalid", error: "empty-message", message: "message has no text content" };
  }
  if (text.length > MCP_APP_MESSAGE_MAX_CHARS) {
    return {
      kind: "invalid",
      error: "message-too-long",
      message: `message exceeds ${MCP_APP_MESSAGE_MAX_CHARS} characters`,
    };
  }
  return { kind: "text", text };
}

/**
 * The host's answer to `ui/message`. An OUTCOME, never a throw — the bridge handler
 * turns it into the spec's `{ isError?: boolean }`, which by TYPE cannot carry
 * conversation content back to the app (the spec's explicit "the host MUST NOT return
 * conversation content"). `disposition` is host-side bookkeeping for audit/tests only.
 */
export type McpUiMessageOutcome =
  | { ok: true; disposition: "notified" | "queued" | "staged" }
  | { ok: false; error: string; message?: string };
