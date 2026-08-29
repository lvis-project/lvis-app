import { randomUUID } from "node:crypto";
import { maskSensitiveData } from "./dlp.js";

const DLP_SAFE_UUID_MAX_ATTEMPTS = 8;
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

/**
 * Draw candidate identifiers until one survives the DLP scanner, or give up.
 *
 * Every persisted identifier in the app has to clear the same bar — an id that
 * happens to match a redaction pattern comes back masked on the next read and
 * stops resolving to its row — but the two minters that need it draw their
 * candidates completely differently (one random, one hashed and deterministic).
 * The loop, the attempt ceiling and the scan are the shared part; the draw is
 * not, which is why `makeCandidate` is the parameter.
 *
 * `makeCandidate` receives the attempt number so a deterministic generator can
 * vary its input, and may return `null` to reject a draw outright (a malformed
 * uuid, a name already taken) without spending the scan.
 *
 * Returns `null` on exhaustion rather than throwing, because the two callers
 * fail with different messages and a caller-owned error is more useful at the
 * point it surfaces than a shared one.
 */
export function dlpSafeCandidate(
  makeCandidate: (attempt: number) => string | null,
  maxAttempts: number,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = makeCandidate(attempt);
    if (candidate === null) continue;
    if (maskSensitiveData(candidate).detections.length === 0) return candidate;
  }
  return null;
}

/**
 * Create a UUID-shaped internal identifier whose complete serialized form is
 * accepted by the DLP scanner. The prefix is included in the scan so digit
 * groups cannot become sensitive-looking only after concatenation.
 */
export function createDlpSafeUuid(
  prefix = "",
  makeUuid: () => string = randomUUID,
): string {
  if (maskSensitiveData(prefix).detections.length > 0) {
    throw new Error("[dlp-safe-uuid-prefix-rejected] DLP rejected the identifier prefix");
  }
  const candidate = dlpSafeCandidate(() => {
    const uuid = makeUuid();
    if (!UUID_PATTERN.test(uuid)) return null;
    return prefix ? `${prefix}-${uuid}` : uuid;
  }, DLP_SAFE_UUID_MAX_ATTEMPTS);
  if (candidate === null) {
    throw new Error("[dlp-safe-uuid-exhausted] Could not generate a DLP-safe UUID");
  }
  return candidate;
}
