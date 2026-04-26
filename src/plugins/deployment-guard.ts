import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readPluginRegistry } from "./registry.js";
import type { InstallPolicy } from "./types.js";

/**
 * Plugin install policy guard — §9.6 / plugin-deployment-model.md §7.2-§7.3
 *
 * Managed 플러그인이 user actor에 의해 제거/비활성화되지 않도록 차단.
 * Phase 1.5 hybrid 판정 (두 레이어가 모두 통과해야 "user" 허용):
 *
 *   1. Path check (default-deny): `userInstalledDir` 하위가 아니면 managed.
 *      registry.json 위변조로 외부 경로가 등록되는 경우를 차단.
 *   2. Manifest field check: `plugin.json`의 `installPolicy === "admin"`면 managed.
 *      `userInstalledDir` 안에 있더라도 번들 플러그인(설치 시점에 관리형으로
 *      지정됐던 것)은 필드로 식별.
 *
 * 위 두 검사 중 하나라도 managed를 가리키면 user actor는 거부되고 it-admin만 허용.
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
   * Absolute path to the directory where user-installed plugins live
   * (typically `{appRoot}/plugins/installed`).
   */
  userInstalledDir: string;
}

export class PluginDeploymentGuard {
  private readonly registryPath: string;
  private readonly userInstalledDir: string;

  constructor(options: DeploymentGuardOptions) {
    this.registryPath = resolve(options.registryPath);
    this.userInstalledDir = resolve(options.userInstalledDir);
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
        reason: `Managed plugin cannot be uninstalled by user: ${pluginId} (path outside userInstalledDir)`,
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
    if (entry.installedBy === "admin") {
      return {
        allowed: false,
        reason: `Admin plugin cannot be uninstalled by user: ${pluginId} (registry installedBy="admin")`,
      };
    }
    if (entry.installedBy === undefined) {
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
      console.warn(
        `[deployment-guard] readManifestSafe failed for ${path}:`,
        (err as Error).message,
      );
      return null;
    }
  }

  private isPathUnderUserInstalledDir(absolutePath: string): boolean {
    const rel = relative(this.userInstalledDir, absolutePath);
    if (rel === "" || rel === ".") return false;
    if (rel.startsWith("..")) return false;
    if (isAbsolute(rel)) return false;
    return true;
  }
}
