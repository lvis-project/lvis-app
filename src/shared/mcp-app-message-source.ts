/**
 * MCP-App message source + envelope — single source of truth.
 *
 * The exact mirror of `overlay-trigger-source.ts`, one namespace over: a plugin's
 * overlay trigger is `overlay:<name>` wrapped in `<imported-from-proactive>`, and an
 * MCP App's `ui/message` is `app:<serverId>` wrapped in `<app-message>`.
 *
 * The ENVELOPE is the provenance mechanism — not a side-channel flag. Every consumer
 * reads provenance from the same wrapper:
 *   - `ipc/handlers/chat.ts`  — an `app-emitted` send without the envelope is rejected.
 *   - `ipc/handlers/chat-stream.ts` → `engine/turn/run-turn.ts` — the parsed source
 *     becomes the turn's origin source and the transcript's `imported_trigger` marker.
 *   - `permissions/permission-manager.ts` — `isStagedTurnSource` (the registry's own
 *     predicate) forces every write/shell/network tool to ask the user. That is the
 *     ONE enforcement site, and it reads the table directly — there is deliberately
 *     no alias here for it, so grepping the predicate lands on the gate.
 *   - `engine/turn/query-loop.ts` — app-authored guidance injected mid-turn downgrades
 *     the REST of that turn to the same staged origin.
 *   - `core/input-classifier.ts` — an enveloped turn never routes as a command.
 *
 * The body is app-authored and UNTRUSTED. The envelope itself — its pattern, its
 * construction, and the sanitization of the body (leading slash stripped so app
 * text cannot dispatch a host slash command; the body's own `</app-message>`
 * neutralized so it cannot close its provenance fence and continue outside it) —
 * belongs to `shared/staged-origins.ts`. What remains here is the `app:` NAMING
 * (tag shape + the helpers callers already import), delegating to that table.
 */
import {
  formatStagedEnvelope,
  parseStagedEnvelope,
  stagedOriginFor,
} from "./staged-origins.js";

/**
 * The APP row of the staged-origin table. Resolved once here so this module's
 * envelope helpers cannot drift from the patterns every consumer reads. The registry
 * is a total `Record` over the staged origins, so this lookup is compile-checked —
 * no `!`, and no unreachable branch to explain.
 */
const APP_KIND = stagedOriginFor("app-emitted");

/**
 * Strict `app:<serverId>` shape. serverIds are MCP server ids / plugin ids
 * (alphanumeric + `.`/`-`/`_`). Bounded so a hostile id cannot bloat audit rows or
 * system prompts; fail-closed — a non-matching source is never enveloped.
 *
 * Taken FROM the table row below, not re-declared: a second copy of the regex is a
 * second definition of what an app origin is, and the two would drift.
 */
export const APP_MESSAGE_SOURCE_PATTERN = APP_KIND.sourcePattern;

/** Build the canonical origin tag for a card's bound server. */
export function appMessageSource(serverId: string): string {
  return `app:${serverId}`;
}

/** Returns true iff `source` is a valid MCP-app message origin tag. */
export function isAppMessageOrigin(source: string | null | undefined): boolean {
  return typeof source === "string" && APP_MESSAGE_SOURCE_PATTERN.test(source);
}


/**
 * Wrap app-authored text for the conversation. Throws on an invalid source — the
 * renderer binds it from the card's `serverId`, so a bad value is a host bug, and
 * an unenveloped app message must never reach the loop (No-Fallback).
 *
 * Sanitization (leading slash, own closing tag) lives in {@link formatStagedEnvelope}
 * for every staged kind, so a rule added there — as one was for `<mcp-prompt>` —
 * applies here without a second edit.
 */
export function formatAppMessageEnvelope(text: string, source: string): string {
  return formatStagedEnvelope(APP_KIND, text, source);
}

/**
 * Parse the `<app-message source="app:...">` prefix. Returns the source tag or
 * `null` when the input does not begin with THIS kind's envelope (a different
 * staged kind's envelope is not an app message).
 */
export function parseAppMessageEnvelope(input: string): string | null {
  const parsed = parseStagedEnvelope(input);
  return parsed && parsed.kind === APP_KIND ? parsed.source : null;
}
