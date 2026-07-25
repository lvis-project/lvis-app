/**
 * Staged turn origins — ONE table, every consumer reads it.
 *
 * A "staged" turn is one whose input was placed by a non-user actor rather than
 * typed: a plugin overlay trigger, an MCP App `ui/message`, or an MCP server
 * `prompts/get` result the user selected. Provenance always travels in an
 * envelope around the text — never a side-channel flag — so any consumer can
 * recover it from the input alone.
 *
 * WHY A TABLE. Each staged origin previously had to be hand-registered at nine
 * independent sites (send-gate envelope requirement, stream origin derivation,
 * mid-turn guidance escalation, tool-trust classification, transcript marker,
 * force-ask predicate, command suppression, model-facing guidance, UI label),
 * and only ONE of those had a compile-time guard. Every missed site failed OPEN — most severely, a missing
 * stream-derivation branch silently leaves the turn with no staged origin, which
 * disables the permission force-ask entirely. Adding an origin is now a single
 * entry here, and each consumer resolves through {@link stagedOriginForInput} /
 * {@link stagedOriginForSource} instead of an if/else chain with a default.
 *
 * INVARIANT: a `ChatInputOrigin` listed here MUST be rejected by the send gate
 * unless its envelope is present, and MUST be treated as untrusted downstream.
 *
 * WHEN A CLAIM AND AN ENVELOPE DISAGREE, three sites answer differently, and each
 * answer is deliberate — the rule is "never resolve DOWNWARD in trust":
 *   - `ipc/handlers/chat.ts` (the send gate) REJECTS. The renderer authors both
 *     halves there, so a disagreement is a bug or an attempt, never a fact.
 *   - `ipc/handlers/chat-stream.ts` ADOPTS THE ENVELOPE. Its replay callers resend
 *     stored text under a fixed `user-keyboard` default, so the text is the only
 *     evidence of who wrote it; adopting it escalates, and a staged claim with no
 *     readable envelope throws rather than silently losing the origin.
 *   - `engine/turn/run-turn.ts` KEEPS THE CLAIM and drops a foreign envelope from
 *     the transcript row, so a direct `runTurn` caller (the routine engine) cannot
 *     label its row with another actor's provenance.
 * Each site is annotated with its own reason; this is the map.
 */
import type { ChatInputOrigin, StagedChatInputOrigin } from "./chat-origin.js";
import { type FenceTag, neutralizeFenceClose } from "./fence-sanitizer.js";
import { stripLeadingSlash } from "./slash-sanitizer.js";

export interface StagedOriginKind {
  /**
   * Turn-entry origin this envelope authorizes.
   *
   * Typed as `StagedChatInputOrigin` because `isChatSendInputOrigin` derives its
   * staged half FROM this table: a wider type here would let one registration widen
   * the `chat:send` accept gate to a non-send origin with no compile error — the
   * same fail-open one level up.
   */
  readonly inputOrigin: StagedChatInputOrigin;
  /** Fence tag wrapping the untrusted body. Closed union ⇒ compile-time guard. */
  readonly fenceTag: FenceTag;
  /** Strict, bounded shape of the provenance tag (e.g. `app:<serverId>`). */
  readonly sourcePattern: RegExp;
  /**
   * Model-facing origin guidance, emitted by ONE per-turn prompt source that
   * resolves through this table. The hard gate (force-ask) and the soft gate
   * (this text) then register together, so a staged origin cannot ship with a
   * permission gate but no instruction telling the model the body is untrusted.
   */
  readonly guidance: {
    /** Wrapper tag for the emitted block. */
    readonly tag: string;
    /** Ordered i18n keys; the FIRST one receives the `{source}` placeholder. */
    readonly lineKeys: readonly string[];
  };
  /**
   * i18n key for the transcript's trust chip. Registered here for the same reason
   * the guidance is: a hand-written label switch falls through to `default` and
   * renders the raw kebab-case origin at the user.
   */
  readonly labelKey: string;
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

/**
 * Both patterns are anchored and their source group is bounded, so neither can be
 * driven super-linearly by a long input.
 *
 * The body group is GREEDY and has no `\s*` beside it on purpose. The obvious
 * spelling — `>\s*([\s\S]*?)\s*</tag>` — puts three quantifiers that all match a
 * space next to each other, and on a header followed by whitespace and NO closing
 * tag the engine explores their overlap: measured cubic (~2.5s at 2,000 chars,
 * ~50s at 6,000). The greedy form scans to the end once and walks back to the last
 * `</tag>`; because `$` anchors the match either way, it selects the same body as
 * the lazy form. Whitespace around the body is trimmed by the caller instead.
 */
function envelopePatterns(fenceTag: string, sourceBody: string): {
  prefix: RegExp;
  full: RegExp;
} {
  return {
    prefix: new RegExp(`^<${fenceTag}\\s+source="(${sourceBody})"\\s*>`),
    full: new RegExp(
      `^<${fenceTag}\\s+source="(${sourceBody})"\\s*>([\\s\\S]*)</${fenceTag}>\\s*$`,
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
 * The registry, keyed by turn-entry origin.
 *
 * TOTAL over `StagedChatInputOrigin`, so adding a member to that union without a
 * row here is a compile error, and a lookup by a literal member cannot be
 * `undefined` — which is what lets the module-level consumers resolve their row
 * without a defensive `!` or throw. Order is not significant: lookups are by
 * `inputOrigin` or by matching the source tag / envelope, and the namespaces are
 * disjoint.
 */
const STAGED_ORIGINS: Readonly<Record<StagedChatInputOrigin, StagedOriginKind>> = Object.freeze({
  "plugin-emitted": Object.freeze({
    inputOrigin: "plugin-emitted",
    labelKey: "trustOriginLabel.pluginEmitted",
    fenceTag: "imported-from-proactive",
    sourcePattern: new RegExp(`^${OVERLAY_SOURCE_BODY}$`),
    guidance: {
      tag: "overlay-trigger-origin-guidance",
      lineKeys: [
        "be_systemPromptBuilder.overlayTriggerOriginNotDirectInput",
        "be_systemPromptBuilder.overlayTriggerOriginPluginSuggestion",
        "be_systemPromptBuilder.overlayTriggerOriginValidateFirst",
        "be_systemPromptBuilder.overlayTriggerOriginCheck1",
        "be_systemPromptBuilder.overlayTriggerOriginCheck2",
        "be_systemPromptBuilder.overlayTriggerOriginCheck3",
        "be_systemPromptBuilder.overlayTriggerOriginPassIfInvalid",
        "be_systemPromptBuilder.overlayTriggerOriginProceedIfValid",
      ],
    },
    missingEnvelopeError: "missing-plugin-envelope",
    envelopePrefixPattern: overlayEnvelope.prefix,
    envelopeFullPattern: overlayEnvelope.full,
  } as const),
  "app-emitted": Object.freeze({
    inputOrigin: "app-emitted",
    labelKey: "trustOriginLabel.appEmitted",
    fenceTag: "app-message",
    sourcePattern: new RegExp(`^${APP_SOURCE_BODY}$`),
    guidance: {
      tag: "app-message-origin-guidance",
      lineKeys: [
        "be_systemPromptBuilder.appMessageOriginNotDirectInput",
        "be_systemPromptBuilder.appMessageOriginUntrusted",
        "be_systemPromptBuilder.appMessageOriginConfirmBeforeAction",
      ],
    },
    missingEnvelopeError: "missing-app-envelope",
    envelopePrefixPattern: appEnvelope.prefix,
    envelopeFullPattern: appEnvelope.full,
  } as const),
  "mcp-prompt-emitted": Object.freeze({
    inputOrigin: "mcp-prompt-emitted",
    labelKey: "trustOriginLabel.mcpPromptEmitted",
    fenceTag: "mcp-prompt",
    sourcePattern: new RegExp(`^${MCP_PROMPT_SOURCE_BODY}$`),
    guidance: {
      tag: "mcp-prompt-origin-guidance",
      lineKeys: [
        "be_systemPromptBuilder.mcpPromptOriginNotDirectInput",
        "be_systemPromptBuilder.mcpPromptOriginServerAuthored",
        "be_systemPromptBuilder.mcpPromptOriginConfirmBeforeAction",
      ],
    },
    missingEnvelopeError: "missing-mcp-prompt-envelope",
    envelopePrefixPattern: mcpPromptEnvelope.prefix,
    envelopeFullPattern: mcpPromptEnvelope.full,
  } as const),
});

/** Iteration order for consumers that scan every kind (parsers, invariants). */
export const STAGED_ORIGIN_KINDS: readonly StagedOriginKind[] = Object.freeze(
  Object.values(STAGED_ORIGINS),
);

/**
 * The row for a KNOWN staged origin. Total, so this is the lookup to use with a
 * literal — `stagedOriginForInput` is for the case where the origin is data.
 */
export function stagedOriginFor(inputOrigin: StagedChatInputOrigin): StagedOriginKind {
  return STAGED_ORIGINS[inputOrigin];
}

/** The kind that owns a turn-entry origin, or undefined for non-staged origins. */
export function stagedOriginForInput(
  inputOrigin: ChatInputOrigin | null | undefined,
): StagedOriginKind | undefined {
  if (!inputOrigin) return undefined;
  return STAGED_ORIGIN_KINDS.find((kind) => kind.inputOrigin === inputOrigin);
}

/**
 * Runtime membership test for the staged half of `ChatSendInputOrigin`.
 *
 * `chat:send`'s accept gate needs a RUNTIME check, and hand-writing one beside
 * the type union is exactly how a registered origin gets silently rejected (the
 * union widens, the hand-written guard does not, and tsc cannot see the gap).
 * Deriving it from the table keeps the two in step.
 */
export function isStagedSendOrigin(value: unknown): boolean {
  return STAGED_ORIGIN_KINDS.some((kind) => kind.inputOrigin === value);
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
 * This is the ONLY place a staged body is sanitized — the overlay and app builders
 * (`formatPluginPendingPrompt`, `formatAppMessageEnvelope`) delegate here — so both
 * rules live in one place:
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

/**
 * Match any registered envelope and split out provenance + body.
 *
 * Ordered cheapest-first, and that order is load-bearing: the prefix match is
 * anchored and bounded, so it settles immediately and tells us WHICH kind to
 * consider, and a plain `endsWith` then rules out an unclosed envelope before the
 * full pattern runs at all. Handing an unclosed body to the quantifier first is
 * reachable from imported session JSONL — those rows carry no provenance meta, so
 * the envelope-recovery path is what runs on them.
 */
export function parseStagedEnvelopePayload(input: string): StagedEnvelope | null {
  const trimmed = input.trim();
  const prefix = parseStagedEnvelope(trimmed);
  if (!prefix) return null;
  if (trimmed.endsWith(`</${prefix.kind.fenceTag}>`)) {
    const full = trimmed.match(prefix.kind.envelopeFullPattern);
    if (full) return { kind: prefix.kind, source: full[1], body: full[2].trim() };
  }
  // Header without a matching close: provenance is still known and the body is
  // whatever followed the header. Callers that require a CLOSED envelope (the
  // transcript replay path) check the closing tag themselves.
  return {
    kind: prefix.kind,
    source: prefix.source,
    body: trimmed.replace(prefix.kind.envelopePrefixPattern, "").trim(),
  };
}
