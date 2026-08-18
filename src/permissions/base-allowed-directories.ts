/**
 * Directories allowed in every conversation, not just the one that granted them.
 *
 * Why this exists: `applyProjectContext` reassigns `sessionAdditionalDirectories`
 * to `[projectRoot]` on every `newConversation()` (`engine/turn/session.ts`), so a
 * directory approved with scope `"session"` is discarded the moment a new chat
 * starts — which is why a path that worked a minute ago starts prompting again.
 * Only scope `"always"`, which writes `permissions.additionalDirectories`, used to
 * survive. Anything that should always be reachable therefore cannot live in the
 * session array; it has to be part of the base set assembled per turn.
 *
 * Temp directories qualify. Agent work is routinely staged there — this project's
 * own convention is to clone into `/tmp/<task>/<repo>` so parallel agents cannot
 * collide in a shared checkout — and prompting for a scratch path the user never
 * chose is friction with no decision behind it.
 *
 * The security tradeoff, stated plainly rather than buried: `os.tmpdir()` is
 * per-user on macOS and Windows (`/var/folders/…`, `%LOCALAPPDATA%\\Temp`) and is
 * uninteresting to another local account. The conventional POSIX `/tmp` is
 * world-writable (mode 1777), so allowing it means any local process can stage a
 * file the agent then reads or writes without asking. That is accepted here
 * deliberately: it is the directory this project's own workflow uses, the threat
 * requires an already-local attacker, and — importantly — these entries go
 * through the same sanitizer as every other allow-list, so Layer 0 sensitive
 * paths are still excluded and every access is still audited.
 */
import { tmpdir } from "node:os";

import { sanitizeRuntimeAllowedDirectories } from "./allowed-directories.js";

/**
 * The conventional shared temp path on POSIX.
 *
 * Deliberately separate from {@link tmpdir}: on macOS `os.tmpdir()` resolves to
 * the per-user `$TMPDIR` (`/var/folders/…`), NOT to `/tmp`, so relying on it
 * alone would leave the path people actually type still denied. `/tmp` is also a
 * symlink to `/private/tmp` there — harmless because the sanitizer canonicalizes
 * through `realpath`, the same way candidate paths are canonicalized before the
 * prefix compare, so both spellings match the one stored entry.
 */
const POSIX_SHARED_TMP = "/tmp";

/**
 * Directories granted in every conversation, ahead of project and session grants.
 *
 * Runs through {@link sanitizeRuntimeAllowedDirectories} rather than resolving
 * paths here, so these entries get exactly the treatment a user-configured
 * allow-list gets: canonicalization, de-duplication, filesystem-root rejection,
 * and Layer 0 sensitive-path exclusion. A base entry is not a reason to skip
 * those checks.
 */
export function baseAllowedDirectories(): readonly string[] {
  const candidates = [tmpdir()];
  if (process.platform !== "win32") {
    candidates.push(POSIX_SHARED_TMP);
  }
  return sanitizeRuntimeAllowedDirectories(candidates);
}
