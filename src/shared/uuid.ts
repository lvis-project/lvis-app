/**
 * The UUID shape, and nothing else — no minter, no Node import.
 *
 * Renderer-bundled modules (`tailnet-sharing`, `telegram-connection`) validate
 * UUIDs too, and `dlp-safe-id.ts`, which mints them, is main-process only
 * because it pulls `randomUUID` from `node:crypto`. The check therefore lives
 * here, where every process can reach it, and the minter imports it.
 */

/**
 * An RFC 9562 UUID without anchors, for composing into larger patterns
 * (a backup-directory name, a staged image file name).
 */
export const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/**
 * The one UUID check: RFC 9562, version nibble 1–8, variant 10xx, either
 * case. `randomUUID()` mints v4, but ids that arrive from a peer, a store or
 * a file name may legitimately be another version; the earlier per-file
 * copies disagreed (`[1-5]` in nine files, `[1-8]` in seven, `4` in one) and
 * so did what they accepted.
 */
export const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
