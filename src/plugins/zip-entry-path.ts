/**
 * Defense-in-depth zip-entry path sanitizer.
 *
 * Extracted from `marketplace.ts` (§FU#267 decomposition) so that
 * both `PluginArtifactStore` and the MCP install consumer (lvis-app#259)
 * share the same path-validation rules instead of duplicating them.
 *
 * Returns:
 *   - the exact POSIX-style relative path on success
 *   - `null` for an empty archive member name
 * Throws:
 *   - on NUL bytes
 *   - on absolute, backslash, drive, empty-segment, dot, or parent syntax
 *   - on member names that alias or cannot be represented safely on Windows
 */
const WINDOWS_INVALID_SEGMENT_CHAR_RE = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME_RE =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

function assertPortableSegment(slug: string, entryName: string, segment: string): void {
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    throw new Error(`"${slug}" zip entry has a Windows-ambiguous segment: ${entryName}`);
  }
  if (WINDOWS_INVALID_SEGMENT_CHAR_RE.test(segment)) {
    throw new Error(`"${slug}" zip entry has a Windows-invalid segment: ${entryName}`);
  }
  const basename = (segment.split(".", 1)[0] ?? "").replace(/[ .]+$/u, "");
  if (WINDOWS_RESERVED_BASENAME_RE.test(basename)) {
    throw new Error(`"${slug}" zip entry uses a reserved Windows device name: ${entryName}`);
  }
}

export function sanitizeZipEntryPath(slug: string, entryName: string): string | null {
  if (!entryName) return null;
  if (/[\u0000-\u001f\u007f]/.test(entryName)) {
    throw new Error(`"${slug}" zip entry contains a control character`);
  }
  if (entryName.includes("\\")) {
    throw new Error(`"${slug}" zip entry uses a backslash path: ${entryName}`);
  }
  if (entryName.startsWith("/") || entryName.startsWith("//")) {
    throw new Error(`"${slug}" zip entry uses an absolute path: ${entryName}`);
  }
  if (/^[A-Za-z]:/.test(entryName)) {
    throw new Error(`"${slug}" zip entry uses absolute drive path: ${entryName}`);
  }
  if (entryName !== entryName.normalize("NFC")) {
    throw new Error(`"${slug}" zip entry is not Unicode NFC: ${entryName}`);
  }
  const path = entryName.endsWith("/") ? entryName.slice(0, -1) : entryName;
  const segments = path.split("/");
  if (!path || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`"${slug}" zip entry uses ambiguous or traversal syntax: ${entryName}`);
  }
  for (const segment of segments) assertPortableSegment(slug, entryName, segment);
  return path;
}

/**
 * Deterministic archive-member identity for case-insensitive filesystems.
 *
 * Unicode upper-casing catches multi-code-point aliases such as
 * `Straße`/`STRASSE`; plain lower-casing does not.
 */
export function canonicalZipEntryPathIdentity(path: string): string {
  return path.normalize("NFC").toLocaleUpperCase("en-US");
}
