/**
 * Staged turn origins — ONE table, every consumer reads it.
 *
 * A "staged" turn is one whose input was placed by a non-user actor rather than
 * typed: a plugin overlay trigger, an MCP App `ui/message`, or an MCP server
 * `prompts/get` result the user selected. Provenance always travels in an
 * envelope around the text — never a side-channel flag — so any consumer can
 * recover it from the input alone.
 *
 * WHY A TABLE. Each staged origin previously had to be hand-registered at eight
 * independent sites (send-gate envelope requirement, stream origin derivation,
 * tool-trust classification, transcript marker, force-ask predicate, command
 * suppression, model-facing guidance, UI label), and only ONE of those had a
 * compile-time guard. Every missed site failed OPEN — most severely, a missing
 * stream-derivation branch silently leaves the turn with no staged origin, which
 * disables the permission force-ask entirely. Adding an origin is now a single
 * entry here, and each consumer resolves through {@link stagedOriginForInput} /
 * {@link stagedOriginForSource} instead of an if/else chain with a default.
 *
 * INVARIANT: a `ChatInputOrigin` listed here MUST be rejected by the send gate
 * unless its envelope is present, and MUST be treated as untrusted downstream.
 */
import type { ChatInputOrigin } from "./chat-origin.js";
import { type FenceTag, neutralizeFenceClose } from "./fence-sanitizer.js";
import { stripLeadingSlash } from "./slash-sanitizer.js";

export interface StagedOriginKind {
  /** Turn-entry origin this envelope authorizes (`ChatSendInputOrigin` member). */
  readonly inputOrigin: ChatInputOrigin;
  /** Fence tag wrapping the untrusted body. Closed union ⇒ compile-time guard. */
  readonly fenceTag: FenceTag;
  /** Strict, bounded shape of the provenance tag (e.g. `app:<serverId>`). */
  readonly sourcePattern: RegExp;
  /** i18n key prefix for the model-facing origin guidance section. */
  readonly guidanceKeyPrefix: string;
  /**
   * IPC rejection code when a send claims this origin without its envelope.
   * Part of the renderer's error contract (`ui/renderer/format-ipc-error.ts`),
   * so it is spelled out here rather than derived from the fence tag.
   */
  readonly missingEnvelopeError: string;
  /** Envelope prefix matcher — capture group 1 is the source tag. */
  readonly envelopePrefixPattern: RegExp;
  /** Full-envelope matcher — group 1 source, group 2 body. */
  readonly envelopeFullPattern: RegExp;
}

function envelopePatterns(fenceTag: string, sourceBody: string): {
  prefix: RegExp;
  full: RegExp;
} {
  return {
    prefix: new RegExp(`^<${fenceTag}\\s+source="(${sourceBody})"\\s*>`),
    full: new RegExp(
      `^<${fenceTag}\\s+source="(${sourceBody})"\\s*>\\s*([\\s\\S]*?)\\s*</${fenceTag}>\\s*$`,
    ),
  };
}

const OVERLAY_SOURCE_BODY = "overlay:[a-z][a-z0-9-]*";
const APP_SOURCE_BODY = "app:[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const MCP_PROMPT_SOURCE_BODY = "mcp-prompt:[A-Za-z0-9][A-Za-z0-9._-]{0,127}";

const overlayEnvelope = envelopePatterns("imported-from-proactive", OVERLAY_SOURCE_BODY);
const appEnvelope = envelopePatterns("app-message", APP_SOURCE_BODY);
const mcpPromptEnvelope = envelopePatterns("mcp-prompt", MCP_PROMPT_SOURCE_BODY);

/**
 * The registry. Order is not significant — lookups are by `inputOrigin` or by
 * matching the source tag / envelope, both of which are mutually exclusive
 * because the namespaces are disjoint.
 */
export const STAGED_ORIGIN_KINDS: readonly StagedOriginKind[] = Object.freeze([
  Object.freeze({
    inputOrigin: "plugin-emitted",
    fenceTag: "imported-from-proactive",
    sourcePattern: new RegExp(`^${OVERLAY_SOURCE_BODY}$`),
    guidanceKeyPrefix: "overlayTriggerOrigin",
    missingEnvelopeError: "missing-plugin-envelope",
    envelopePrefixPattern: overlayEnvelope.prefix,
    envelopeFullPattern: overlayEnvelope.full,
  } as const),
  Object.freeze({
    inputOrigin: "app-emitted",
    fenceTag: "app-message",
    sourcePattern: new RegExp(`^${APP_SOURCE_BODY}$`),
    guidanceKeyPrefix: "appMessageOrigin",
    missingEnvelopeError: "missing-app-envelope",
    envelopePrefixPattern: appEnvelope.prefix,
    envelopeFullPattern: appEnvelope.full,
  } as const),
  Object.freeze({
    inputOrigin: "mcp-prompt-emitted",
    fenceTag: "mcp-prompt",
    sourcePattern: new RegExp(`^${MCP_PROMPT_SOURCE_BODY}$`),
    guidanceKeyPrefix: "mcpPromptOrigin",
    missingEnvelopeError: "missing-mcp-prompt-envelope",
    envelopePrefixPattern: mcpPromptEnvelope.prefix,
    envelopeFullPattern: mcpPromptEnvelope.full,
  } as const),
]);

/** The kind that owns a turn-entry origin, or undefined for non-staged origins. */
export function stagedOriginForInput(
  inputOrigin: ChatInputOrigin | null | undefined,
): StagedOriginKind | undefined {
  if (!inputOrigin) return undefined;
  return STAGED_ORIGIN_KINDS.find((kind) => kind.inputOrigin === inputOrigin);
}

/** The kind that owns a provenance source tag, or undefined when unrecognized. */
export function stagedOriginForSource(
  source: string | null | undefined,
): StagedOriginKind | undefined {
  if (typeof source !== "string") return undefined;
  return STAGED_ORIGIN_KINDS.find((kind) => kind.sourcePattern.test(source));
}

/**
 * Is this a staged (non-typed) turn origin? THE force-ask predicate: the
 * permission manager and the system prompt both read this one definition, so a
 * registered origin cannot skip the gate and an unregistered tag cannot pass it.
 */
export function isStagedTurnSource(source: string | null | undefined): boolean {
  return stagedOriginForSource(source) !== undefined;
}

export interface StagedEnvelope {
  kind: StagedOriginKind;
  source: string;
  body: string;
}

/**
 * Build an envelope around actor-authored text. Throws on a source that does not
 * match the kind's pattern — an unenveloped staged message must never reach the
 * loop (No-Fallback), and a malformed tag is a host bug.
 *
 * This is the ONLY place a staged body is sanitized, so both rules live here:
 * strip a leading slash so the text cannot dispatch a host slash command, and
 * neutralize the body's own closing tag so it cannot escape its provenance fence
 * and continue outside it.
 */
export function formatStagedEnvelope(
  kind: StagedOriginKind,
  text: string,
  source: string,
): string {
  if (!kind.sourcePattern.test(source)) {
    throw new Error(`invalid ${kind.fenceTag} source: ${source}`);
  }
  const body = neutralizeFenceClose(stripLeadingSlash(text), kind.fenceTag);
  return `<${kind.fenceTag} source="${source}">\n${body}\n</${kind.fenceTag}>`;
}

/** Match any registered envelope prefix; returns the kind + source tag. */
export function parseStagedEnvelope(
  input: string,
): { kind: StagedOriginKind; source: string } | null {
  const trimmed = input.trimStart();
  for (const kind of STAGED_ORIGIN_KINDS) {
    const match = trimmed.match(kind.envelopePrefixPattern);
    if (match) return { kind, source: match[1] };
  }
  return null;
}

/** Match any registered envelope and split out provenance + body. */
export function parseStagedEnvelopePayload(input: string): StagedEnvelope | null {
  const trimmed = input.trim();
  for (const kind of STAGED_ORIGIN_KINDS) {
    const full = trimmed.match(kind.envelopeFullPattern);
    if (full) return { kind, source: full[1], body: full[2].trim() };
  }
  const prefix = parseStagedEnvelope(trimmed);
  if (!prefix) return null;
  return {
    kind: prefix.kind,
    source: prefix.source,
    body: trimmed.replace(prefix.kind.envelopePrefixPattern, "").trim(),
  };
}
