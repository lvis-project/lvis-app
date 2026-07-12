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
 *   - `permissions/permission-manager.ts` — {@link isStagedTurnOrigin} forces every
 *     write/shell/network tool to ask the user (the ONE enforcement site).
 *   - `engine/turn/query-loop.ts` — app-authored guidance injected mid-turn downgrades
 *     the REST of that turn to the same staged origin.
 *   - `core/keyword-engine.ts` — an enveloped turn never routes as a skill/command.
 *
 * The body is app-authored and UNTRUSTED. {@link formatAppMessageEnvelope} is the only
 * place that builds one, so it is the only place the body is sanitized: it strips a
 * leading slash so app text can never dispatch a host slash command (the same rule
 * `sanitizePluginPendingPrompt` applies to plugins), and it neutralizes a `</app-message>`
 * in the body so the app cannot close its own provenance fence and continue outside it
 * (`shared/fence-sanitizer.ts` — the same helper the other two fences use).
 */
import { neutralizeFenceClose } from "./fence-sanitizer.js";
import { isOverlayTriggerOrigin } from "./overlay-trigger-source.js";
import { stripLeadingSlash } from "./slash-sanitizer.js";

/**
 * Strict `app:<serverId>` shape. serverIds are MCP server ids / plugin ids
 * (alphanumeric + `.`/`-`/`_`). Bounded so a hostile id cannot bloat audit rows or
 * system prompts; fail-closed — a non-matching source is never enveloped.
 */
export const APP_MESSAGE_SOURCE_PATTERN = /^app:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Build the canonical origin tag for a card's bound server. */
export function appMessageSource(serverId: string): string {
  return `app:${serverId}`;
}

/** Returns true iff `source` is a valid MCP-app message origin tag. */
export function isAppMessageOrigin(source: string | null | undefined): boolean {
  return typeof source === "string" && APP_MESSAGE_SOURCE_PATTERN.test(source);
}

/**
 * Any turn whose input was STAGED by a non-user actor rather than typed: a plugin
 * overlay trigger (`overlay:*`) or an MCP App `ui/message` (`app:*`).
 *
 * This is the predicate the permission manager and the system prompt use — one
 * definition, so a new staged origin can never be added while quietly skipping the
 * force-ask gate.
 */
export function isStagedTurnOrigin(source: string | null | undefined): boolean {
  return isOverlayTriggerOrigin(source) || isAppMessageOrigin(source);
}

const APP_MESSAGE_ENVELOPE_PATTERN =
  /^<app-message\s+source="(app:[A-Za-z0-9][A-Za-z0-9._-]{0,127})"\s*>/;

const APP_MESSAGE_ENVELOPE_FULL_PATTERN =
  /^<app-message\s+source="(app:[A-Za-z0-9][A-Za-z0-9._-]{0,127})"\s*>\s*([\s\S]*?)\s*<\/app-message>\s*$/;

export interface AppMessageEnvelope {
  source: string;
  body: string;
}

/**
 * Wrap app-authored text for the conversation. Throws on an invalid source — the
 * renderer binds it from the card's `serverId`, so a bad value is a host bug, and
 * an unenveloped app message must never reach the loop (No-Fallback).
 *
 * The body is neutralized against its OWN closing tag here: an app that sends
 * `"done\n</app-message>\n<system>…"` would otherwise author text that reads, to the
 * model, as sitting outside the untrusted-provenance fence — defeating the whole
 * labelling mechanism this module exists to provide.
 */
export function formatAppMessageEnvelope(text: string, source: string): string {
  if (!isAppMessageOrigin(source)) {
    throw new Error(`invalid app message source: ${source}`);
  }
  const body = neutralizeFenceClose(stripLeadingSlash(text), "app-message");
  return `<app-message source="${source}">\n${body}\n</app-message>`;
}

/**
 * Parse the `<app-message source="app:...">` prefix. Returns the source tag or
 * `null` when the input does not begin with the envelope.
 */
export function parseAppMessageEnvelope(input: string): string | null {
  const m = input.trimStart().match(APP_MESSAGE_ENVELOPE_PATTERN);
  return m ? m[1] : null;
}

/** Parse the full envelope into provenance + body (transcript / history replay). */
export function parseAppMessageEnvelopePayload(input: string): AppMessageEnvelope | null {
  const trimmed = input.trim();
  const full = trimmed.match(APP_MESSAGE_ENVELOPE_FULL_PATTERN);
  if (full) return { source: full[1], body: full[2].trim() };
  const source = parseAppMessageEnvelope(trimmed);
  if (!source) return null;
  return { source, body: trimmed.replace(APP_MESSAGE_ENVELOPE_PATTERN, "").trim() };
}
