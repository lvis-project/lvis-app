/**
 * Bounds and validation for MCP server resources — shared by all three layers.
 *
 * Same reason `mcp-prompt-bounds.ts` exists: these numbers are a CONTRACT between
 * the client discovery boundary (main), the read path (main), and whatever UI
 * eventually offers a resource to the user. A field the UI shows that main then
 * drops is worse than no field, so they cannot be re-declared per layer.
 *
 * See `docs/development/mcp-resources-policy.md` for why each bound is what it is.
 * Pure: no imports, so it stays importable from every process.
 */

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
 * How many resource fences a turn's material carries, across the input text AND
 * every text part.
 *
 * Counts OCCURRENCES, not parts. The first cut of this test asked whether a part
 * *starts with* the fence, which made the bound a property of the renderer's
 * packaging instead of the turn's content: a composer that joined twelve
 * attachments into one text part — the natural way to put a fence beside the
 * user's own words — counted as one, and ~384 KB of server-authored text entered a
 * turn whose bound was meant to be 8 reads. Counting the tag makes the answer the
 * same however the material is packaged.
 *
 * `input` is included because the fenced blocks END UP there: `continue-last-user`
 * joins a turn's text parts into the prompt body, so any check that only sees
 * attachments stops applying after one replay. Same lesson as the turn's staged
 * origin, which is likewise derived from the text at the turn-entry chokepoint
 * rather than trusted from the send payload.
 *
 * Deliberately blind to authorship: a user who pastes the tag into their own
 * message spends budget for it. The host cannot tell its own fence from a forged
 * one once both are text in the same field, and the fence is a trust DEMOTION
 * marker — so the conservative reading (count it) costs a forger nothing and
 * protects the window either way.
 */
export function countResourceAttachmentFences(
  input: string,
  parts?: ReadonlyArray<{ type?: unknown; text?: unknown }>,
): number {
  let count = occurrences(input);
  for (const part of parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string") count += occurrences(part.text);
  }
  return count;
}

function occurrences(text: string): number {
  return text.split(MCP_RESOURCE_FENCE_OPEN).length - 1;
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
