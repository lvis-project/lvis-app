/**
 * Main-process only — the minters below pull `node:crypto` for `randomUUID`,
 * which the renderer and preload bundles do not have. Neither of those
 * processes should import this module.
 *
 * `isSafeStructuralId`'s control-character class (C0/DEL plus C1
 * U+0080–U+009F and the line separators U+2028/2029) is what actually
 * narrowed for two existing call paths: `src/api/a2a-remote-client.ts`
 * (~line 796, the remote task projection) and
 * `src/api/a2a-exact-replay-store.ts` (~line 115, the replay task-shape
 * check), both by way of `canonicalizeA2ARemoteTask` in
 * `src/api/a2a-task-store.ts`. A remote task id carrying one of those
 * characters now fails canonicalization instead of being accepted.
 */
import { randomUUID } from "node:crypto";
import { hasControlChars } from "./display-safe-text.js";
import { maskSensitiveData } from "./dlp.js";
import { UUID_PATTERN } from "./uuid.js";

const DLP_SAFE_UUID_MAX_ATTEMPTS = 8;
const STRUCTURAL_ID_MAX_LENGTH = 256;

/**
 * Is `value` fit to be a structural identifier — an A2A context, task or
 * artifact id, or the parent/child session ids a subagent address names?
 *
 * The read-side twin of the minters below: they draw ids that clear the DLP
 * scanner, and this is the check every id that arrives from outside (the A2A
 * wire, a persisted task record, a subagent message address) has to pass
 * before it is used as a key. Three modules validate the same ids off the same
 * wire and store, so they must reject the same strings — which is why the
 * predicate lives here rather than beside any one of them.
 *
 * Structural ids are opaque tokens, never prose: the rule is a length bound,
 * no control characters, and nothing the DLP scanner would mask (a masked id
 * stops resolving to its row on the next read). "Control characters" is the
 * display-safe class — C0 and DEL, and also C1 (U+0080–U+009F) and the Unicode
 * line separators (U+2028/2029) — because an id that would render as a line
 * break in a log or a transcript is no more an id than one carrying a NUL.
 */
export function isSafeStructuralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= STRUCTURAL_ID_MAX_LENGTH
    && !hasControlChars(value)
    && maskSensitiveData(value).detections.length === 0;
}

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
