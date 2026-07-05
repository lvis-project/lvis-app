// Named imports — esbuild bundles these as direct property access on the CJS
// module (no `__toESM` wrapper, no `.default` indirection). Aligned with
// plugin-preload.ts for the same reason: Electron 41 sandboxed webview preload
// contexts fail silently when the bundled output goes through
// `__toESM(require("electron"), 1).default.contextBridge`.
import { contextBridge } from "electron";
import { resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPublicSurface } from "./preload/public-surface.js";
import { resolveDroppedPaths } from "./preload/webutils-bridge.js";
import {
  applyInitialThemePrime,
  buildInternalApiSurface,
  buildLvisHostWorld,
  buildLvisNamespaceExtras,
  buildLvisPlatformWorld,
  buildLvisWindowWorld,
  readInitialAppModeArg,
  readInitialThemeArg,
} from "./preload/internal-surface.js";

// ─── Deterministic plugin webview asset URLs ────────────────────────────────
// `__dirname` here resolves to the host preload's bundled location
// (`dist/src/`). These MUST be computed in this entry module (not a submodule)
// so `__dirname` points at `dist/src/`; the host renderer reads them directly
// when mounting the plugin <webview>, and they survive splash-phase data: URLs.
function safeResolveFileUrl(relative: string): string {
  try {
    return pathToFileURL(pathResolve(__dirname, relative)).toString();
  } catch {
    return "";
  }
}
const pluginPreloadUrl = safeResolveFileUrl("plugin-preload.cjs");
const pluginShellUrl = safeResolveFileUrl("plugin-ui-shell.html");

// ─── Race-window-zero primes (theme + app-mode) ─────────────────────────────
// Read the argv-injected primes and paint the theme onto documentElement before
// React mounts (frame-0 correct paint). See internal-surface.ts for the SoT.
const lvisInitialTheme = readInitialThemeArg();
applyInitialThemePrime(lvisInitialTheme);
const lvisInitialAppMode = readInitialAppModeArg();

// ─── Composed host API surface ──────────────────────────────────────────────
// The public + internal builders partition the methods; the exposed
// `window.lvisApi` object is their union (byte-identical name + shape). The
// plugin webview asset URLs are added here because they depend on this module's
// `__dirname`.
const api = {
  ...buildPublicSurface(),
  ...buildInternalApiSurface(),
  pluginPreloadUrl,
  pluginShellUrl,
};

// Expose the theme prime payload so ThemeProvider (renderer) can read it
// synchronously on mount and skip its async settings.json hydrate. `null`
// when main has nothing cached yet (cold-boot first window).
contextBridge.exposeInMainWorld("__lvisInitialTheme", lvisInitialTheme);

// Expose the persisted workspace mode so App.tsx can seed its `appMode` /
// `sidebarCollapsed` state synchronously on mount (frame-0 correct layout).
contextBridge.exposeInMainWorld("__lvisInitialAppMode", lvisInitialAppMode);

contextBridge.exposeInMainWorld("lvisApi", api);
// Dev mode runtime flag — main process sets NODE_ENV=development in
// `scripts/run-electron.mjs`, so preload reads it at runtime.
//
// IMPORTANT: webpack's production mode auto-injects DefinePlugin that
// statically replaces ANY recognizable `process.env.NODE_ENV` shape with
// the build-time value ("production") — including bracket notation
// `process.env["NODE_ENV"]`. To force a true runtime lookup we route the
// access through (a) a runtime-resolved key name and (b) `globalThis.process`
// indirection so neither AST root nor index matches DefinePlugin's pattern.
function readEnvAtRuntime(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}
contextBridge.exposeInMainWorld(
  "__lvisDevMode",
  readEnvAtRuntime("NODE_ENV") !== "production",
);

contextBridge.exposeInMainWorld("lvisHost", buildLvisHostWorld());

// ─── Window control bridge (custom titlebar) ─────────────────────────────
// Exposed unconditionally so the renderer can branch at runtime.
// On macOS the windowControl methods are never called (traffic lights
// are OS-managed). isDarwin lets the renderer suppress Win/Linux buttons.
contextBridge.exposeInMainWorld("lvisPlatform", buildLvisPlatformWorld());
contextBridge.exposeInMainWorld("lvisWindow", buildLvisWindowWorld());



// permission/approval/userApproval/policy/mcp are shared with lvisApi (same
// object refs); the remaining namespaces come from the internal surface.
// ─── Drop-path resolution bridge (webUtils.getPathForFile) ────────────────
// A dropped File cannot cross IPC, so its path must be resolved here in preload.
// The returned string is only a CANDIDATE path — the main-process
// workspace.dropPrepare gate (Layer-0 deny + is-a-dir + main-owned ack token)
// makes the actual read-scope decision, so this bridge grants no capability.
// Exposed as its own minimal world (a single resolver), never raw webUtils.
contextBridge.exposeInMainWorld("lvisDrop", { resolveDroppedPaths });

contextBridge.exposeInMainWorld("lvis", {
  permission: api.permission,
  approval: api.approval,
  userApproval: api.userApproval,
  policy: api.policy,
  mcp: api.mcp,
  ...buildLvisNamespaceExtras(),
});
