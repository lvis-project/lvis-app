/**
 * Plugins domain IPC handlers.
 * Covers: lvis:plugins:*, lvis:bootstrap:*, lvis:runtime:*, lvis:marketplace:*,
 *         lvis:mcp:*, lvis:plugin:* (webview bridge), lvis:pageindex:*,
 *         lvis:notification:clicked
 */
import { app, dialog, ipcMain } from "electron";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findMethodByCapability } from "../../boot/plugins.js";
import { emitEvent as emitHostEvent } from "../../boot/types.js";
import { HOST_ONLY_EMIT_NAMESPACES, requiredCapabilityForEmit } from "../../plugins/capabilities.js";
import { stripSecretFields } from "../../plugins/config-schema.js";
import { emitPluginConfigChange, SECRET_REDACTED_SENTINEL } from "../../plugins/config-change-bus.js";
import { runManagedBootstrap } from "../../boot/managed-marketplace.js";
import { devLinkedEntryAllowed, isDevModeUnlocked } from "../../boot/dev-flags.js";
import { NOTIFICATION_KINDS } from "../../main/notification-service.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

function pluginConfigError(
  error: string,
  message: string,
): { ok: false; error: string; message: string } {
  return { ok: false, error, message };
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

interface PluginWebviewBinding {
  pluginId: string;
  entryUrl: string;
}
const pluginWebviewRegistry = new Map<number, PluginWebviewBinding>();
const pendingEntryUrlResolvers = new Map<number, Array<(b: PluginWebviewBinding) => void>>();

export function unregisterPluginWebview(webContentsId: number): void {
  pluginWebviewRegistry.delete(webContentsId);
  pendingEntryUrlResolvers.delete(webContentsId);
}

export function registerPluginsHandlers(deps: IpcDeps): void {
  const {
    pluginRuntime,
    pluginMarketplace,
    settingsService,
    auditLogger,
    refreshPluginNotifications,
    notificationService,
    mcpArtifactStore,
    getMainWindow,
  } = deps;

  // Phase 2d FU — bootstrap retry
  ipcMain.handle("lvis:bootstrap:retry", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:bootstrap:retry", e);
      return UNAUTHORIZED_FRAME;
    }
    const marketplace = settingsService.get("marketplace");
    await runManagedBootstrap({
      pluginMarketplace,
      pluginRuntime,
      mainWindow: getMainWindow(),
      marketplace,
      isPackaged: app.isPackaged,
    });
    return { ok: true } as const;
  });

  ipcMain.handle("lvis:plugins:install", async (e, pluginId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:install", e); return UNAUTHORIZED_FRAME; }
    const win = getMainWindow();
    win?.webContents.send("lvis:plugins:install-progress", { slug: pluginId, phase: "installing" });
    const result = await pluginMarketplace.install(pluginId, "user", (evt) => {
      if (evt.phase === "downloading") {
        win?.webContents.send("lvis:plugins:install-progress", {
          slug: pluginId,
          phase: "downloading",
          bytesDownloaded: evt.bytesDownloaded,
          bytesTotal: evt.bytesTotal,
        });
      } else {
        win?.webContents.send("lvis:plugins:install-progress", { slug: pluginId, phase: evt.phase });
      }
    });
    win?.webContents.send("lvis:plugins:install-progress", { slug: pluginId, phase: "restarting" });
    await pluginRuntime.addPlugin(pluginId);
    emitHostEvent("plugin.installed", { pluginId, source: "marketplace" });
    refreshPluginNotifications?.();
    win?.webContents.send("lvis:plugins:install-result", { slug: pluginId, success: true });
    return result;
  });

  ipcMain.handle("lvis:plugins:uninstall", async (e, pluginId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:uninstall", e); return UNAUTHORIZED_FRAME; }
    const broadcastUninstallResult = (payload: { slug: string; success: boolean; error?: string }) => {
      const win = getMainWindow();
      win?.webContents.send("lvis:plugins:uninstall-result", payload);
    };
    let result: Awaited<ReturnType<typeof pluginMarketplace.uninstall>>;
    try {
      result = await pluginMarketplace.uninstall(pluginId);
    } catch (err) {
      const message = (err as Error).message ?? "uninstall failed";
      broadcastUninstallResult({ slug: pluginId, success: false, error: message });
      throw err;
    }
    await pluginRuntime.removePlugin(pluginId);
    emitHostEvent("plugin.uninstalled", { pluginId });
    refreshPluginNotifications?.();
    broadcastUninstallResult({ slug: pluginId, success: true });
    return result;
  });

  ipcMain.handle("lvis:plugins:install-local", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:install-local", e); return UNAUTHORIZED_FRAME; }
    if (!isDevModeUnlocked()) {
      throw new Error("[security] dev mode not unlocked — enable a supported LVIS_DEV* flag in a non-packaged build");
    }
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: "로컬 플러그인 설치 (개발자)",
      properties: ["openDirectory"],
      message: "plugin.json이 포함된 빌드 폴더를 선택하세요",
    });
    if (canceled || !filePaths[0]) return null;
    const result = await pluginMarketplace.installLocal(filePaths[0]);
    await pluginRuntime.addPlugin(result.pluginId);
    emitHostEvent("plugin.installed", { pluginId: result.pluginId, source: "local-dev" });
    refreshPluginNotifications?.();
    // Mirror the marketplace install path's renderer broadcast so
    // `App.tsx` `onPluginInstallResult` listener fires `refreshViews()` —
    // otherwise `pluginViews` stays stale-empty after a dev sideload and
    // the InputActionBar plugin grid renders an empty trigger that
    // appears unclickable to the user (PluginGridButton's
    // `plugins.length === 0` branch returns the trigger without a Popover).
    getMainWindow()?.webContents.send("lvis:plugins:install-result", {
      slug: result.pluginId,
      success: true,
    });
    return result;
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:ui:list", () => pluginRuntime.listUiExtensions());

  ipcMain.handle("lvis:plugins:ui:read-module", async (e, payload?: { pluginId?: string; viewId?: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:ui:read-module", e);
      throw new Error("Unauthorized renderer frame for lvis:plugins:ui:read-module");
    }

    const pluginId = payload?.pluginId?.trim();
    const viewId = payload?.viewId?.trim();
    if (!pluginId || !viewId) {
      throw new Error("pluginId and viewId are required to load a plugin UI module.");
    }

    const view = pluginRuntime
      .listUiExtensions()
      .find((item) => item.pluginId === pluginId && item.extension.id === viewId);
    if (!view?.entryUrl) {
      throw new Error(`Plugin UI entry not found (plugin=${pluginId}, view=${viewId}).`);
    }
    if (!view.entryUrl.startsWith("file:")) {
      throw new Error(`Plugin UI entry is not file-backed (plugin=${pluginId}, view=${viewId}).`);
    }

    const entryPath = fileURLToPath(view.entryUrl);

    if (devLinkedEntryAllowed()) {
      let target: string;
      try {
        target = realpathSync(entryPath);
      } catch {
        throw new Error(`Plugin UI entry path could not be resolved (plugin=${pluginId}).`);
      }
      return readFile(target, "utf-8");
    }

    const rawPluginRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawPluginRoot) {
      throw new Error(`Plugin root not found (plugin=${pluginId}).`);
    }
    const pluginRoot = realpathSync(rawPluginRoot);
    let realEntryPath: string;
    try {
      realEntryPath = realpathSync(entryPath);
    } catch {
      throw new Error(`Plugin UI entry path could not be resolved (plugin=${pluginId}).`);
    }
    const rootWithSep = pluginRoot.endsWith(path.sep) ? pluginRoot : pluginRoot + path.sep;
    if (realEntryPath !== pluginRoot && !realEntryPath.startsWith(rootWithSep)) {
      throw new Error(`Plugin UI entry path escapes plugin directory (plugin=${pluginId}).`);
    }
    return readFile(realEntryPath, "utf-8");
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:cards", () => pluginRuntime.listPluginCards());

  ipcMain.handle("lvis:runtime:counts", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:runtime:counts", e); return UNAUTHORIZED_FRAME; }
    return {
      tools: deps.toolRegistry.size,
      plugins: pluginRuntime.listPluginIds().length,
      mcps: deps.mcpManager.listServers().filter((s) => s.status === "connected").length,
    };
  });

  ipcMain.handle("lvis:runtime:env", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:runtime:env", e); return UNAUTHORIZED_FRAME; }
    const os = await import("node:os");
    return {
      platform: process.platform,
      hostname: os.hostname(),
      user: os.userInfo().username,
    };
  });

  ipcMain.handle("lvis:marketplace:ping", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:marketplace:ping", e); return UNAUTHORIZED_FRAME; }
    const settings = settingsService.get("marketplace");
    if (settings.backend !== "real-cloud" || !settings.realCloudBaseUrl) {
      return { configured: false, online: false } as const;
    }
    try {
      const base = settings.realCloudBaseUrl.replace(/\/?$/, "/");
      const url = new URL("api/v1/health", base).toString();
      let res: Response;
      if (settings.realCloudAllowPrivateNetwork === true) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
          res = await fetch(url, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      } else {
        const { fetchPublicHttpResponse } = await import("../../core/network-guard.js");
        res = await fetchPublicHttpResponse(url, { timeoutMs: 3000 });
      }
      return { configured: true, online: res.ok } as const;
    } catch (err) {
      log.warn("marketplace ping failed: %s", (err as Error).message);
      return { configured: true, online: false } as const;
    }
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:marketplace:list", () => pluginMarketplace.list());

  ipcMain.handle("lvis:plugins:config:get", (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:get", e);
      return pluginConfigError("unauthorized-frame", "권한이 없는 프레임입니다.");
    }
    try {
      return { ok: true as const, config: settingsService.getPluginConfig(pluginId) };
    } catch (err) {
      return pluginConfigError("invalid-plugin-config-request", (err as Error).message);
    }
  });

  ipcMain.handle("lvis:plugins:config:set", async (e, pluginId: string, config: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:set", e);
      return pluginConfigError("unauthorized-frame", "권한이 없는 프레임입니다.");
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      const schema = manifest?.configSchema;
      const stripped = stripSecretFields(schema, asPlainRecord(config));
      const savedConfig = await settingsService.setPluginConfig(pluginId, stripped);
      pluginRuntime.setConfigOverride(pluginId, savedConfig);
      const previous = settingsService.getPluginConfig(pluginId) ?? {};
      const observed = new Set<string>([
        ...Object.keys(savedConfig ?? {}),
        ...Object.keys(previous ?? {}),
      ]);
      for (const k of observed) {
        emitPluginConfigChange(pluginId, k, savedConfig?.[k]);
      }
      await pluginRuntime.restartPlugin(pluginId);
      return { ok: true as const, config: savedConfig };
    } catch (err) {
      return pluginConfigError("plugin-config-save-failed", (err as Error).message);
    }
  });

  ipcMain.handle("lvis:plugins:config:schema:get", (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:schema:get", e);
      return pluginConfigError("unauthorized-frame", "권한이 없는 프레임입니다.");
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      return { ok: true as const, schema: manifest?.configSchema ?? null };
    } catch (err) {
      return pluginConfigError("plugin-config-schema-load-failed", (err as Error).message);
    }
  });

  ipcMain.handle("lvis:plugins:config:secret:set", async (e, pluginId: string, key: string, value: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:secret:set", e);
      return pluginConfigError("unauthorized-frame", "권한이 없는 프레임입니다.");
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      const prop = manifest?.configSchema?.properties?.[key];
      if (!prop || prop.type !== "string" || prop.format !== "secret") {
        return pluginConfigError(
          "plugin-config-secret-invalid-key",
          `Plugin '${pluginId}' configSchema does not declare a secret field '${key}'.`,
        );
      }
      const safePluginId = pluginId.trim();
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(safePluginId)) {
        return pluginConfigError("plugin-config-secret-invalid-plugin-id", `Invalid pluginId: ${pluginId}`);
      }
      await settingsService.setSecret(`plugin.${safePluginId}.${key}`, String(value ?? ""));
      const current = settingsService.getPluginConfig(safePluginId) ?? {};
      if (key in current) {
        const next = { ...current };
        delete next[key];
        await settingsService.setPluginConfig(safePluginId, next);
        pluginRuntime.setConfigOverride(safePluginId, next);
      }
      emitPluginConfigChange(safePluginId, key, SECRET_REDACTED_SENTINEL);
      return { ok: true as const };
    } catch (err) {
      return pluginConfigError("plugin-config-secret-save-failed", (err as Error).message);
    }
  });

  ipcMain.handle("lvis:plugins:config:secret:list-keys", (e, pluginId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugins:config:secret:list-keys", e);
      return pluginConfigError("unauthorized-frame", "권한이 없는 프레임입니다.");
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      const schema = manifest?.configSchema;
      if (!schema?.properties) return { ok: true as const, keys: [] as string[] };
      const presentKeys: string[] = [];
      for (const key of Object.keys(schema.properties)) {
        const prop = schema.properties[key];
        if (prop?.type === "string" && prop.format === "secret") {
          const stored = settingsService.getSecret(`plugin.${pluginId}.${key}`);
          if (stored !== null) presentKeys.push(key);
        }
      }
      return { ok: true as const, keys: presentKeys };
    } catch (err) {
      return pluginConfigError("plugin-config-secret-list-failed", (err as Error).message);
    }
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:plugins:perf-stats", () => pluginRuntime.getPerfStats());

  ipcMain.handle("lvis:plugins:call", (e, method: string, payload?: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:plugins:call", e); return UNAUTHORIZED_FRAME; }
    return pluginRuntime.callFromUi(method, payload);
  });

  // ─── MCP ──────────────────────────────────────
  ipcMain.handle("lvis:mcp:servers", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:servers", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.listServers();
  });
  ipcMain.handle("lvis:mcp:kill", (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:kill", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.killSwitch(serverId);
  });
  ipcMain.handle("lvis:mcp:config:get", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:get", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigs();
  });
  ipcMain.handle("lvis:mcp:config:path", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:path", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigPath();
  });
  ipcMain.handle("lvis:mcp:config:add", async (e, config: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:add", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.addConfig(config as import("../../mcp/types.js").McpServerConfig);
  });
  ipcMain.handle("lvis:mcp:config:remove", async (e, serverId: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:config:remove", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.removeConfig(serverId);
  });
  ipcMain.handle("lvis:mcp:ui-resource", async (e, serverId: string, uri: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:mcp:ui-resource", e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.readUiResource(serverId, uri);
  });

  ipcMain.handle("lvis:mcp:catalog:list", async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:catalog:list", e);
      return UNAUTHORIZED_FRAME;
    }
    const all = await pluginMarketplace.list();
    return all.filter((p) => p.pluginType === "mcp");
  });

  ipcMain.handle("lvis:mcp:install-from-marketplace", async (e, slug: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:install-from-marketplace", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!mcpArtifactStore) {
      return {
        ok: false,
        error: "marketplace-disabled",
        message: "MCP marketplace install is unavailable: marketplace backend is disabled in this build.",
      } as const;
    }
    if (typeof slug !== "string" || slug.trim().length === 0) {
      return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    }
    try {
      const { installMcpFromMarketplace } = await import("../../mcp/mcp-marketplace-install.js");
      const result = await installMcpFromMarketplace(slug.trim(), {
        fetcher: pluginMarketplace.getFetcher(),
        store: mcpArtifactStore,
      });
      const addResult = await deps.mcpManager.addConfig(result.config);
      return {
        ok: true as const,
        slug: slug.trim(),
        installDir: result.installDir,
        connected: addResult.connected,
        warning: addResult.warning,
        needsCredential: result.needsCredential,
        authMode: result.authMode,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: "install-failed",
        message: (err as Error).message ?? "MCP install failed",
      };
    }
  });

  ipcMain.handle("lvis:mcp:import:claude-desktop:preview", async (e, raw: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:mcp:import:claude-desktop:preview", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof raw === "string" && raw.length > 1_000_000) {
      return {
        entries: [],
        errors: [{ id: "<root>", reason: "config exceeds 1MB size limit" }],
      };
    }
    const { parseClaudeDesktopConfig } = await import("../../mcp/claude-desktop-import.js");
    return parseClaudeDesktopConfig(typeof raw === "string" ? raw : "");
  });

  ipcMain.handle(
    "lvis:mcp:import:claude-desktop:apply",
    async (
      e,
      payload: { raw: string; conflictPolicy?: "skip" | "overwrite" },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:mcp:import:claude-desktop:apply", e);
        return UNAUTHORIZED_FRAME;
      }
      const { parseClaudeDesktopConfig } = await import("../../mcp/claude-desktop-import.js");
      const policy = payload?.conflictPolicy ?? "skip";
      const parsed = parseClaudeDesktopConfig(typeof payload?.raw === "string" ? payload.raw : "");
      const seenIds = new Set<string>();
      const dedupedEntries: typeof parsed.entries = [];
      for (const entry of parsed.entries) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        dedupedEntries.push(entry);
      }

      const existing = await deps.mcpManager.getConfigs();
      const existingIds = new Set(existing.map((s) => s.id));
      const results: Array<{
        id: string;
        action: "added" | "skipped-conflict" | "overwritten" | "failed";
        reason?: string;
        warning?: string;
      }> = [];
      for (const entry of dedupedEntries) {
        const conflictedAtStart = existingIds.has(entry.id);
        if (conflictedAtStart) {
          if (policy === "skip") {
            results.push({ id: entry.id, action: "skipped-conflict" });
            continue;
          }
          try {
            await deps.mcpManager.removeConfig(entry.id);
            existingIds.delete(entry.id);
          } catch (err) {
            results.push({
              id: entry.id,
              action: "failed",
              reason: (err as Error).message ?? "remove failed",
            });
            continue;
          }
        }
        try {
          const addResult = await deps.mcpManager.addConfig(entry.config);
          existingIds.add(entry.id);
          results.push({
            id: entry.id,
            action: conflictedAtStart ? "overwritten" : "added",
            reason: addResult.connected ? undefined : addResult.warning,
            warning: entry.warning,
          });
        } catch (err) {
          results.push({
            id: entry.id,
            action: "failed",
            reason: (err as Error).message ?? "addConfig failed",
            warning: entry.warning,
          });
        }
      }
      return {
        ok: true as const,
        results,
        parseErrors: parsed.errors,
      };
    },
  );

  // ─── Plugin webview bridge (#237 Option B) ────────────────────────────────
  ipcMain.handle("lvis:plugin:register-webview", (e, payload: { webContentsId: number; pluginId: string; entryUrl: string }) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:plugin:register-webview", e);
      return UNAUTHORIZED_FRAME;
    }
    const { webContentsId, pluginId, entryUrl } = payload ?? {};
    if (typeof webContentsId !== "number" || !Number.isFinite(webContentsId)) {
      return { ok: false, error: "invalid-webcontents-id" };
    }
    if (typeof pluginId !== "string" || !pluginRuntime.getPluginManifest(pluginId)) {
      return { ok: false, error: "unknown-plugin-id" };
    }
    if (typeof entryUrl !== "string" || !entryUrl.startsWith("file://")) {
      return { ok: false, error: "invalid-entry-url" };
    }
    const rawInstallRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawInstallRoot) {
      return { ok: false, error: "plugin-not-loaded" };
    }
    let entryFsPath: string;
    try {
      entryFsPath = fileURLToPath(entryUrl);
    } catch {
      return { ok: false, error: "invalid-entry-url" };
    }
    if (devLinkedEntryAllowed()) {
      try {
        realpathSync(entryFsPath);
      } catch {
        return { ok: false, error: "entry-url-outside-install-root" };
      }
      const binding = { pluginId, entryUrl };
      pluginWebviewRegistry.set(webContentsId, binding);
      for (const resolve of pendingEntryUrlResolvers.get(webContentsId) ?? []) resolve(binding);
      pendingEntryUrlResolvers.delete(webContentsId);
      return { ok: true };
    }
    let realRoot: string;
    let realEntry: string;
    try {
      realRoot = realpathSync(rawInstallRoot);
      realEntry = realpathSync(entryFsPath);
    } catch {
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realEntry !== realRoot && !realEntry.startsWith(rootWithSep)) {
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    const binding = { pluginId, entryUrl };
    pluginWebviewRegistry.set(webContentsId, binding);
    for (const resolve of pendingEntryUrlResolvers.get(webContentsId) ?? []) resolve(binding);
    pendingEntryUrlResolvers.delete(webContentsId);
    return { ok: true };
  });

  function resolvePluginFromSender(e: import("electron").IpcMainInvokeEvent): PluginWebviewBinding | null {
    if (!validatePluginFrame(e)) return null;
    const senderId = e.sender?.id;
    if (typeof senderId !== "number") return null;
    return pluginWebviewRegistry.get(senderId) ?? null;
  }

  ipcMain.handle("lvis:plugin:get-entry-url", (e) => {
    const binding = resolvePluginFromSender(e);
    if (binding) return { ok: true as const, entryUrl: binding.entryUrl };

    if (!validatePluginFrame(e)) {
      auditUnauthorized(auditLogger, "lvis:plugin:get-entry-url", e);
      return UNAUTHORIZED_FRAME;
    }
    const senderId = e.sender?.id;
    if (typeof senderId !== "number") return UNAUTHORIZED_FRAME;

    return new Promise<{ ok: true; entryUrl: string } | typeof UNAUTHORIZED_FRAME>((resolve) => {
      const resolvers = pendingEntryUrlResolvers.get(senderId) ?? [];
      pendingEntryUrlResolvers.set(senderId, resolvers);
      const resolver = (b: PluginWebviewBinding) => { clearTimeout(timer); resolve({ ok: true, entryUrl: b.entryUrl }); };
      resolvers.push(resolver);
      const timer = setTimeout(() => {
        const arr = pendingEntryUrlResolvers.get(senderId);
        if (arr) {
          const idx = arr.indexOf(resolver);
          if (idx !== -1) arr.splice(idx, 1);
          if (arr.length === 0) pendingEntryUrlResolvers.delete(senderId);
        }
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "ipc-guard",
          type: "warn",
          input: JSON.stringify({
            channel: "lvis:plugin:get-entry-url",
            reason: "entry-url-timeout",
            frameUrl: e?.senderFrame?.url ?? "",
          }),
        });
        resolve(UNAUTHORIZED_FRAME);
      }, 500);
    });
  });

  ipcMain.handle("lvis:plugin:call-tool", async (e, method: string, payload?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:call-tool", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof method !== "string" || !method.trim()) {
      return { ok: false, error: "invalid-method" };
    }
    const ownerPluginId = pluginRuntime.resolveToolOwner(method);
    if (!ownerPluginId) {
      return { ok: false, error: `Plugin method not found: ${method}` };
    }
    if (ownerPluginId !== binding.pluginId) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin-frame",
        type: "error",
        input: `[plugin:${binding.pluginId}] cross-plugin call denied: method='${method}' owner='${ownerPluginId}'`,
      });
      return { ok: false, error: "cross-plugin-call-denied" };
    }
    try {
      const result = await pluginRuntime.callFromUi(method, payload);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("lvis:plugin:emit-event", (e, type: string, data?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, "lvis:plugin:emit-event", e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof type !== "string" || !type.trim()) {
      return { ok: false, error: "invalid-event-type" };
    }
    const manifest = pluginRuntime.getPluginManifest(binding.pluginId);
    if (!manifest) {
      return { ok: false, error: "unknown-plugin-id" };
    }
    // Host-only namespaces (plugin.*, etc.) are reserved for host-side emit
    // via boot/types.ts:emitEvent — plugin webview/renderer MUST NOT spoof
    // them. Mirrors the canEmitEvent gate at boot/steps/plugin-runtime.ts
    // (which covers the SDK hostApi.emitEvent path); this branch covers the
    // IPC bridge path that webviews use directly.
    const namespacePrefix = type.split(".")[0] ?? "";
    if (HOST_ONLY_EMIT_NAMESPACES.has(namespacePrefix)) {
      return { ok: false, error: `host-only-namespace:${namespacePrefix}` };
    }
    const requiredCap = requiredCapabilityForEmit(type);
    if (requiredCap && !manifest.capabilities?.includes(requiredCap)) {
      return { ok: false, error: `missing-capability:${requiredCap}` };
    }
    try {
      pluginRuntime.assertPluginEventEmitAccess(binding.pluginId, type);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    try {
      emitHostEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId: binding.pluginId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ─── PageIndex ──────────────────────────────────────────────────────────
  ipcMain.handle("lvis:pageindex:scan-paths", async (e, payload: { paths: string[] }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:pageindex:scan-paths", e); return UNAUTHORIZED_FRAME; }
    const method = findMethodByCapability(pluginRuntime, "document-indexer", (m) => m.endsWith("_scan"));
    if (!method) {
      return { ok: false, error: "no-indexer" };
    }
    try {
      const result = await pluginRuntime.call(method, { paths: payload.paths });
      return { ok: true, ...(result as object) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ─── Notifications ──────────────────────────────────────────────────────
  ipcMain.handle("lvis:notification:clicked", (e, payload: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:notification:clicked", e);
      return UNAUTHORIZED_FRAME;
    }
    const kind = (payload as { kind?: unknown } | null | undefined)?.kind;
    if (typeof kind !== "string" || !NOTIFICATION_KINDS.has(kind as never)) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "ipc-bridge",
        type: "warn",
        input: JSON.stringify({
          event: "notification.clicked.invalid-payload",
          receivedKind: typeof kind === "string" ? kind.slice(0, 32) : typeof kind,
          hasContextRef: typeof (payload as Record<string, unknown> | null | undefined)?.contextRef === "object",
        }),
      });
      return { ok: false, error: "invalid-payload" };
    }
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } catch (err) {
        log.warn(
          "notification:clicked focus failed: %s",
          (err as Error).message,
        );
      }
    }
    return { ok: true };
  });
}
