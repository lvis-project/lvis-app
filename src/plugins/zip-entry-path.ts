/**
 * Defense-in-depth zip-entry path sanitizer.
 *
 * Extracted from `marketplace.ts` (§FU#267 decomposition) so that
 * both `PluginArtifactStore` and the MCP install consumer (lvis-app#259)
 * share the same path-validation rules instead of duplicating them.
 *
 * Returns:
 *   - the normalized POSIX-style relative path on success
 *   - `null` for empty / "." entries (skip without throwing)
 * Throws:
 *   - on NUL bytes
 *   - on Windows drive-absolute prefixes (`C:`, `Z:`, ...)
 *   - on `..` traversal that survives POSIX normalization
 */
import { posix } from "node:path";

export function sanitizeZipEntryPath(slug: string, entryName: string): string | null {
  const normalized = entryName.split("\\").join("/").replace(/^\/+/, "");
  if (!normalized || normalized === ".") return null;
  if (normalized.includes("\u0000")) {
    throw new Error(`"${slug}" zip entry contains NUL byte`);
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new Error(`"${slug}" zip entry uses absolute drive path: ${entryName}`);
  }
  const collapsed = posix.normalize(normalized);
  if (!collapsed || collapsed === ".") return null;
  if (collapsed === ".." || collapsed.startsWith("../")) {
    throw new Error(`"${slug}" zip entry escapes install root: ${entryName}`);
  }
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}
