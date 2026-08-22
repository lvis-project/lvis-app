/**
 * The corporate root CA's common name — the one piece of that configuration
 * that is text rather than a switch, and the reason this is its own module.
 *
 * Three layers need the same answer to "is this a usable certificate name":
 * the settings patch boundary (a renderer can send anything), the profile
 * normalizer (a hand-edited file can contain anything), and the boot resolver
 * that hands the value to the per-platform certificate lookup. Three copies
 * of that rule would be three chances to disagree about it.
 */

/**
 * The CN searched for when no other name is configured. It is a placeholder,
 * not a real certificate: an organization whose CA is named anything else has
 * to say so, which is what the setting is for.
 */
export const DEFAULT_CORP_CA_COMMON_NAME = "Corporate Root CA";

/**
 * Longest common name accepted. Certificate CNs are bounded at 64 characters by
 * X.509 itself; the slack is for the occasional non-conforming corporate CA,
 * not for arbitrary text.
 */
export const MAX_CORP_CA_COMMON_NAME_LENGTH = 256;

/**
 * Accept a common name, or `null` when it is not one.
 *
 * The value reaches the platform lookup as data, never as program text — an
 * argv entry for `security` on macOS, an environment variable the PowerShell
 * script reads on Windows, and nothing external at all on Linux — so this is
 * not shell-escaping. It rejects the shapes that would make the search
 * meaningless or the log unreadable: blank after trimming, longer than a
 * certificate name can be, or carrying control characters (a newline in a log
 * line is how one field becomes two).
 */
export function normalizeCorpCaCommonName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_CORP_CA_COMMON_NAME_LENGTH) return null;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}
