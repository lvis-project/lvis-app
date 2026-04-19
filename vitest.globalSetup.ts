import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup — creates ~/.lvis/test-tmp/ before any tests run.
 *
 * Tests use ~/.lvis/test-tmp/ as the base directory for mkdtempSync() to
 * avoid Windows 8.3 short-path (RUNNER~1) issues with os.tmpdir().
 * mkdtempSync() requires the parent directory to already exist.
 */
export async function setup(): Promise<void> {
  mkdirSync(join(homedir(), ".lvis", "test-tmp"), { recursive: true });
}
