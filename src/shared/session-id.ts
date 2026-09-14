import { SESSION_ID_NAMESPACE_KINDS } from "./dlp-safe-id.js";

/**
 * The one shape a session id has, everywhere it is minted, persisted or read
 * back: a lowercase UUID-shaped core, optionally namespaced as
 * `<kind>-<tag>-` where `kind` is one of {@link SESSION_ID_NAMESPACE_KINDS}
 * (built from that list, so the rule cannot drift from the minting code) and
 * `tag` is `[a-z0-9]+`. Every producer draws through `createDlpSafeUuid` /
 * `createNamespacedSessionId`, so this is a description of what exists, not a
 * looser bound around it. The shape is what makes an id safe as a filename
 * component; it also bounds the id, which is why no separate length cap is
 * needed. Earlier there were four validators (this one accepted any
 * `[A-Za-z0-9_-]+`, the A2A task store capped at 256, the rationale stores
 * checked length or control characters only) and a 257-character id passed
 * some of them.
 */
const SESSION_ID_CORE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID_REGEX = new RegExp(
  `^(?:(?:${SESSION_ID_NAMESPACE_KINDS.join("|")})-[a-z0-9]+-)?${SESSION_ID_CORE}$`,
);

/**
 * Returns true when `id` is a valid session ID safe to use as a filename component.
 * Single source of truth for session ID validation across all call sites.
 * Exported so the sub-agent resume entry point (SubAgentRunner.resume) can
 * fail-closed on an unsafe `resumeId` BEFORE calling loadSessionMetadata (which
 * throws on an invalid id) — reusing the SOT rather than re-deriving the regex.
 */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_REGEX.test(id);
}
