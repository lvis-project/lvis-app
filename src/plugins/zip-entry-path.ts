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
 */
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
  return path;
}
