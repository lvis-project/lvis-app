/**
 * Directories allowed in every conversation, not just the one that granted them.
 *
 * Why this exists: `applyProjectContext` reassigns `sessionAdditionalDirectories`
 * to `[projectRoot]` on every `newConversation()` (`engine/turn/session.ts`), so a
 * directory approved with scope `"session"` is discarded the moment a new chat
 * starts — which is why a path that worked a minute ago starts prompting again.
 * Only scope `"always"`, which writes `permissions.additionalDirectories`, used to
 * survive. Anything that should always be reachable therefore cannot live in the
 * session array; it has to join the per-turn base set.
 *
 * Temp directories qualify. Agent work is routinely staged there — this project's
 * own convention is to clone into `/tmp/<task>/<repo>` so parallel agents cannot
 * collide in a shared checkout — and prompting for a scratch path the user never
 * chose is friction with no decision behind it.
 *
 * The security tradeoff, stated rather than buried: `os.tmpdir()` is per-user on
 * macOS and Windows (`/var/folders/…`, `%LOCALAPPDATA%\Temp`) and uninteresting to
 * another local account. The conventional POSIX `/tmp` is world-writable (mode
 * 1777), so allowing it means a local process can stage a file the agent then
 * touches without asking. Accepted deliberately, and bounded: these entries are
 * raw candidates that `buildAllowedScope` runs through `sanitizeAllowedDirectories`
 * with everything else, so Layer 0 sensitive paths are still excluded, filesystem
 * roots are still rejected, and every access is still audited.
 */
import { tmpdir } from "node:os";

/**
 * The conventional shared temp path on POSIX.
 *
 * Deliberately separate from {@link tmpdir}: on macOS `os.tmpdir()` resolves to
 * the per-user `$TMPDIR` (`/var/folders/…`), NOT `/tmp`; on CI it often resolves
 * to a runner-specific directory. Covering only `os.tmpdir()` would leave the
 * path people actually type still denied.
 */
const POSIX_SHARED_TMP = "/tmp";

/**
 * Raw temp-directory candidates for the per-turn allow-list.
 *
 * Returned UNSANITIZED on purpose. The consumer is
 * `getTurnAdditionalDirectories()`, whose output reaches `buildAllowedScope`
 * (`tools/pipeline/invocation-context.ts`), and that canonicalizes and
 * case-folds every entry through `sanitizeAllowedDirectories`. Sanitizing here
 * as well would produce entries normalized by the *runtime* variant, which
 * preserves OS case — a different shape from the folded one the matcher
 * compares against, and a contract `isPathAllowed` states explicitly.
 * Duplicates and non-existent paths are likewise the scope builder's job.
 */
export function baseAllowedDirectories(): readonly string[] {
  return process.platform === "win32" ? [tmpdir()] : [tmpdir(), POSIX_SHARED_TMP];
}
