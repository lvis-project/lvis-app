/**
 * Plugin path single source of truth.
 *
 * 모든 플러그인은 `~/.lvis/plugins/<id>/` 아래 단일 디렉토리에 거주한다.
 * 그 안에 install artifact (`plugin.json`, `dist/`, ...) 와 plugin save data
 * 가 함께 들어간다 — 플러그인이 자기 디렉토리를 곧 자기 저장소로 사용한다.
 *
 * 호스트 모듈(memory, audit, mcp, traces, certs, ...) 은 별도로 `~/.lvis/` 의
 * 다른 sibling 폴더에 있다. 즉 `~/.lvis/<topic>/` 는 호스트, `~/.lvis/plugins/<id>/`
 * 는 플러그인 — 플러그인이 호스트 폴더에 끼어들거나 호스트가 플러그인 폴더를
 * 들여다보지 않는다.
 *
 * Round-3 cleanup: env-tier override (`LVIS_PLUGINS_DIR`) 제거. 이제 경로
 * 오버라이드는 constructor injection (resolvePluginPaths의 `pluginsRoot`
 * 인자) 단일 경로만 지원한다 — 테스트는 항상 DI, dev 런타임은 항상 canonical
 * `~/.lvis/plugins/`. env tier 가 없어도 모든 호출자가 이미 DI 를 쓰고 있다.
 *
 * Electron 은 의도적으로 import 하지 않는다 — 이 모듈은 vitest 에서 electron
 * stub 없이도 동작한다.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface PluginPaths {
  /** Absolute path to `registry.json` — sits at the root of `pluginsRoot`. */
  registryPath: string;
  /**
   * Directory where every plugin lives — `<pluginsRoot>/<id>/plugin.json`.
   * `installSource` is metadata only; admin / user / local-dev / dev / dev-link
   * entries all share this root (no physical user/managed split).
   */
  pluginsRoot: string;
  /** Per-plugin version cache for rollback (Sprint 3-B §9.6). */
  cacheRoot: string;
}

export interface ResolvePluginPathsInput {
  /**
   * Override for the plugins root. When omitted, defaults to
   * `homedir()/.lvis/plugins`.
   *
   * Tests use this for sandbox isolation. There is no env-tier fallback —
   * if an override is needed, callers must pass it explicitly.
   */
  pluginsRoot?: string;
  /** Optional cache root override. Defaults to `<pluginsRoot>/.cache`. */
  cacheRoot?: string;
}

/**
 * Resolve the plugin path layout.
 *
 * Final shape:
 *   - `~/.lvis/plugins/registry.json`
 *   - `~/.lvis/plugins/<id>/plugin.json`
 *   - `~/.lvis/plugins/.cache/`
 *
 * Override is via the `pluginsRoot` argument only (constructor injection).
 * By design `registryPath` is always `pluginsRoot/registry.json` so registry
 * entries can hold paths relative to `dirname(registryPath)`.
 */
export function resolvePluginPaths(input: ResolvePluginPathsInput = {}): PluginPaths {
  const pluginsRoot = resolve(
    input.pluginsRoot ?? resolve(homedir(), ".lvis", "plugins"),
  );
  const cacheRoot = resolve(input.cacheRoot ?? resolve(pluginsRoot, ".cache"));
  return {
    registryPath: resolve(pluginsRoot, "registry.json"),
    pluginsRoot,
    cacheRoot,
  };
}

/**
 * Normalize a `manifestPath` registry entry value into the registry-relative
 * form every install writes. POSIX-style separators.
 *
 * Behaviour:
 *  - input may be absolute or relative to `dirname(registryPath)`
 *  - returns POSIX-separated relative path when the manifest lives under
 *    the registry's directory tree (the only valid shape)
 *  - returns the absolute path with POSIX separators otherwise — runtime
 *    will reject those entries via the trust-root check
 */
export function toRegistryRelativeManifestPath(
  registryPath: string,
  manifestPath: string,
): string {
  const registryDir = resolve(registryPath, "..");
  const absolute = resolve(registryDir, manifestPath);
  if (!absolute.startsWith(registryDir + "\\") && !absolute.startsWith(registryDir + "/") && absolute !== registryDir) {
    return absolute.split("\\").join("/");
  }
  const rel = absolute.slice(registryDir.length).replace(/^[\\/]+/, "");
  return rel.split("\\").join("/");
}
