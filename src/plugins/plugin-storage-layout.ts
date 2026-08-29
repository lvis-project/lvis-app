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
import { lstat, rename } from "node:fs/promises";
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
 * moved on). `toRoot` already holding one is NOT: two candidates for the same
 * state cannot be merged here, and silently keeping either would hide exactly
 * the duplication this helper exists to rule out — the caller's transaction is
 * wrong, and the error says so rather than picking a side.
 */
export async function carryPluginDataDir(fromRoot: string, toRoot: string): Promise<boolean> {
  const source = resolve(fromRoot, PLUGIN_DATA_DIR_NAME);
  const target = resolve(toRoot, PLUGIN_DATA_DIR_NAME);
  if (!await pathExists(source)) return false;
  if (await pathExists(target)) {
    throw new Error(
      `[plugin-storage-layout] both roots hold a plugin data directory; refusing to `
        + `replace ${target} with ${source}`,
    );
  }
  await rename(source, target);
  return true;
}

/**
 * `cp` filter that copies a plugin root's payload and leaves its `data/`
 * behind. Runtime state is carried by {@link carryPluginDataDir} — one rename,
 * never a copy — so a root copy that included it would create the second
 * candidate the carry refuses to reconcile.
 */
export function pluginPayloadCopyFilter(root: string): (source: string) => boolean {
  const dataDir = resolve(root, PLUGIN_DATA_DIR_NAME);
  return (source) => resolve(source) !== dataDir;
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
