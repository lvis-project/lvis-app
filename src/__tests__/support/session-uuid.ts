import { createHash } from "node:crypto";

/**
 * A fixture session id that satisfies the one session-id rule.
 *
 * `isValidSessionId` takes a lowercase UUID core, so a readable literal like
 * `"tile-2-session"` is rejected at the channel boundary and the assertion past
 * it never means what it says — it passes because nothing ran. Deriving the id
 * from the readable name keeps the name in the test (an assertion still says
 * WHICH conversation it means) while giving the validator a shape it accepts,
 * and the hash makes it the same id on every run.
 *
 * It lives here, dependency-free, because its callers partially `vi.mock`
 * electron and the modules under test; a helper that pulled either would change
 * what those files load.
 */
export function sessionUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
