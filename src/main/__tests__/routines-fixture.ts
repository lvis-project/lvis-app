/**
 * Shared fixture for the routine suites — a `RoutinesStore` on a scratch
 * directory plus the "an instant in the near future" ISO stamp every schedule
 * test needs.
 *
 * A leaf on purpose: three suites in two domains (`main/` store + scheduler,
 * `tools/` routine_schedule) each carried the same `tempStore` and the same
 * `futureIso`, and `check:test-duplicates` is meant to keep that from
 * recurring. Nothing here mocks a subject, so any routine suite can import it
 * without coupling to another suite's setup.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutinesStore } from "../routines-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

/** A store backed by `<scratch>/routines.json`; `cleanup` removes the scratch dir. */
export function tempRoutinesStore(): {
  store: RoutinesStore;
  dir: string;
  cleanup: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "lvis-routines-"));
  const store = new RoutinesStore(join(dir, "routines.json"));
  const cleanup = () => cleanupTmpDir(dir);
  return { store, dir, cleanup };
}

/** ISO stamp `offsetMs` from now. */
function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** A schedule that is due later, never already past. */
export function futureIso(offsetMs = 60_000): string {
  return isoFromNow(offsetMs);
}

/** A schedule that is already due. */
export function pastIso(offsetMs = -1000): string {
  return isoFromNow(offsetMs);
}
