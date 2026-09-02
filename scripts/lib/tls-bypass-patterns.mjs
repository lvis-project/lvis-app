/**
 * The one definition of "TLS-verification bypass" that both scans read.
 *
 * Two scans look for the same thing at two moments: the pre-push hook over
 * STAGED SOURCE (`scripts/hooks/run-local-checks.mjs`) and the build over the
 * BYTES IN `dist/` (`scripts/check-no-tls-bypass.mjs`). Each used to carry its
 * own list, and the lists had drifted: a `rejectUnauthorized` switched off was
 * caught only before a push, the Chromium certificate-error flag only after a
 * build. A bypass that reached the tree through a path one scan did not cover
 * was then invisible to the other. This module is the union; a pattern added
 * here is caught at both moments.
 *
 * Each regex is spelled so that its own source text does not match it — the
 * staged-file scan reads this file too, and would otherwise report the
 * definition of the gate as a violation of it. `labelFor` keeps the reported
 * name out of the file for the same reason.
 */

const TLS_BYPASS_REGEXES = Object.freeze([
  /NODE_TLS_REJECT_[U]NAUTHORIZED/,
  /ignore-certificate-error[s]/,
  /PYTHON[H]TTPSVERIFY/,
  /rejectUnauthorized\s*:\s*false/,
  /strictSSL\s*:\s*false/,
  /verify\s*=\s*False/,
  /ssl\._create_unverified_contex[t]/,
]);

/**
 * The reported name is derived from the regex at runtime — bracket classes
 * and whitespace escapes dropped — so the literal needle never appears in
 * this file, not even as a label.
 */
function labelFor(regex) {
  return regex.source.replace(/\[(.)\]/g, "$1").replace(/\\s\*/g, "").replace(/\\/g, "");
}

/** @type {ReadonlyArray<{ label: string; regex: RegExp }>} */
const TLS_BYPASS_PATTERNS = Object.freeze(
  TLS_BYPASS_REGEXES.map((regex) => Object.freeze({ label: labelFor(regex), regex })),
);

/**
 * File extensions both scans read. Documents are left alone on purpose: a
 * closure report that records a bypass once shipped is history, not a bypass.
 */
export const TLS_BYPASS_SCAN_EXTENSIONS = Object.freeze([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sh", ".ps1", ".cmd",
  ".yml", ".yaml", ".json", ".toml",
]);

/** Labels of every pattern that matches `content`, in definition order. */
export function findTlsBypass(content) {
  return TLS_BYPASS_PATTERNS.filter(({ regex }) => regex.test(content)).map(
    ({ label }) => label,
  );
}

export function isTlsBypassScanTarget(fileName) {
  return TLS_BYPASS_SCAN_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}
