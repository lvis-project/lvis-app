/**
 * Bounds and validation for MCP server resources — shared by all three layers.
 *
 * Same reason `mcp-prompt-bounds.ts` exists: these numbers are a CONTRACT between
 * the client discovery boundary (main), the read path (main), and whatever UI
 * eventually offers a resource to the user. A field the UI shows that main then
 * drops is worse than no field, so they cannot be re-declared per layer.
 *
 * See `docs/development/mcp-resources-policy.md` for why each bound is what it is.
 * Its only import is `display-safe-text`, which is itself import-free, so this stays
 * importable from every process.
 */
import { hasInvisibleOrReorderingChars } from "./display-safe-text.js";

/** Catalogued resources per server — the picker is a list a person scans. */
export const MCP_RESOURCE_MAX_PER_SERVER = 200;
/** Rendered text per read. Larger than a prompt because a resource IS the payload. */
export const MCP_RESOURCE_MAX_CHARS = 32 * 1024;
/** `contents[]` blocks per read — a read is one document, not a conversation. */
export const MCP_RESOURCE_MAX_BLOCKS = 32;
/** URI length. Audit rows and labels interpolate it. */
export const MCP_RESOURCE_URI_MAX_CHARS = 2_048;
/** Display-string bounds for host chrome. */
export const MCP_RESOURCE_NAME_MAX_CHARS = 128;
export const MCP_RESOURCE_DESCRIPTION_MAX_CHARS = 512;
/**
 * Resource attachments one turn may carry.
 *
 * A mention is cheap to type and each attachment is up to the per-read bound, so
 * without this a handful of them fills the window before the model reads a word
 * of the user's own message. Enforced in main, not in the composer: the renderer
 * decides what to offer, main decides what a turn carries — see
 * {@link countResourceAttachmentFences} for why the count is over FENCES rather
 * than over content parts.
 */
export const MCP_RESOURCE_ATTACHMENTS_PER_TURN = 8;

/**
 * The open tag every resource attachment carries.
 *
 * Lives here, with the bounds, rather than with the builder: it is the same kind of
 * cross-layer contract as the numbers above — the builder writes it, the turn-entry
 * chokepoint counts it, and a renderer that displays or strips the frame reads it.
 * A second spelling of this string anywhere is a silently-uncounted attachment.
 */
export const MCP_RESOURCE_FENCE_OPEN = '<mcp-resource trust="untrusted-server-data"';

/**
 * How many resource fences a turn's ATTACHED parts carry.
 *
 * Counts OCCURRENCES, not parts. Asking whether a part *starts with* the fence made
 * the bound a property of the renderer's packaging rather than of what it attached: a
 * composer that joined twelve attachments into one text part — the natural way to put
 * a fence beside the user's own words — counted as one, and ~384 KB of server-authored
 * text entered a turn whose bound was meant to be 8 reads. Counting the tag makes the
 * answer the same however the parts are packaged.
 *
 * Scoped to ATTACHMENTS on purpose; the user's own message text is not counted, even
 * though a fence pasted there is indistinguishable from a host-built one. Counting it
 * looked stricter and was worse: this bound governs what the HOST attaches, so a
 * refusal is only ever explainable when the host built the material. A developer
 * pasting an LVIS transcript excerpt — which contains these fences verbatim — would
 * otherwise have their message rejected, told to remove resources they never attached,
 * with no way to discover why. A bound on window budget must not make legitimate text
 * unsendable.
 *
 * What that scope gives up, in ascending order of how much it matters:
 *   - a forged fence in the user's own words is the user demoting their OWN text (the
 *     fence marks content as less trusted, never more), so it buys a forger nothing;
 *   - the replay paths fold a turn's parts into the input text, so the count no longer
 *     applies there. For history this host built that is harmless — a replay re-sends
 *     a turn that already passed, and folding cannot multiply it — but an IMPORTED
 *     session's user message can carry any number of fenced blocks, and replaying that
 *     row is unbounded. The material is already in the transcript and reaches the model
 *     as context either way, so this bounds nothing it was not already past;
 *   - and one real constraint on stage 3b: a mention must resolve to an attachment
 *     PART. A composer that splices the fence into the user's message text puts server
 *     content in the one field this does not measure.
 */
export function countResourceAttachmentFences(
  parts?: ReadonlyArray<{ type?: unknown; text?: unknown }>,
): number {
  let count = 0;
  for (const part of parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string") count += occurrences(part.text);
  }
  return count;
}

/** Scanned rather than split: the parts are up to a read's worth of text each. */
function occurrences(text: string): number {
  let count = 0;
  for (
    let at = text.indexOf(MCP_RESOURCE_FENCE_OPEN);
    at !== -1;
    at = text.indexOf(MCP_RESOURCE_FENCE_OPEN, at + MCP_RESOURCE_FENCE_OPEN.length)
  ) {
    count += 1;
  }
  return count;
}

/** Bounded page walk so a hostile `nextCursor` loop cannot hang the handshake. */
export const MCP_RESOURCE_MAX_PAGES = 20;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Characters RFC 3986 excludes from a URI, which therefore cannot appear unencoded
 * in a legitimate one: space, double quote, `<`, `>`, backslash, backtick, `^`,
 * `{`, `}`, `|`.
 *
 * Rejected HERE rather than escaped at each consumer, because the same string is
 * later printed into a provenance fence's attributes, serialized into a tool
 * result, interpolated into an audit line, and (soon) rendered in a picker. A URI
 * containing `">` let a listed resource close the untrusted fence on its first line
 * and place server-authored prose OUTSIDE it, beside the user's own words — the one
 * position the fence exists to prevent. Escaping per consumer would have left the
 * next consumer to rediscover that; a URI that cannot hold the character cannot.
 */
const URI_EXCLUDED_CHARS_RE = /[\s"<>\\^`{}|]/;

/**
 * URI schemes the host will carry as an OPAQUE identifier.
 *
 * The host never resolves any of these itself — it hands the string back to the
 * server that published it. The allowlist exists so a resource cannot smuggle a
 * scheme the host has other meaning for:
 *   - `ui:` belongs to the MCP-Apps extension and its own serving path, which has
 *     different containment rules; the two must never cross.
 *   - `javascript:`/`data:`/`blob:` are renderer-dangerous if a URI ever reaches a
 *     link or an iframe by mistake.
 *   - `https:` IS listable, but reading it is refused by design (the spec reserves
 *     that scheme for content the client fetches directly, and host-side fetching
 *     of a server-chosen URL is an SSRF primitive).
 */
const ALLOWED_URI_SCHEMES = Object.freeze([
  "file:",
  "git:",
  "https:",
  "resource:",
  "schema:",
  "issue:",
  "doc:",
  "note:",
]);

/**
 * A server-custom scheme is allowed when it looks like a scheme and is not one of
 * the host-reserved ones. RFC 3986 shape, deliberately narrow: a scheme cannot
 * contain `/`, so this cannot be tricked into matching a path.
 */
const CUSTOM_SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}:/;
const RESERVED_SCHEMES = Object.freeze([
  "ui:",
  "javascript:",
  "data:",
  "blob:",
  "vbscript:",
  "about:",
  "file-loopback:",
]);

/** Is this a URI the host will catalogue and later accept for a read? */
export function isUsableResourceUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MCP_RESOURCE_URI_MAX_CHARS) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  if (URI_EXCLUDED_CHARS_RE.test(value)) return false;
  // Invisible and reordering characters, refused because this value is an IDENTIFIER:
  // `annual-<RLO>gnp.exe` renders as `annual-exe.png`, and a zero-width space makes two
  // different resources render identically. ONE definition, shared with
  // `displaySafeLabel` — the two consumers differ in what they DO with a match (an
  // identifier is refused, prose is normalized for display), not in what they recognize.
  // The first cut enumerated ranges here and leaked 14 of 17 sampled members.
  //
  // Refusing costs a legitimate server nothing: RFC 3986 is US-ASCII, so the
  // percent-encoded form round-trips byte-for-byte AND renders inertly. It is NOT the
  // whole non-ASCII range — CJK and Hangul paths still catalogue — but it does refuse an
  // emoji carrying a variation selector, which is the accepted cost of one class.
  if (hasInvisibleOrReorderingChars(value)) return false;
  const lowered = value.toLowerCase();
  if (RESERVED_SCHEMES.some((scheme) => lowered.startsWith(scheme))) return false;
  if (ALLOWED_URI_SCHEMES.some((scheme) => lowered.startsWith(scheme))) return true;
  return CUSTOM_SCHEME_RE.test(lowered);
}

/**
 * Reading an `https:` resource is refused rather than fetched. Listed, visible,
 * explained in the UI — but the host does not become a fetcher for a URL the
 * server chose.
 */
export function isHostFetchRefusedUri(uri: string): boolean {
  return uri.toLowerCase().startsWith("https:");
}

/** Bounded display string, or undefined when the wire value is unusable. */
export function usableResourceText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || CONTROL_CHARS_RE.test(trimmed)) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}
