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

import type { PluginArtifactStore } from "../plugins/plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../plugins/marketplace-fetcher.js";
import { parseMcpRuntimeSpec } from "../plugins/mcp-runtime-spec.js";
import type { McpRuntimeSpec, PluginMarketplaceItem } from "../plugins/types.js";
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
}

export interface InstallMcpOptions {
  fetcher: MarketplaceFetcher;
  /** Pre-constructed store rooted at `~/.lvis/mcp/`. */
  store: PluginArtifactStore;
  onProgress?: (event: InstallerProgressEvent) => void;
  /** Optional substitution overrides — see {@link substituteRuntimeTokens}. */
  nodePath?: string;
  pythonPath?: string;
}

export async function installMcpFromMarketplace(
  slug: string,
  opts: InstallMcpOptions,
): Promise<InstallMcpResult> {
  const detail = await opts.fetcher.getPluginDetail(slug);
  if (!detail) {
    throw new Error(`marketplace catalog has no entry for slug "${slug}"`);
  }
  if (detail.pluginType && detail.pluginType !== "mcp") {
    throw new Error(
      `slug "${slug}" is a ${detail.pluginType} entry — use the regular plugin install path instead`,
    );
  }
  const version = detail.version;
  if (!version) {
    throw new Error(`marketplace entry "${slug}" has no published version`);
  }

  const zipBuffer = await opts.store.downloadVerifiedZip(detail, version, opts.onProgress);
  await opts.store.extractZip(slug, zipBuffer);
  const installDir = opts.store.installDirFor(slug);

  // Manifest is the trust anchor: the verified zip extracted by the store
  // is the only source of `runtime`. Catalog row is advisory.
  const runtime = await readRuntimeFromInstalledManifest(installDir);
  const tokens = {
    pluginDir: installDir,
    nodePath: opts.nodePath ?? process.execPath,
    pythonPath: opts.pythonPath ?? "python",
  };
  const substituted = substituteRuntimeTokens(runtime, tokens);
  const config = buildMcpServerConfig(slug, substituted);
  const authMode = substituted.auth ?? "none";

  // Record install in the store's history journal so the orchestrator
  // can later support MCP rollback when (#265's) lifecycle mutex lands.
  await opts.store.appendHistory(slug, {
    version,
    installedAt: new Date().toISOString(),
  });

  return { config, installDir, needsCredential: authMode !== "none", authMode };
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `MCP manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP manifest at ${manifestPath} is not an object`);
  }
  const runtime = parseMcpRuntimeSpec((parsed as Record<string, unknown>).runtime);
  if (!runtime) {
    throw new Error(
      `MCP manifest at ${manifestPath} is missing a valid \`runtime\` block — required by lvis-marketplace#52 schema`,
    );
  }
  return runtime;
}

/**
 * Replace host substitution tokens in args + env values:
 *   - `$PLUGIN_DIR` → extracted install directory
 *   - `$NODE`       → process.execPath (Electron helper / node binary)
 *   - `$PYTHON`     → caller-supplied python interpreter
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
