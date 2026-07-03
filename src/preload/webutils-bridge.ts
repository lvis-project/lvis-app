// Drop-path resolution bridge (webUtils.getPathForFile).
//
// Electron ≥32 removed `File.prototype.path`, so a dropped `File` no longer
// carries its filesystem path. The documented replacement,
// `webUtils.getPathForFile(file)`, MUST be called in a context that holds the
// real `File` instance — and a `File` cannot be structured-cloned across IPC,
// so it can never reach the main process. The preload is therefore the ONLY
// place the drop path can be resolved.
//
// TRUST BOUNDARY: the string this returns is a renderer-NAMED path — it grants
// no capability on its own. The read-scope widening decision is made entirely
// by the main-process `workspace.dropPrepare` gate (Layer-0 hard-deny +
// is-a-directory check + main-owned ack token) and the explicit user ack; this
// bridge only turns a dropped `File` into a candidate path for that gate to
// validate. Its surface is deliberately narrow: it exposes a single
// drop-resolution helper, never raw `webUtils`.
import { webUtils } from "electron";

/**
 * Resolve the filesystem paths of dropped files. `webUtils.getPathForFile`
 * returns `""` for a `File` with no OS-backed path — a non-file drag (text/URL)
 * or a synthetic/blob-backed file (electron#44600). That empty string is
 * filtered EXPLICITLY here so it can never flow downstream to
 * `workspace.dropPrepare` (where it would otherwise read as an `invalid-path`
 * rejection): the result contains only real, non-empty candidate paths in drop
 * order.
 */
export function resolveDroppedPaths(files: FileList | readonly File[]): string[] {
  const out: string[] = [];
  for (const file of Array.from(files)) {
    const resolved = webUtils.getPathForFile(file);
    // Explicit empty-string guard — an unresolved path is never forwarded.
    if (resolved) out.push(resolved);
  }
  return out;
}
