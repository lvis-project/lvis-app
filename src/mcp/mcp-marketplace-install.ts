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
 *     existing api-key / SSO flows after the server entry is registered.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PluginArtifactStore } from "../plugins/plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../plugins/marketplace-fetcher.js";
import type { McpRuntimeSpec, PluginMarketplaceItem } from "../plugins/types.js";
import type { McpServerConfig } from "./types.js";
import type { InstallerProgressEvent } from "../plugins/marketplace-installer.js";

export interface InstallMcpResult {
  config: McpServerConfig;
  /** Where the artifact was extracted — useful for uninstall cleanup. */
  installDir: string;
  /** True if `runtime.auth !== "none"` — caller prompts for credentials. */
  needsCredential: boolean;
  authMode: "none" | "api-key" | "sso";
}

export interface InstallMcpOptions {
  fetcher: MarketplaceFetcher;
  /** Pre-constructed store rooted at `userData/mcp-servers/`. */
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
    raw = await readFile(manifestPath, "utf-8");
  } catch (err) {
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
  const runtime = parseRuntimeSpec((parsed as Record<string, unknown>).runtime);
  if (!runtime) {
    throw new Error(
      `MCP manifest at ${manifestPath} is missing a valid \`runtime\` block — required by lvis-marketplace#52 schema`,
    );
  }
  return runtime;
}

function parseRuntimeSpec(value: unknown): McpRuntimeSpec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const auth = r.auth;
  const validAuth =
    auth === "none" || auth === "api-key" || auth === "sso" ? auth : undefined;

  if (r.transport === "stdio") {
    if (typeof r.command !== "string" || r.command.trim().length === 0) return undefined;
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env =
      r.env && typeof r.env === "object" && !Array.isArray(r.env)
        ? Object.fromEntries(
            Object.entries(r.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    const out: McpRuntimeSpec = { transport: "stdio", command: r.command };
    if (args && args.length > 0) out.args = args;
    if (env && Object.keys(env).length > 0) out.env = env;
    if (validAuth) out.auth = validAuth;
    return out;
  }
  if (r.transport === "http") {
    if (typeof r.url !== "string" || r.url.trim().length === 0) return undefined;
    const out: McpRuntimeSpec = { transport: "http", url: r.url };
    if (validAuth) out.auth = validAuth;
    if (typeof r.allowPrivateNetworks === "boolean") {
      out.allowPrivateNetworks = r.allowPrivateNetworks;
    }
    return out;
  }
  return undefined;
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
    return out;
  }
  return { ...runtime };
}

export function buildMcpServerConfig(slug: string, runtime: McpRuntimeSpec): McpServerConfig {
  if (runtime.transport === "stdio") {
    return {
      id: slug,
      transport: "stdio",
      command: runtime.command,
      args: runtime.args,
      env: runtime.env,
      auth: runtime.auth ?? "none",
    };
  }
  return {
    id: slug,
    transport: "http",
    url: runtime.url,
    auth: runtime.auth ?? "none",
    allowPrivateNetworks: runtime.allowPrivateNetworks,
  };
}
