/**
 * Storage layout inside a single plugin root (`~/.lvis/plugins/<id>/`).
 *
 * A plugin root mixes three kinds of content with very different trust:
 *   - INSTALLED PAYLOAD (`plugin.json`, `dist/`, assets) — covered file by file
 *     by the install receipt and re-verified before every load;
 *   - the plugin's own WRITABLE STATE (`data/`) — created by
 *     `ensurePluginDataDir`, exposed as `hostApi.storage`, outside the receipt;
 *   - HOST-allocated worker control sockets (`run/<workerId>/`) — created by
 *     `permissions/worker-spawn.ts`, never plugin-written, outside the receipt.
 *
 * The split is a security boundary, not a convention: the OS write-jail grants
 * the plugin `data/` only, so plugin code cannot rewrite the bundle the next
 * load imports into the Electron main process.
 *
 * Deliberately a dependency-free leaf so the receipt verifier, the permission
 * layer, and the tool executor can all agree on the same directory names.
 */
import { lstat, readdir, rename, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

/**
 * Directory under a plugin root holding the plugin's own writable runtime
 * state. Created by `ensurePluginDataDir` (plugins/runtime/sandbox.ts).
 */
export const PLUGIN_DATA_DIR_NAME = "data";

/**
 * Directory under a plugin root holding HOST-allocated worker control sockets
 * (`run/<workerId>/control.sock`, see permissions/worker-spawn.ts).
 */
export const PLUGIN_WORKER_RUN_DIR_NAME = "run";

/**
 * Directory under a plugin root holding sockets the PLUGIN ITSELF binds:
 * `~/.lvis/plugins/<pluginId>/sockets`.
 *
 * Distinct from {@link PLUGIN_WORKER_RUN_DIR_NAME}, which holds sockets the
 * HOST allocates and a worker binds. The two are kept apart because the
 * question "who created this socket" is the question an operator looking at a
 * stale one needs answered, and a single directory could not answer it.
 */
export const PLUGIN_OWN_SOCKET_DIR_NAME = "sockets";

/**
 * Every top-level directory under a plugin root that is RUNTIME STATE rather
 * than installed payload.
 *
 * One set, because every rule about these directories is the same rule: the
 * receipt verifier must not scan them, a payload must not ship them, and a
 * root-to-root payload copy must not duplicate them. They were previously
 * enumerated once in the receipt verifier and separately (as `data/` alone) in
 * the copy filter, and the copy filter's shorter list is exactly how a live
 * `sockets/egress.sock` reached a `cp` and failed it with `ERR_FS_CP_SOCKET`.
 *
 * What each one is, and why none of them is covered by the install receipt:
 *
 *  - `data/` — the plugin's writable state, created by `ensurePluginDataDir`
 *    (runtime/sandbox.ts) and the sole region the OS write-jail grants it. It
 *    holds index databases, migration markers and workspaces the plugin
 *    legitimately mutates while it runs, so scanning it would fail the receipt
 *    the moment the plugin does anything.
 *  - `run/` — HOST-allocated worker control sockets
 *    (`run/<workerId>/control.sock`, permissions/worker-spawn.ts). A worker
 *    that dies without cleanup leaves the socket behind; without this
 *    exclusion the next boot's payload scan hits a non-regular file and
 *    refuses to load an otherwise-intact plugin.
 *  - `sockets/` — sockets the PLUGIN ITSELF binds
 *    ({@link PLUGIN_OWN_SOCKET_DIR_NAME}). Exactly the same argument as
 *    `run/`, and it was missed originally because the two are deliberately
 *    separate directories: the host owns one and the plugin owns the other, so
 *    a rule written for one does not carry to the other on its own.
 *    local-indexer's egress broker binds `sockets/egress.sock`; a quit that
 *    left it behind made the NEXT boot refuse the plugin with "installed
 *    payload contains unsupported entry: sockets/egress.sock".
 *
 * The exclusion is TOP LEVEL only, everywhere it is applied — a nested
 * `dist/data/` is shipped payload and stays validated, copied, and refused in
 * an uploaded artifact like any other file.
 *
 * Declared HERE, in the leaf that owns the names, rather than in the receipt
 * verifier that first needed it: the copy filter below is a consumer, and a
 * set declared in the verifier would have made this leaf import its own
 * dependent.
 */
export const PLUGIN_RUNTIME_DIR_NAMES: ReadonlySet<string> = new Set([
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
]);

/**
 * Whether `name` is one of the runtime directory names, compared the way a
 * filesystem that folds case would compare it.
 *
 * Always case-insensitive, regardless of the platform running the check: this
 * decides whether an INSTALL PAYLOAD may carry a top-level entry, and a
 * payload built on Linux is installed on macOS and Windows, where `Data/` and
 * `data/` are the same directory. A payload that shipped `Data/` would land on
 * top of the plugin's live state there.
 */
export function isPluginRuntimeDirName(name: string): boolean {
  const canonical = name.normalize("NFC").toLocaleUpperCase("en-US");
  for (const runtimeDir of PLUGIN_RUNTIME_DIR_NAMES) {
    if (runtimeDir.toLocaleUpperCase("en-US") === canonical) return true;
  }
  return false;
}

/**
 * Whether this platform's filesystem treats `data/` and `Data/` as one
 * directory. macOS (APFS/HFS+ default) and Windows do; Linux does not.
 */
const PLUGIN_PATHS_ARE_CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32";

/**
 * Whether two paths name the same filesystem entry.
 *
 * WHY NOT `===`. The carry below asks the filesystem (`lstat`) whether a data
 * directory is there, and on a case-insensitive volume the filesystem answers
 * yes for `Data/`. A string-equality filter answers no for the same directory.
 * That disagreement is not cosmetic: the copy filter would COPY a `Data/` the
 * carry then refuses to reconcile, which is precisely the duplicate the two
 * exist to prevent. Both questions now go through this one comparison.
 *
 * Upper-casing rather than lower-casing for the reason
 * `canonicalZipEntryPathIdentity` gives: it folds multi-code-point aliases
 * (`Straße`/`STRASSE`) that lower-casing leaves distinct.
 *
 * @param caseInsensitive defaults to this platform's behaviour; passed
 * explicitly by tests, which must be able to exercise both filesystems from
 * whichever one they happen to run on.
 */
export function isSamePluginPath(
  left: string,
  right: string,
  caseInsensitive: boolean = PLUGIN_PATHS_ARE_CASE_INSENSITIVE,
): boolean {
  const a = resolve(left).normalize("NFC");
  const b = resolve(right).normalize("NFC");
  if (!caseInsensitive) return a === b;
  return a.toLocaleUpperCase("en-US") === b.toLocaleUpperCase("en-US");
}

/**
 * The absolute directory a plugin-owned tool may write into without escaping
 * its storage namespace: `~/.lvis/plugins/<pluginId>/data`.
 *
 * Deliberately NOT the plugin root. The root holds the plugin's own executable
 * bundle (`dist/`) and its manifest; granting write access there lets sandboxed
 * plugin code rewrite the very module the next load imports into the Electron
 * main process. Load-time receipt verification detects such a rewrite, but the
 * jail removes the primitive instead of merely detecting its use.
 */
export function resolvePluginWritableRoot(pluginId: string): string {
  return resolve(lvisHome(), "plugins", pluginId, PLUGIN_DATA_DIR_NAME);
}

/**
 * Move a plugin root's own writable state (`data/`) from one root to another.
 *
 * WHY THIS EXISTS. Install and recovery replace a plugin ROOT as a unit — the
 * live directory is renamed aside, a freshly extracted payload is promoted in
 * its place, and the obsolete root is removed — because a whole-directory
 * rename is the only atomic swap the filesystem offers. But `data/` is not
 * payload. It is the plugin's state (index databases, recorded sessions,
 * settings sidecars), and the receipt already says so by skipping it. A root
 * swap that does not take the data directory along deletes the state with the
 * root it happened to sit in, and the next load recreates an empty one, so the
 * loss is silent.
 *
 * So every promotion moves the data directory into the promoted root BEFORE
 * the transaction commits, and every step that discards a root moves the data
 * directory into the root that survives FIRST. The move is one `rename` on the
 * same volume: no bytes are copied, and at every instant the directory is
 * wholly at `fromRoot` or wholly at `toRoot`, never split between them.
 *
 * Returns whether a directory moved. `fromRoot` holding none is an ordinary
 * outcome (a plugin that never wrote state, or a root whose state already
 * moved on). `toRoot` already holding one is a CONFLICT, and what to do about
 * it is the caller's to say — see {@link PluginDataCarryPolicy}.
 */
export async function carryPluginDataDir(
  fromRoot: string,
  toRoot: string,
  policy: PluginDataCarryPolicy,
): Promise<boolean> {
  const source = resolve(fromRoot, PLUGIN_DATA_DIR_NAME);
  const target = resolve(toRoot, PLUGIN_DATA_DIR_NAME);
  if (!await pathExists(source)) return false;
  if (await pathExists(target)) {
    if (policy.onConflict === "reject") {
      throw new Error(
        `[plugin-storage-layout] both roots hold a plugin data directory; refusing to `
          + `replace ${target} with ${source}`,
      );
    }
    if (!await clearCarryDestination(source, target, fromRoot, toRoot, policy)) return false;
  }
  await rename(source, target);
  return true;
}

/**
 * What {@link carryPluginDataDir} does when the destination root already holds
 * a data directory. There is no default: the two callers need opposite
 * answers, and the wrong one is silent in both directions.
 *
 * `reject` — an INSTALL transaction. It built the destination root itself from
 * a verified payload moments earlier, so a data directory there is a statement
 * that the transaction's own bookkeeping is wrong. It has a rollback path and
 * must take it rather than merge two candidates for one state.
 *
 * `resolve` — RECOVERY. It is handed whatever the crash left behind and has no
 * rollback: refusing leaves `pendingUpdate` set forever, so the plugin never
 * loads again and no later boot can clear it. Recovery must always reach a
 * terminal disposition, so a conflict is decided here, by rules that never
 * delete state:
 *
 *  1. an EMPTY directory holds no state and is removed. That is the conflict
 *     seen in practice — an interrupted carry, or a storage call landing in
 *     the swap window — and either side of the carry can be the empty one. If
 *     the DESTINATION is empty it goes and the carry proceeds; if the SOURCE is
 *     empty instead, the destination's real state stays where it already is;
 *  2. two non-empty directories are not equal candidates, and which one is the
 *     stray is structural rather than a guess. Only the LIVE plugin path
 *     (`unattributedRoot`) is somewhere a stray write can land — a recovery
 *     backup path is never a storage target, and it holds state a transaction
 *     deliberately put there. So the directory under `unattributedRoot` is the
 *     one handed to `moveAside`, and the other one wins: when the loser is the
 *     destination the carry proceeds over it, and when the loser is the SOURCE
 *     the destination keeps the state it already holds and nothing is carried.
 *
 * `moveAside` must KEEP what it is handed. Recovery parks it in the
 * unattributed-state namespace, which nothing sweeps — the point of the call is
 * that a human decides, so a destination that deletes (the uninstall tombstone
 * lifecycle, say) would make rule 2 a lie.
 */
export type PluginDataCarryPolicy =
  | { onConflict: "reject" }
  | {
      onConflict: "resolve";
      /**
       * The plugin root whose `data/` is NOT authoritative when both roots hold
       * state: the live install path, the only one a stray write can reach.
       */
      unattributedRoot: string;
      /** Take custody of the losing `data/`, KEEP it, and leave its path free. */
      moveAside: (conflictingDataDir: string) => Promise<void>;
    };

/** @returns whether the destination is now free for the carry to proceed. */
async function clearCarryDestination(
  source: string,
  target: string,
  fromRoot: string,
  toRoot: string,
  policy: Extract<PluginDataCarryPolicy, { onConflict: "resolve" }>,
): Promise<boolean> {
  if (await isEmptyDirectory(target)) {
    await rmdir(target);
    return true;
  }
  if (await isEmptyDirectory(source)) {
    await rmdir(source);
    return false;
  }
  const sourceIsUnattributed = isSamePluginPath(fromRoot, policy.unattributedRoot);
  const targetIsUnattributed = isSamePluginPath(toRoot, policy.unattributedRoot);
  if (sourceIsUnattributed === targetIsUnattributed) {
    // Neither side is the live path, or both claim to be. Recovery always
    // carries to or from the live install directory, so this is a caller that
    // named the wrong root — a bug to fix, not a state to guess at.
    throw new Error(
      `[plugin-storage-layout] cannot attribute a data directory conflict between `
        + `${source} and ${target}: neither is under ${policy.unattributedRoot}`,
    );
  }
  const loser = sourceIsUnattributed ? source : target;
  await policy.moveAside(loser);
  if (await pathExists(loser)) {
    throw new Error(
      `[plugin-storage-layout] conflicting plugin data directory was not moved aside: ${loser}`,
    );
  }
  return !sourceIsUnattributed;
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    // ENOTDIR: something that is not a directory occupies the name. It is not
    // empty, it is not the plugin's state, and it goes to `moveAside` with
    // everything else that needs looking at rather than deleting.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * `cp` filter that copies a plugin root's payload and leaves its RUNTIME
 * directories behind ({@link PLUGIN_RUNTIME_DIR_NAMES}).
 *
 * `data/` is excluded because state is carried by {@link carryPluginDataDir} —
 * one rename, never a copy — so a root copy that included it would create the
 * second candidate the carry has to reconcile. `run/` and `sockets/` are
 * excluded because they hold live Unix-domain sockets, and `cp` over a socket
 * does not skip it: it fails the whole copy with `ERR_FS_CP_SOCKET`, which
 * takes the enclosing install or recovery down with it. local-indexer's egress
 * broker keeps `sockets/egress.sock` bound for as long as the plugin runs.
 */
export function pluginPayloadCopyFilter(root: string): (source: string) => boolean {
  const runtimeDirs = [...PLUGIN_RUNTIME_DIR_NAMES].map((name) => resolve(root, name));
  return (source) => !runtimeDirs.some((dir) => isSamePluginPath(source, dir));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Where a confined plugin child may bind a Unix-domain socket.
 *
 * WHY A PLUGIN NEEDS ONE AT ALL. A plugin that has to be reached by a process
 * it spawned — `local-indexer`'s egress broker is the case that forced this —
 * used to bind loopback TCP. That is ambient axis 1 in the routing SOT, and it
 * is the half of axis 1 the census long missed: not egress, INBOUND BIND. On
 * macOS the confined bind is refused outright, and on Linux the child's network
 * namespace makes loopback unreachable from outside it. A Unix socket has
 * neither problem, because it is a filesystem object.
 *
 * WHY THE HOST OWNS THE DIRECTORY. The Unix-socket ALLOW is a SHARED ASRT
 * config entry scoped to a DIRECTORY on macOS (`(subpath <dir>)`), and the
 * seatbelt profile is generated when the child is wrapped — so the directory
 * has to be known and registered BEFORE the spawn, which is a thing only the
 * host can do. See the WORKER UDS header in `permissions/asrt-sandbox.ts`.
 */
export function resolvePluginSocketDir(pluginDataDir: string): string {
  // Derived FROM the data directory rather than rebuilt from `lvisHome()` and
  // the plugin id. The two coincide in production and diverge under a test that
  // relocates the plugins root, and a socket directory that disagreed with the
  // data directory it is supposed to sit beside would be granted in one place
  // and created in another — a silent inequality, not a crash.
  return resolve(dirname(pluginDataDir), PLUGIN_OWN_SOCKET_DIR_NAME);
}

/**
 * Where the HOST binds control sockets for workers this plugin asked for:
 * `~/.lvis/plugins/<pluginId>/run`.
 *
 * WHY THE CHILD NEEDS IT. `permissions/worker-spawn.ts` allocates
 * `run/<workerId>/control.sock`, registers that directory so the WORKER may
 * bind, and its header records the assumption that made the other half
 * unnecessary: "the host connects from OUTSIDE the sandbox (unconstrained)."
 * That stopped being true when every plugin moved out of process. The client is
 * now the plugin's own confined child, and a child whose profile does not name
 * this directory binds nothing and connects nowhere — `connect EPERM` on a
 * socket that exists and that an unconfined process reaches without trouble.
 *
 * The whole subtree rather than one worker's leaf, and registered for every
 * child rather than the ones known to spawn workers, for the reason
 * {@link resolvePluginSocketDir} carries: the directory is inside the plugin's
 * own namespace and grants no reach beyond it, and the alternative is a list
 * someone has to remember to update.
 */
export function resolvePluginWorkerRunRoot(pluginDataDir: string): string {
  // Derived FROM the data directory for the reason resolvePluginSocketDir is:
  // the two must not be able to disagree about which plugin root they mean.
  return resolve(dirname(pluginDataDir), PLUGIN_WORKER_RUN_DIR_NAME);
}

/**
 * The most bytes a Unix-domain socket PATH can have on this platform.
 *
 * `sockaddr_un.sun_path` is a fixed char array — 104 on macOS/BSD, 108 on
 * Linux — and one of those bytes is the terminating NUL. A path over the limit
 * does not fail as "too long": `bind()` returns `EINVAL`, which reads as a
 * malformed address and sends the reader looking at the wrong thing entirely.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = (process.platform === "darwin" ? 104 : 108) - 1;

/**
 * Refuse a socket path the kernel cannot hold, and say why.
 *
 * Called BEFORE anything binds, on the host side, because the failure this
 * prevents is opaque at every later point: the child reports `EINVAL`, the
 * host sees a worker that never came up, and nothing in either message
 * mentions a length. The check is cheap and the diagnosis it replaces is not.
 *
 * The limit is reached in practice rather than in theory — a long account name
 * plus a long plugin id plus a per-worker subdirectory is most of 104 bytes
 * before the socket's own name.
 *
 * @param socketPath the full path something is about to bind.
 * @param what a short noun for the caller, used in the message.
 */
export function assertUnixSocketPathFits(socketPath: string, what: string): void {
  const bytes = Buffer.byteLength(socketPath, "utf-8");
  if (bytes <= MAX_UNIX_SOCKET_PATH_BYTES) return;
  throw new Error(
    `[plugin-storage-layout] ${what}: socket path is ${String(bytes)} bytes, over this `
      + `platform's ${String(MAX_UNIX_SOCKET_PATH_BYTES)}-byte limit — bind() would fail `
      + `with EINVAL and name no cause. Path: ${socketPath}`,
  );
}
