import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Single source of truth for the LVIS user-data root.
 *
 * Default: `~/.lvis` per architecture §5 + project CLAUDE.md storage
 * namespace convention.
 *
 * Override via `LVIS_HOME` env — used by e2e fixtures to point host state at
 * a per-test temp dir so encrypted-secret blobs from a previous dev run on
 * `~/.lvis/secrets/` do not bleed into isolated test runs. Consumers that
 * resolve LVIS sub-paths MUST go through this helper rather than calling
 * `homedir()` directly, otherwise the env override leaks past one feature.
 */
export function lvisHome(): string {
  return resolve(process.env.LVIS_HOME ?? join(homedir(), ".lvis"));
}
