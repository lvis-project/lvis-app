// Stable preload composition and race-window primes. The large internal API
// object lives in internal-api-surface.ts; this module retains the public
// builder exports used by preload.ts.
import { ipcRenderer } from "electron";
import {
  CHANNELS,
  UI,
} from "../contract/app-contract.js";
import {
  INITIAL_THEME_ARG_PREFIX,
  INITIAL_THEME_ARG_MAX_BYTES,
  type InitialThemePrime,
} from "../shared/initial-theme.js";
import {
  FONT_SIZE_SCALE_VALUES,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";
import {
  INITIAL_APP_MODE_ARG_PREFIX,
  normalizeAppMode,
  type InitialAppMode,
} from "../shared/initial-app-mode.js";
import type {
  AssistantContextMenuAction,
  AssistantContextMenuPayload,
} from "../shared/assistant-context-menu.js";
import type {
  NativeContextMenuAction,
  NativeContextMenuPayload,
} from "../shared/native-context-menu.js";
import {
  normalizeMarketplacePackageActionResult,
  normalizePluginActionResult,
} from "./internal-api-surface.js";
export { buildInternalApiSurface } from "./internal-api-surface.js";

export type LvisInitialThemePayload = Readonly<InitialThemePrime>;

export function readInitialThemeArg(): LvisInitialThemePayload | null {
  try {
    // `findLast` (vs `find`) defends against accidental duplicate arg
    // injection: if anyone ever passes the prefix twice, the later one wins
    // — matching the convention that "last write wins" in argv-style flags.
    const arg = process.argv.findLast(
      (a): a is string => typeof a === "string" && a.startsWith(INITIAL_THEME_ARG_PREFIX),
    );
    if (!arg) return null;
    const json = arg.slice(INITIAL_THEME_ARG_PREFIX.length);
    // Size guard mirrors `main.ts:initialThemeArgs` — keeps a malformed or
    // attacker-influenced argv from blocking the renderer on a giant parse.
    if (json.length > INITIAL_THEME_ARG_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as {
      bundleId?: unknown;
      shell?: unknown;
      tokens?: unknown;
      fontSizeScale?: unknown;
      fontFamily?: unknown;
    };
    if (typeof p.bundleId !== "string") return null;
    if (p.shell !== "light" && p.shell !== "dark") return null;
    const tokens: Record<string, string> = {};
    if (p.tokens && typeof p.tokens === "object" && !Array.isArray(p.tokens)) {
      for (const [k, v] of Object.entries(p.tokens as Record<string, unknown>)) {
        if (typeof k === "string" && k.startsWith("--lvis-") && typeof v === "string") {
          tokens[k] = v;
        }
      }
    }
    // Font overrides are validated against the same SoT guards the settings
    // store enforces at write time (`FONT_SIZE_SCALE_VALUES`,
    // `isValidFontFamilyOverride`) so a tampered argv cannot inject an arbitrary
    // scale or a CSS-injection font-family. Invalid → field stays undefined and
    // the renderer's hydrate applies the persisted value.
    const out: InitialThemePrime = { bundleId: p.bundleId, shell: p.shell, tokens: Object.freeze(tokens) };
    if (
      typeof p.fontSizeScale === "number" &&
      (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(p.fontSizeScale)
    ) {
      out.fontSizeScale = p.fontSizeScale;
    }
    if (isValidFontFamilyOverride(p.fontFamily)) {
      out.fontFamily = p.fontFamily;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

export function applyInitialThemePrime(payload: LvisInitialThemePayload | null): void {
  if (!payload || typeof document === "undefined") return;
  // Apply attributes + tokens immediately. Preload's mutations to
  // documentElement are visible to the renderer's first paint because both
  // share the same DOM (contextIsolation isolates JS objects, not DOM).
  try {
    const root = document.documentElement;
    root.setAttribute("data-theme-bundle", payload.bundleId);
    root.setAttribute("data-shell", payload.shell);
    if (payload.tokens) {
      for (const [k, v] of Object.entries(payload.tokens)) {
        root.style.setProperty(k, v);
      }
    }
    // User font overrides — same documentElement CSS-var hooks ThemeProvider's
    // `applySettingsAppearance` sets after hydrate.
    if (typeof payload.fontSizeScale === "number") {
      root.style.setProperty("--lvis-font-size-scale", String(payload.fontSizeScale));
    }
    if (typeof payload.fontFamily === "string") {
      root.style.setProperty("--lvis-font-family", payload.fontFamily);
    }
  } catch {
    // Non-fatal: ThemeProvider's async hydrate still runs as a fallback.
  }
}

export function readInitialAppModeArg(): InitialAppMode | null {
  try {
    const arg = process.argv.findLast(
      (a): a is string => typeof a === "string" && a.startsWith(INITIAL_APP_MODE_ARG_PREFIX),
    );
    if (!arg) return null;
    const value = arg.slice(INITIAL_APP_MODE_ARG_PREFIX.length);
    return normalizeAppMode(value);
  } catch {
    return null;
  }
}


export function buildLvisHostWorld() {
  let hostMarketplaceApiClaimed = false;
  return {
  takePluginMarketplaceApi: () => {
    if (hostMarketplaceApiClaimed) return null;
    hostMarketplaceApiClaimed = true;
    return {
      installMarketplacePlugin: async (
        pluginId: string,
        expectedVersion?: string,
        options?: { networkAccessAcknowledgement?: unknown },
      ) =>
        normalizePluginActionResult(await ipcRenderer.invoke(CHANNELS.plugins.install, pluginId, {
          ...(expectedVersion ? { expectedVersion } : {}),
          ...(options?.networkAccessAcknowledgement ? { networkAccessAcknowledgement: options.networkAccessAcknowledgement } : {}),
        })),
      uninstallMarketplacePlugin: async (
        pluginId: string,
        options?: { doctorCleanup?: { installFailureKind?: string } },
      ) =>
        normalizePluginActionResult(await ipcRenderer.invoke(CHANNELS.plugins.uninstall, pluginId, options)),
      installMarketplaceAgent: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.agents.install, slug), "agentId"),
      uninstallMarketplaceAgent: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.agents.uninstall, slug), "agentId"),
      installMarketplaceSkill: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.skills.install, slug), "skillId"),
      uninstallMarketplaceSkill: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.skills.uninstall, slug), "skillId"),
    };
  },
  };
}

export function buildLvisPlatformWorld() {
  return {
    isDarwin: process.platform === "darwin",
  };
}

export function buildLvisWindowWorld() {
  return {
  minimize: () => ipcRenderer.invoke(CHANNELS.window.minimize),
  toggleMaximize: () => ipcRenderer.invoke(CHANNELS.window.toggleMaximize),
  close: () => ipcRenderer.invoke(CHANNELS.window.close),
  syncTitleBarTheme: (color: string, symbolColor: string) =>
    ipcRenderer.invoke(CHANNELS.window.syncTitleBarTheme, { color, symbolColor }),
  onMaximizedChanged: (handler: (maximized: boolean) => void) => {
    const listener = (_event: unknown, maximized: boolean) => handler(maximized);
    ipcRenderer.on(CHANNELS.window.maximizedChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.window.maximizedChanged, listener);
  },
  onFullscreenChanged: (handler: (fullscreen: boolean) => void) => {
    const listener = (_event: unknown, fullscreen: boolean) => handler(fullscreen);
    ipcRenderer.on(CHANNELS.window.fullscreenChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.window.fullscreenChanged, listener);
  },
  };
}

export function buildLvisNamespaceExtras() {
  return {
  plugins: {
    cards: () => ipcRenderer.invoke(CHANNELS.plugins.cards),
  },
  ui: {
    showAssistantContextMenu: (payload: AssistantContextMenuPayload) =>
      ipcRenderer.invoke(UI.assistantContextMenu, payload),
    onAssistantContextAction: (cb: (action: AssistantContextMenuAction) => void) => {
      const listener = (_event: unknown, action: AssistantContextMenuAction) => cb(action);
      ipcRenderer.on(UI.assistantContextAction, listener);
      return () => ipcRenderer.removeListener(UI.assistantContextAction, listener);
    },
    showNativeContextMenu: (payload: NativeContextMenuPayload) =>
      ipcRenderer.invoke(UI.nativeContextMenu, payload),
    onNativeContextMenuAction: (cb: (action: NativeContextMenuAction) => void) => {
      const listener = (_event: unknown, action: NativeContextMenuAction) => cb(action);
      ipcRenderer.on(UI.nativeContextAction, listener);
      return () => ipcRenderer.removeListener(UI.nativeContextAction, listener);
    },
  },
  pluginConfig: {
    get: (pluginId: string) => ipcRenderer.invoke(CHANNELS.plugins.configGet, pluginId),
    set: (pluginId: string, config: Record<string, unknown>) => ipcRenderer.invoke(CHANNELS.plugins.configSet, pluginId, config),
    getSchema: (pluginId: string) => ipcRenderer.invoke(CHANNELS.plugins.configSchemaGet, pluginId),
    setSecret: (pluginId: string, key: string, value: string) =>
      ipcRenderer.invoke(CHANNELS.plugins.configSecretSet, pluginId, key, value),
    // US-3c.1: batch secret-presence query — returns keys for which the
    // keychain holds a value. Fewer IPC round-trips than per-key checks.
    listSecretKeys: (pluginId: string) =>
      ipcRenderer.invoke(CHANNELS.plugins.configSecretListKeys, pluginId),
  },
  env: {
    isDev: process.env.LVIS_DEV === "1",
    isE2E: process.env.LVIS_E2E === "1",
    enableDevConsole: process.env.LVIS_DEV_CONSOLE === "1",
    debugStream:
      process.env.VITE_DEBUG_STREAM === "1" ||
      process.env.LVIS_DEBUG_STREAM === "1",
  },
  attach: {
    openFile: () => ipcRenderer.invoke(CHANNELS.attach.openFile),
    readImage: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.attach.readImage, filePath),
    saveClipboardImage: (base64: string) =>
      ipcRenderer.invoke(CHANNELS.attach.saveClipboardImage, { base64 }),
    openExternal: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.attach.openExternal, filePath),
  },
  preview: {
    readFile: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.preview.readFile, filePath),
  },
  workspace: {
    listRoots: () => ipcRenderer.invoke(CHANNELS.workspace.listRoots),
    pickRoot: (opts?: { ackToken?: string }) =>
      ipcRenderer.invoke(CHANNELS.workspace.pickRoot, opts),
    listDir: (dirPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.listDir, dirPath),
    removeRoot: (dirPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.removeRoot, dirPath),
    reveal: (targetPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.reveal, targetPath),
    // Drag-drop add-root, step 1 (#1458): submit a renderer-resolved dropped
    // folder path for Layer-0 + is-a-dir validation and a main-owned ack token.
    dropPrepare: (droppedPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.dropPrepare, droppedPath),
  },
  };
}
