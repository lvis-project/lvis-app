/**
 * Sandbox — plugin entry-path resolution, data-dir provisioning, noop HostApi.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginHostApi, PluginManifest } from "../types.js";
import { createPluginStorage } from "../storage.js";
import { applyConfigDefaults } from "../config-schema.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("sandbox");

/**
 * App-visible tool safety model.
 *
 * The app-visible tool allowlist is a structural renderer allowlist, not a risk
 * classifier: mutating-looking names are accepted at manifest load, but renderer
 * calls are re-checked against the owning manifest at runtime. App-only actions
 * other than auth status polling require a fresh browser user activation before
 * the host invokes the handler, and model-visible tools still use the normal
 * executor permission/audit path.
 */

/**
 * Resolve a plugin's manifest `entry` path relative to the plugin root.
 *
 * Security: rejects absolute paths and any relative path that escapes the
 * plugin directory via `..` traversal.
 *
 * Exported for unit testing.
 */
export function resolvePluginEntryPath(pluginRoot: string, entry: string,
): string {
  if (isAbsolute(entry)) {
    throw new Error(
      `Plugin entry must be a relative path inside the plugin directory, got absolute: ${entry}`,
    );
  }
  const pluginRootResolved = resolve(pluginRoot);
  const resolved = resolve(pluginRootResolved, entry);
  if (resolved !== pluginRootResolved) {
    const rel = relative(pluginRootResolved, resolved);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Plugin entry '${entry}' resolves outside plugin directory (${pluginRootResolved})`,
      );
    }
  }
  return resolved;
}

/**
 * Resolve a plugin entry path.
 *
 * Always strict containment — every plugin install (admin / user /
 * local-dev) lives physically inside `pluginRoot`. The pre-2026-05
 * `LVIS_DEV=1` sibling-repo escape (used by the now-removed `dev:link`
 * script) is gone. `hostRoot` is retained as a parameter for API
 * symmetry with the caller in `runtime/index.ts` but is no longer used.
 */
export function resolveEntryPath(
  pluginRoot: string,
  entry: string,
  _hostRoot: string,
): string {
  return resolvePluginEntryPath(pluginRoot, entry);
}

/**
 * Resolve symlinks / 8.3 short-names before constructing a file:// URL.
 * Falls back to the original path if realpathSync throws.
 */
export function resolveRealEntryPath(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

/**
 * Build a file:// import URL from an entry path.
 */
export function buildImportUrl(entryPath: string, bustCache = false): string {
  const url = pathToFileURL(entryPath).href;
  return bustCache ? `${url}?reload=${Date.now()}` : url;
}

/**
 * Compute and ensure the plugin's writable data directory at
 * `<pluginsRoot>/<pluginId>/data/`. Falls back to `<pluginRoot>/data` when
 * `pluginsRoot` is not configured (test harnesses, isolated installs).
 */
export function ensurePluginDataDir(
  pluginId: string,
  pluginRoot: string,
  pluginsRoot: string | undefined,
): string {
  const baseRoot = pluginsRoot ?? dirname(pluginRoot);
  const dataDir = resolve(baseRoot, pluginId, "data");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/**
 * Noop HostApi — test harnesses must inject this explicitly.
 * `storage` is real so plugins can read/write their own data even in
 * test/noop contexts.
 */
export function createNoopHostApi(
  pluginId: string,
  pluginDataDir: string,
): PluginHostApi {
  return {
    storage: createPluginStorage(pluginId, pluginDataDir),
    config: {
      get: () => undefined,
      set: async () => {
        throw new Error("config.set not available in noop context");
      },
      onChange: () => () => {},
    },
    emitEvent: () => {},
    onEvent: () => () => {},
    getInstalledPluginIds: () => [],
    onPluginsChanged: () => () => {},
    getSecret: () => null,
    callLlm: async () => {
      throw new Error("LLM not available in noop context");
    },
    logEvent: () => {},
    onShutdown: () => {},
    openExternalUrl: async () => {
      throw new Error("openExternalUrl not available in noop context");
    },
    // Fail-safe to false (no corp network) — a probe should never throw the
    // caller's flow; matches hasRoutineBySource's graceful noop default.
    probePrivateHost: async () => false,
    openAuthWindow: async () => {
      throw new Error("openAuthWindow not available in noop context");
    },
    openAuthPartitionViewer: async () => {
      throw new Error("openAuthPartitionViewer not available in noop context");
    },
    clearAuthPartition: async () => {
      throw new Error("clearAuthPartition not available in noop context");
    },
    triggerConversation: async (spec) => ({
      accepted: false,
      reason: "loop_unavailable",
      source: typeof spec?.source === "string" ? spec.source : "",
    }),
    // No routines SOT in a noop context — no routine can match any source.
    hasRoutineBySource: async () => false,
    agentApproval: {
      request: async () => "deny-once" as const,
      respond: async () => {},
    },
  };
}

/** Explicit factory adapter for isolated runtime test harnesses. */
export function createNoopHostApiForTests(
  pluginId: string,
  _manifest: PluginManifest,
  pluginDataDir: string,
): PluginHostApi {
  return createNoopHostApi(pluginId, pluginDataDir);
}

/**
 * Build the plugin context object passed to createPlugin().
 */
export function buildPluginContext(opts: {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  pluginDataDir: string;
  // #885 v6 — reads only `config`/`configSchema` (shared by legacy + normalized).
  manifest: Pick<PluginManifest, "config" | "configSchema">;
  configOverrides: Record<string, Record<string, unknown>>;
  hostApi: PluginHostApi;
}) {
  return {
    pluginId: opts.pluginId,
    pluginRoot: opts.pluginRoot,
    hostRoot: opts.hostRoot,
    pluginDataDir: opts.pluginDataDir,
    // configSchema defaults backfill keys missing from `manifest.config`
    // and the override layers — without this, plugins that document a
    // `default` for a config key would
    // see `undefined` whenever the user hasn't explicitly set the key,
    // forcing every plugin to reimplement default-handling. Override
    // precedence is preserved: plugin-specific > wildcard > manifest.config
    // > schema defaults.
    config: applyConfigDefaults(opts.manifest.configSchema, {
      ...(opts.manifest.config ?? {}),
      ...(opts.configOverrides["*"] ?? {}),
      ...(opts.configOverrides[opts.pluginId] ?? {}),
    }),
    log: (message: string, meta?: unknown) => {
      if (meta !== undefined) {
        log.info({ pluginId: opts.pluginId, meta }, message);
        return;
      }
      log.info({ pluginId: opts.pluginId }, message);
    },
    hostApi: opts.hostApi,
  };
}
