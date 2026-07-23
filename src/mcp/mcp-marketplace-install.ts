/**
 * MCP marketplace install — consumer of lvis-marketplace#52 + #267.
 *
 * Uses the shared `PluginArtifactStore` to download + verify + extract
 * the signed MCP server zip into a managed directory, then materializes
 * the manifest's `runtime` block into the McpServerConfig shape that
 * `McpManager.addConfig()` accepts.
 *
 * Trust model:
 *   - signature envelope verification happens inside the store (same
 *     ed25519 path that protects regular plugin installs)
 *   - the catalog row's `mcpRuntime` is advisory only; the install path
 *     re-reads the runtime block from the verified manifest in the zip
 *   - secrets are NEVER carried in catalog or manifest. When
 *     `runtime.auth !== "none"` the renderer prompts the user via the
 *     existing api-key / SSO / OAuth flows after the server entry is registered.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertSafeArtifactSlug,
  type PluginArtifactStore,
} from "../plugins/plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../plugins/marketplace-fetcher.js";
import { parseMcpRuntimeSpec } from "../plugins/mcp-runtime-spec.js";
import type { McpRuntimeSpec } from "../plugins/types.js";
import type { McpServerConfig } from "./types.js";
import type { InstallerProgressEvent } from "../plugins/marketplace-installer.js";
import { MAX_MCP_MANIFEST_BYTES } from "./safe-names.js";

export interface InstallMcpResult {
  config: McpServerConfig;
  /** Where the artifact was extracted — useful for uninstall cleanup. */
  installDir: string;
  /** True if `runtime.auth !== "none"` — caller prompts for credentials. */
  needsCredential: boolean;
  authMode: "none" | "api-key" | "sso" | "oauth";
  connected: boolean;
  warning?: string;
}

export interface InstallMcpOptions {
  fetcher: MarketplaceFetcher;
  /** Pre-constructed store rooted at `~/.lvis/mcp/`. */
  store: PluginArtifactStore;
  onProgress?: (event: InstallerProgressEvent) => void;
  /** Optional substitution overrides — see {@link substituteRuntimeTokens}. */
  nodePath?: string;
  pythonPath?: string;
  signal?: AbortSignal;
  /** Registers the generated config while the artifact store can still roll back payload promotion. */
  registerConfig: (config: McpServerConfig) => Promise<{ connected: boolean; warning?: string }>;
}

export async function installMcpFromMarketplace(
  slug: string,
  opts: InstallMcpOptions,
): Promise<InstallMcpResult> {
  const safeSlug = assertSafeArtifactSlug(slug);
  const detail = await opts.fetcher.getPluginDetail(safeSlug);
  if (!detail) {
    throw new Error(`marketplace catalog has no entry for slug "${safeSlug}"`);
  }
  if (detail.pluginType && detail.pluginType !== "mcp") {
    throw new Error(
      `slug "${safeSlug}" is a ${detail.pluginType} entry — use the regular plugin install path instead`,
    );
  }
  const version = detail.version;
  if (!version) {
    throw new Error(`marketplace entry "${safeSlug}" has no published version`);
  }

  return opts.store.withVerifiedArtifactTransaction(
    detail,
    version,
    opts.onProgress,
    async ({ zipBuffer }) => {
      // Manifest is the trust anchor: read it from the verified zip before
      // extraction so invalid launch specs never leave executable payloads on disk.
      const runtime = readRuntimeFromVerifiedZip(opts.store, safeSlug, zipBuffer);
      if (!opts.pythonPath && runtimeUsesPythonToken(runtime)) {
        throw new Error(
          `MCP runtime for "${safeSlug}" uses $PYTHON, but LVIS does not provide an app-global Python runtime. ` +
          `Publish the server as a uvx command or provide an explicit Python interpreter.`,
        );
      }
      assertMarketplaceUvxRuntimePinned(safeSlug, runtime);
      const installDir = opts.store.installDirFor(safeSlug);
      const tokens = {
        pluginDir: installDir,
        nodePath: opts.nodePath ?? process.execPath,
        pythonPath: opts.pythonPath ?? "",
      };
      const substituted = substituteRuntimeTokens(runtime, tokens);
      const config = buildMcpServerConfig(safeSlug, substituted);
      const authMode = substituted.auth ?? "none";
      throwIfMarketplaceInstallAborted(opts.signal, safeSlug);
      const { result: registration } = await opts.store.extractZipWithCommit(
        safeSlug,
        zipBuffer,
        async () => opts.registerConfig(config),
      );

      // Record install in the store's history journal so the orchestrator
      // can later support MCP rollback when (#265's) lifecycle mutex lands.
      await opts.store.appendHistory(safeSlug, {
        version,
        installedAt: new Date().toISOString(),
      });

      return {
        config,
        installDir,
        needsCredential: authMode !== "none",
        authMode,
        connected: registration.connected,
        warning: registration.warning,
      };
    },
    opts.signal,
  );
}

/**
 * Read + parse the `runtime` block from the manifest in an extracted MCP
 * install. Throws when the manifest is missing the runtime field — that
 * means the publisher uploaded a pre-#52 manifest and the host has no
 * way to launch the server.
 */
export async function readRuntimeFromInstalledManifest(installDir: string): Promise<McpRuntimeSpec> {
  const manifestPath = resolve(installDir, "plugin.json");
  let raw: string;
  try {
    const manifestStat = await stat(manifestPath);
    if (manifestStat.size > MAX_MCP_MANIFEST_BYTES) {
      throw new Error(
        `MCP manifest exceeds ${MAX_MCP_MANIFEST_BYTES} byte cap: ${manifestStat.size} bytes at ${manifestPath}`,
      );
    }
    raw = await readFile(manifestPath, "utf-8");
  } catch (err) {
    if ((err as Error).message.includes("byte cap")) throw err;
    throw new Error(
      `MCP manifest not found at ${manifestPath}: ${(err as Error).message}`,
    );
  }
  return parseRuntimeManifest(raw, `MCP manifest at ${manifestPath}`);
}

export function readRuntimeFromVerifiedZip(
  store: PluginArtifactStore,
  slug: string,
  zipBuffer: Buffer,
): McpRuntimeSpec {
  const safeSlug = assertSafeArtifactSlug(slug);
  const rootFiles = store.readRequiredRootTextFiles(safeSlug, zipBuffer, [{
    filename: "plugin.json",
    maxBytes: MAX_MCP_MANIFEST_BYTES,
    packageLabel: "MCP",
  }]);
  return parseRuntimeManifest(
    rootFiles["plugin.json"],
    `MCP manifest in verified zip for "${safeSlug}"`,
  );
}

function throwIfMarketplaceInstallAborted(signal: AbortSignal | undefined, slug: string): void {
  if (!signal?.aborted) return;
  const error = new Error(`MCP package install aborted before promotion: ${slug}`);
  error.name = "AbortError";
  throw error;
}

function parseRuntimeManifest(raw: string, source: string): McpRuntimeSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} is not an object`);
  }
  const runtime = parseMcpRuntimeSpec((parsed as Record<string, unknown>).runtime);
  if (!runtime) {
    throw new Error(
      `${source} is missing a valid \`runtime\` block — required by lvis-marketplace#52 schema`,
    );
  }
  return runtime;
}

/**
 * Replace host substitution tokens in args + env values:
 *   - `$PLUGIN_DIR` → extracted install directory
 *   - `$NODE`       → process.execPath (Electron helper / node binary)
 *   - `$PYTHON`     → explicit caller-supplied python interpreter
 *
 * Only stdio runtime has token-bearing fields; http runtime URLs are
 * passed through unchanged so the publisher can't host-substitute the
 * endpoint they themselves declared.
 */
export function substituteRuntimeTokens(
  runtime: McpRuntimeSpec,
  tokens: { pluginDir: string; nodePath: string; pythonPath: string },
): McpRuntimeSpec {
  const replace = (value: string): string =>
    value
      .replace(/\$PLUGIN_DIR/g, tokens.pluginDir)
      .replace(/\$NODE/g, tokens.nodePath)
      .replace(/\$PYTHON/g, tokens.pythonPath);

  if (runtime.transport === "stdio") {
    const out: McpRuntimeSpec = {
      transport: "stdio",
      command: replace(runtime.command),
    };
    if (runtime.args) out.args = runtime.args.map(replace);
    if (runtime.env) {
      out.env = Object.fromEntries(
        Object.entries(runtime.env).map(([k, v]) => [k, replace(v)]),
      );
    }
    if (runtime.auth) out.auth = runtime.auth;
    if (runtime.apiKeyEnv) out.apiKeyEnv = runtime.apiKeyEnv;
    return out;
  }
  return { ...runtime };
}

function runtimeUsesPythonToken(runtime: McpRuntimeSpec): boolean {
  if (runtime.transport !== "stdio") return false;
  const values = [
    runtime.command,
    ...(runtime.args ?? []),
    ...Object.values(runtime.env ?? {}),
  ];
  return values.some((value) => value.includes("$PYTHON"));
}

function assertMarketplaceUvxRuntimePinned(slug: string, runtime: McpRuntimeSpec): void {
  if (runtime.transport !== "stdio") return;
  const commandParts = runtime.command.trim().split(/\s+/).filter(Boolean);
  const executable = commandParts[0];
  if (executable !== "uvx" && executable !== "uvx.exe") return;
  const uvxArgs = [...commandParts.slice(1), ...(runtime.args ?? [])];
  const fromIndex = uvxArgs.indexOf("--from");
  const packageSpec = fromIndex >= 0 ? uvxArgs[fromIndex + 1] : uvxArgs.find((arg) => !arg.startsWith("-"));
  if (packageSpec && isExactPythonPackageSpec(packageSpec)) return;
  throw new Error(
    `MCP uvx runtime for "${slug}" must pin the executed package with an exact version ` +
    `(--from <package==version> or <package==version>).`,
  );
}

function isExactPythonPackageSpec(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9][A-Za-z0-9._-]*(?:,[A-Za-z0-9][A-Za-z0-9._-]*)*\])?(?:==|===)[A-Za-z0-9][A-Za-z0-9.!+_*~-]*$/.test(value);
}

export function buildMcpServerConfig(slug: string, runtime: McpRuntimeSpec): McpServerConfig {
  if (runtime.transport === "stdio") {
    const config: McpServerConfig = {
      id: slug,
      transport: "stdio",
      command: runtime.command,
      args: runtime.args,
      env: runtime.env,
      auth: runtime.auth ?? "none",
    };
    if (runtime.apiKeyEnv) {
      config.apiKeyEnv = runtime.apiKeyEnv;
    }
    return config;
  }
  const config: McpServerConfig = {
    id: slug,
    transport: "http",
    url: runtime.url,
    auth: runtime.auth ?? "none",
  };
  if (runtime.apiKeyHeader) {
    config.apiKeyHeader = runtime.apiKeyHeader;
  }
  if (typeof runtime.allowPrivateNetworks === "boolean") {
    config.allowPrivateNetworks = runtime.allowPrivateNetworks;
  }
  if (runtime.oauth) {
    config.oauth = runtime.oauth;
  }
  return config;
}
