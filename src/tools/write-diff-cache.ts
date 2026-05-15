/**
 * Write-file diff sidecar cache.
 *
 * When WriteFileTool content exceeds WRITE_DIFF_PREVIEW_LIMIT on either side,
 * the before/after pair is persisted to:
 *   `~/.lvis/diff-cache/<sessionId>/<toolUseId>.json`
 *
 * Namespace: Storage Namespace per Feature rule (CLAUDE.md).
 * - Dir mode: 0o700, file mode: 0o600
 * - Path resolved via `lvisHome()` (LVIS_HOME env override compat)
 *
 * Cleanup:
 *   - `clearSessionDiffCache(sessionId)` — call on session end
 *   - `purgeStaleSessionDiffDirs(maxAgeMs)` — call at boot (fire-and-forget)
 */

import { mkdir, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("write-diff-cache");

/** Max bytes per side before sidecar is written. Matches renderer's WRITE_DIFF_PREVIEW_LIMIT. */
export const WRITE_DIFF_PREVIEW_LIMIT = 4096;

/** Payload stored in the sidecar file. */
export interface WriteDiffBlob {
  before: string;
  after: string;
}

/**
 * Validate that a string is a safe session / tool-use id.
 * Accepts UUIDs, alphanumeric, hyphens, underscores — no path separators.
 */
export function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function diffCacheRoot(): string {
  return join(lvisHome(), "diff-cache");
}

function sessionDir(sessionId: string): string {
  return join(diffCacheRoot(), sessionId);
}

function sidecarPath(sessionId: string, toolUseId: string): string {
  return join(sessionDir(sessionId), `${toolUseId}.json`);
}

/**
 * Write a diff sidecar when content on either side exceeds the preview limit.
 *
 * Returns true when sidecar was written, false when below limit (no write).
 * On write failure: logs audit-level warn and returns false — the caller
 * keeps `truncated: true` state so the UI shows the truncated view.
 * "No Fallback Code" rule: failure is surfaced, not silently papered over.
 */
export async function writeDiffSidecar(
  sessionId: string,
  toolUseId: string,
  before: string,
  after: string,
  auditWarn: (msg: string) => void,
): Promise<boolean> {
  const beforeBytes = Buffer.byteLength(before, "utf8");
  const afterBytes = Buffer.byteLength(after, "utf8");
  if (beforeBytes <= WRITE_DIFF_PREVIEW_LIMIT && afterBytes <= WRITE_DIFF_PREVIEW_LIMIT) {
    return false;
  }

  if (!isSafeId(sessionId) || !isSafeId(toolUseId)) {
    auditWarn(`write-diff-cache: unsafe id rejected sessionId=${sessionId} toolUseId=${toolUseId}`);
    return false;
  }

  const dir = sessionDir(sessionId);
  const path = sidecarPath(sessionId, toolUseId);
  const blob: WriteDiffBlob = { before, after };

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(blob), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (err) {
    auditWarn(
      `write-diff-cache: sidecar write failed path=${path} err=${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Read a diff sidecar. Returns the blob or null when not found / invalid.
 *
 * On read failure: returns null — caller keeps truncated state.
 */
export async function readDiffSidecar(
  sessionId: string,
  toolUseId: string,
): Promise<WriteDiffBlob | null> {
  if (!isSafeId(sessionId) || !isSafeId(toolUseId)) {
    return null;
  }
  const path = sidecarPath(sessionId, toolUseId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).before === "string" &&
      typeof (parsed as Record<string, unknown>).after === "string"
    ) {
      return parsed as WriteDiffBlob;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete all sidecar files for a session. Fire-and-forget safe.
 */
export async function clearSessionDiffCache(sessionId: string): Promise<void> {
  if (!isSafeId(sessionId)) return;
  const dir = sessionDir(sessionId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn("write-diff-cache: clear session failed dir=%s err=%s", dir, (err as Error).message);
  }
}

/**
 * Purge session dirs older than `maxAgeMs` ms. Intended for boot-time cleanup.
 * Fire-and-forget safe — logs failures but does not throw.
 */
export async function purgeStaleSessionDiffDirs(maxAgeMs: number): Promise<{
  swept: string[];
  failed: string[];
}> {
  const root = diffCacheRoot();
  const swept: string[] = [];
  const failed: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // root may not exist yet — not an error
    return { swept, failed };
  }

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (entry) => {
      const dir = join(root, entry);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) return;
        if (s.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
          swept.push(dir);
        }
      } catch (err) {
        log.warn(
          "write-diff-cache: purge entry failed dir=%s err=%s",
          dir,
          (err as Error).message,
        );
        failed.push(dir);
      }
    }),
  );

  return { swept, failed };
}
