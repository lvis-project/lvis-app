/**
 * Sandbox — plugin entry-path resolution, data-dir provisioning, noop HostApi.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginHostApi, PluginManifest } from "../types.js";
import { createPluginStorage } from "../storage.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("sandbox");

/**
 * M1 — uiCallable safety: inverted model.
 *
 * Rather than maintain a blocklist of destructive verbs (which grows stale
 * whenever a plugin invents a new mutating verb like `_revoke`, `_truncate`,
 * `_wipe`), the renderer→plugin IPC path is gated by an ALLOWLIST of
 * read-like verbs. Anything that is not clearly a read (_get, _list,
 * _search, _read, _show, _query, _preview, _count, _status, _find,
 * _describe, _inspect) is treated as mutating and can only be exposed via
 * uiCallable when the plugin is managed AND signed.
 *
 * Legacy blocklist export retained for backwards-compat (tests may import).
 */

/**
 * Resolve a plugin's manifest `entry` path relative to the plugin root.
 *
 * Security: rejects absolute paths and any relative path that escapes the
 * plugin directory via `..` traversal.
 *
 * Exported for unit testing.
 */
export function resolvePluginEntryPath(pluginRoot: string, entry: string): string {
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
 * Noop HostApi — used when no createHostApi factory is provided.
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
    registerKeywords: () => {},
    emitEvent: () => {},
    onEvent: () => () => {},
    getInstalledPluginIds: () => [],
    onPluginsChanged: () => () => {},
    addTask: () => {},
    getSecret: () => null,
    callTool: async () => {
      throw new Error("Plugin tool invocation not available in noop context");
    },
    callLlm: async () => { throw new Error("LLM not available in noop context"); },
    logEvent: () => {},
    onShutdown: () => {},
    openAuthWindow: async () => { throw new Error("openAuthWindow not available in noop context"); },
    triggerConversation: async (spec) => ({
      accepted: false,
      reason: "loop_unavailable",
      source: typeof spec?.source === "string" ? spec.source : "",
    }),
    agentApproval: {
      respond: async () => {},
    },
  };
}

/**
 * Build the plugin context object passed to createPlugin().
 */
export function buildPluginContext(opts: {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  pluginDataDir: string;
  manifest: PluginManifest;
  configOverrides: Record<string, Record<string, unknown>>;
  hostApi: PluginHostApi;
}) {
  return {
    pluginId: opts.pluginId,
    pluginRoot: opts.pluginRoot,
    hostRoot: opts.hostRoot,
    pluginDataDir: opts.pluginDataDir,
    config: {
      ...(opts.manifest.config ?? {}),
      ...(opts.configOverrides["*"] ?? {}),
      ...(opts.configOverrides[opts.pluginId] ?? {}),
    },
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
