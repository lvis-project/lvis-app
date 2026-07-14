import { randomUUID } from "node:crypto";
import { maskSensitiveData } from "./dlp.js";

const DLP_SAFE_UUID_MAX_ATTEMPTS = 8;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  for (let attempt = 0; attempt < DLP_SAFE_UUID_MAX_ATTEMPTS; attempt += 1) {
    const uuid = makeUuid();
    if (!UUID_V4_PATTERN.test(uuid)) continue;
    const candidate = prefix ? `${prefix}-${uuid}` : uuid;
    if (maskSensitiveData(candidate).detections.length === 0) return candidate;
  }
  throw new Error("[dlp-safe-uuid-exhausted] Could not generate a DLP-safe UUID");
}
