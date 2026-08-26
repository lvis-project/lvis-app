import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readPluginRegistry } from "./registry.js";
import { flattenAgentPluginsManifest } from "./public-contract.js";
import type { InstallPolicy } from "./types.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("deployment-guard");





export type Actor = "user" | "it-admin";

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Thrown when a {@link PluginDeploymentGuard} decision denies a lifecycle
 * mutation. Callers that need to distinguish a policy denial from an
 * operational failure (the IPC layer maps it to its own error code) must use
 * `instanceof` — never a message-prefix match, so the denial wording stays a
 * single authority here.
 */
export class PluginDeploymentDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PluginDeploymentDeniedError";
  }
}

function normalizeInstallPolicy(value: {
  installPolicy?: InstallPolicy;
} | null | undefined): InstallPolicy {
  if (value?.installPolicy === "admin") {
    return "admin";
  }
  return "user";
}

export interface DeploymentGuardOptions {
  /** Absolute path to plugin registry (plugins/registry.json) */
  registryPath: string;
  /**
   * Absolute path to the directory where every plugin lives — the single
   * root `~/.lvis/plugins/`. user-installed and admin-injected plugins
   * share this dir; classification is by metadata (`installSource`,
   * `installPolicy`), not by path.
   */
  pluginsRoot: string;
}

export class PluginDeploymentGuard {
  private readonly registryPath: string;
  private readonly pluginsRoot: string;

  constructor(options: DeploymentGuardOptions) {
    this.registryPath = resolve(options.registryPath);
    this.pluginsRoot = resolve(options.pluginsRoot);
  }

  async canUninstall(pluginId: string, actor: Actor): Promise<GuardResult> {
    if (actor === "it-admin") {
      return { allowed: true };
    }

    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((p) => p.id === pluginId);
    if (!entry) {
      return { allowed: false, reason: `Plugin not found: ${pluginId}` };
    }

    const manifestAbs = isAbsolute(entry.manifestPath)
      ? resolve(entry.manifestPath)
      : resolve(dirname(this.registryPath), entry.manifestPath);

    if (!this.isPathUnderUserInstalledDir(manifestAbs)) {
      return {
        allowed: false,
        reason: `Managed plugin cannot be uninstalled by user: ${pluginId} (path outside pluginsRoot)`,
      };
    }

    // §Step 3 — Trust precedence:
    //   registry-recorded `installSource` (set at install time, verified
    //   actor) ≫ manifest `installPolicy` (advisory, user-writable).
    // Without this anchoring a user with write access to plugin.json could
    // flip `"installPolicy":"user"` and bypass the managed-plugin uninstall
    // guard. When `installSource` is missing on a registry entry (legacy
    // data pre-dating the field — readPluginRegistry migrates it on read,
    // but a defensive fallback keeps the guard correct even if the
    // migration ever fails to persist), fall back to the manifest field.
    if (entry.installSource === "admin") {
      return {
        allowed: false,
        reason: `Admin plugin cannot be uninstalled by user: ${pluginId} (registry installSource="admin")`,
      };
    }
    if (entry.installSource === undefined) {
      const manifest = await this.readManifestSafe(manifestAbs);
      if (normalizeInstallPolicy(manifest) === "admin") {
        return {
          allowed: false,
          reason: `Admin plugin cannot be uninstalled by user: ${pluginId} (installPolicy="admin")`,
        };
      }
    }

    return { allowed: true };
  }

  async canDisable(pluginId: string, actor: Actor): Promise<GuardResult> {
    return this.canUninstall(pluginId, actor);
  }

  /**
   * §13 test requirement: install-side guard.
   *
   * Catalog item에 `installPolicy: "admin"`이 붙어있으면 user actor의 설치 요청을
   * 거부한다. UI는 이미 disabled 상태지만, 백엔드에서도 enforcement를 걸어
   * IPC 경유 우회를 차단한다 (defense in depth).
   *
   * 호출 시점: `PluginMarketplaceService.install()` 진입 직후, npm install 실행 전.
   */
  async canInstall(
    pluginId: string,
    actor: Actor,
    installPolicy?: InstallPolicy,
  ): Promise<GuardResult> {
    if (actor === "it-admin") {
      return { allowed: true };
    }
    if (normalizeInstallPolicy({ installPolicy }) === "admin") {
      return {
        allowed: false,
        reason: `Admin plugin cannot be installed by user: ${pluginId}`,
      };
    }
    return { allowed: true };
  }

  private async readManifestSafe(path: string): Promise<{ installPolicy?: InstallPolicy } | null> {
    try {
      const raw = await readFile(path, "utf-8");
      // `installPolicy` is an LVIS field, so in an Agent Plugins document it is
      // inside the extension namespace, not at the top level. Reading the raw
      // document here would see `undefined` and silently downgrade an admin
      // plugin to the "user" default.
      return flattenAgentPluginsManifest(JSON.parse(raw));
    } catch (err) {
      // Corrupted / missing manifest. Path check alone may have already
      // decided, so we don't throw — but surface for forensics.
      log.warn(
        `readManifestSafe failed for ${path}: %s`,
        (err as Error).message,
      );
      return null;
    }
  }

  private isPathUnderUserInstalledDir(absolutePath: string): boolean {
    const rel = relative(this.pluginsRoot, absolutePath);
    if (rel === "" || rel === ".") return false;
    if (rel.startsWith("..")) return false;
    if (isAbsolute(rel)) return false;
    return true;
  }
}

/**
 * Deployment policy for the LIVE disable writer.
 *
 * Two methods mutate the registry `enabled` field. `disable()` consults this
 * guard but has no production caller; `setPluginEnabled()` is what the renderer
 * toggle reaches through `CHANNELS.plugins.setEnabled`, and it had no guard at
 * all — so the admin-managed protection existed only on a lane nothing calls,
 * and a user could switch off an admin-deployed plugin from the settings tab.
 *
 * Actor is hard-coded to `"user"`: every caller of the live writer is the
 * renderer IPC toggle. An it-admin lane here would be unreachable, so it is
 * deliberately absent — `disable(id, "it-admin")` is the API for that.
 *
 * `installClaim` is the registry row id this guard looks entries up by, NOT the
 * canonical manifest id, which it would fail to find. A static manifest
 * (`installClaim === null`) has no registry row to classify, and its toggle is
 * session-local and persists nothing.
 */
export async function assertDisableAllowed(
  enabled: boolean,
  installClaim: string | null,
  pluginId: string,
  deploymentGuard: Pick<PluginDeploymentGuard, "canDisable"> | undefined,
): Promise<void> {
  if (enabled || !deploymentGuard || installClaim === null) return;
  const guardResult = await deploymentGuard.canDisable(installClaim, "user");
  if (!guardResult.allowed) {
    throw new PluginDeploymentDeniedError(
      guardResult.reason ?? `Plugin disable denied: ${pluginId}`,
    );
  }
}
