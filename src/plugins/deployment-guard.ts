import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readPluginRegistry } from "./registry.js";
import type { InstallPolicy } from "./types.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("deployment-guard");

/**
 * Plugin install policy guard — §9.6 / plugin-deployment-model.md §7.2-§7.3
 *
 * Managed 플러그인이 user actor에 의해 제거/비활성화되지 않도록 차단.
 *
 *   1. **Path-escape defense**: registry entry 의 manifestPath 가
 *      `pluginsRoot` 하위가 아니면 거부. registry.json 위변조로 외부 경로가
 *      등록되는 경우를 차단하는 가드 — managed 분류 신호가 아님 (모든 정상
 *      install 은 pluginsRoot 안에 거주).
 *   2. **Managed 분류**: registry 의 `installedBy === "admin"` 또는
 *      manifest 의 `installPolicy === "admin"` 이면 managed. user actor 거부.
 *
 * Trust boundary (§7.3): main process 고정. `actor`는 main 내부 호출자만 결정.
 * IPC 핸들러에서 actor를 직접 받지 말 것 — UI는 항상 "user"로 고정, "it-admin"은
 * `ManagedPluginInstaller` 같은 내부 플로우에서만 사용.
 */

export type Actor = "user" | "it-admin";

export interface GuardResult {
  allowed: boolean;
  reason?: string;
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
   * share this dir; classification is by metadata (`installedBy`,
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

    // Phase 1 §Step 3 — Trust precedence:
    //   registry-recorded `installedBy` (set at install time, verified
    //   actor) ≫ manifest `installPolicy` (advisory, user-writable).
    // Without this anchoring a user with write access to plugin.json could
    // flip `"installPolicy":"user"` and bypass the managed-plugin uninstall
    // guard. When `installedBy` is missing on a registry entry (legacy data
    // pre-dating the field), fall back to the manifest field — that path
    // is unchanged from the prior behaviour.
    if (entry.installedBy === "admin" || entry.installSource === "admin") {
      return {
        allowed: false,
        reason: `Admin plugin cannot be uninstalled by user: ${pluginId} (registry installedBy="admin")`,
      };
    }
    if (entry.installedBy === undefined && entry.installSource === undefined) {
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
   * Phase 1.5 §13 test requirement: install-side guard.
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
      return JSON.parse(raw) as { installPolicy?: InstallPolicy };
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
