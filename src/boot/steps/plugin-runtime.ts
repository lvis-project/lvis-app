/**
 * Boot §4.2 Step 3-5 — Plugin runtime + HostApi factory.
 *
 * Extracted from boot.ts to keep orchestration thin. This module:
 *   • constructs the PluginDeploymentGuard + SignatureVerifier
 *   • builds the per-plugin HostApi factory (registerKeywords / emitEvent /
 *     onEvent / addTask / saveNote / getSecret / msGraph* / callLlm /
 *     logEvent / onShutdown)
 *   • creates the PluginRuntime, loads manifests, and exposes a starter that
 *     boot.ts calls after generic event subscribers are registered
 *   • wires manifest startupTools and the dev hot-reload watcher after start
 *   • returns the runtime + late-binding refs (llmCallerRef / pluginCallLlmRef /
 *     conversationLoopRef) that boot.ts injects once ConversationLoop exists.
 *
 * No plugin-specific literals here — everything is manifest-driven.
 */
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { AuditLogger } from "../../audit/audit-logger.js";
import { PluginRuntime } from "../../plugins/runtime.js";
import { startPluginDevWatcher } from "../../plugins/dev-watcher.js";
import { PluginDeploymentGuard } from "../../plugins/deployment-guard.js";
import { PluginSignatureVerifier } from "../../plugins/signature-verifier.js";
import { BUNDLED_PUBLISHER_PUBLIC_KEYS } from "../../plugins/publisher-keys.js";
import { requiredCapabilityForEmit } from "../../plugins/capabilities.js";
import { TaskSourceRegistry, deriveCategoryId } from "../../plugins/task-source-registry.js";
import { withMsGraphRetry } from "../../main/ms-graph-retry.js";
import type { PluginHostApi, PluginManifest } from "../../plugins/types.js";
import type { KeywordEngine } from "../../core/keyword-engine.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { TaskService } from "../../taskService.js";
import type { MsGraphService } from "../../main/ms-graph-service.js";
import { emitEvent, onEvent } from "../types.js";
import {
  buildPluginConfigOverrides,
  registerPluginTools,
  runManifestStartupTools,
} from "../plugins.js";

/** Late-binding container the ConversationLoop fills in after it exists. */
export interface LateBindingRefs {
  llmCallerRef: {
    fn:
      | ((prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>)
      | null;
  };
  pluginCallLlmRef: {
    fn:
      | ((
          pluginId: string,
          prompt: string,
          opts?: { maxTokens?: number; systemPrompt?: string },
        ) => Promise<string>)
      | null;
  };
  conversationLoopRef: {
    fn: import("../../engine/conversation-loop.js").ConversationLoop | null;
  };
}

export interface InitPluginRuntimeInput {
  projectRoot: string;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  toolRegistry: ToolRegistry;
  taskService: TaskService;
  msGraphService: MsGraphService;
  pythonPath: string | undefined;
  bootAuditLogger: AuditLogger;
  mainWindow: BrowserWindow;
  openAuthWindowService: (
    parent: BrowserWindow,
    opts: Parameters<PluginHostApi["openAuthWindow"]>[0],
  ) => ReturnType<PluginHostApi["openAuthWindow"]>;
}

export interface InitPluginRuntimeOutput {
  pluginRuntime: PluginRuntime;
  deploymentGuard: PluginDeploymentGuard;
  taskSourceRegistry: TaskSourceRegistry;
  lateBinding: LateBindingRefs;
  pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }>;
  startLoadedPlugins: () => Promise<void>;
}

type CalendarSnapshotEvent = Awaited<ReturnType<PluginHostApi["getCalendarSnapshot"]>>[number];

function isCalendarSnapshotEvent(value: unknown): value is CalendarSnapshotEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.subject === "string" &&
    typeof event.start === "string" &&
    typeof event.end === "string" &&
    (event.isAllDay === undefined || typeof event.isAllDay === "boolean") &&
    (event.location === undefined || typeof event.location === "string") &&
    (event.isOnlineMeeting === undefined || typeof event.isOnlineMeeting === "boolean")
  );
}

export async function resolveBundledManifestPaths(projectRoot: string): Promise<string[]> {
  const marketplacePath = resolve(projectRoot, "plugins/marketplace.json");
  try {
    const raw = await readFile(marketplacePath, "utf-8");
    const parsed = JSON.parse(raw) as { plugins?: Array<{ deployment?: string; packageSpec?: string }> };
    const manifests: string[] = [];
    for (const plugin of parsed.plugins ?? []) {
      if (plugin.deployment !== "bundled") continue;
      if (typeof plugin.packageSpec !== "string" || !plugin.packageSpec.startsWith("file:")) continue;
      const packageDir = resolve(projectRoot, plugin.packageSpec.slice("file:".length));
      manifests.push(resolve(packageDir, "plugin.json"));
    }
    return manifests;
  } catch (err) {
    console.warn(`[lvis] boot: bundled manifest discovery failed:`, (err as Error).message);
    return [];
  }
}

/**
 * §4.2 Step 3-5 — construct PluginRuntime, register the per-plugin HostApi
 * factory, eagerly load manifests, and return a starter so boot.ts can start
 * plugins only after generic RoutineEngine subscriptions exist.
 */
export async function initPluginRuntime(
  input: InitPluginRuntimeInput,
): Promise<InitPluginRuntimeOutput> {
  const {
    projectRoot,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    taskService,
    msGraphService,
    pythonPath,
    bootAuditLogger,
    mainWindow,
    openAuthWindowService,
  } = input;

  // Plugin shutdown handler registry — fires on before-quit (see Sprint 1-A A3).
  const pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }> = [];
  let pluginShutdownRan = false;
  app.prependOnceListener("before-quit", (event) => {
    if (pluginShutdownHandlers.length === 0 || pluginShutdownRan) return;
    pluginShutdownRan = true;
    const SHUTDOWN_TIMEOUT_MS = 5000;
    event.preventDefault();
    void (async () => {
      await Promise.allSettled(
        pluginShutdownHandlers.map(async ({ pluginId, handler }) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => handler()),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("shutdown handler timeout")), SHUTDOWN_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            console.warn(`[plugin:${pluginId}] shutdown handler error:`, (err as Error).message);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
      app.quit();
    })();
  });

  // TaskSource 자기 등록 레지스트리
  const taskSourceRegistry = new TaskSourceRegistry();

  // 범용 configOverrides + pythonExecutable 선언형 주입
  const configOverrides = buildPluginConfigOverrides(settingsService);
  if (pythonPath) {
    configOverrides["*"] = {
      ...(configOverrides["*"] ?? {}),
      pythonExecutable: pythonPath,
    };
  }

  // §7.2 Plugin Deployment Guard
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    userInstalledDir: resolve(homedir(), ".lvis/plugins"),
  });

  // Late-binding refs for ConversationLoop-dependent callers.
  const lateBinding: LateBindingRefs = {
    llmCallerRef: { fn: null },
    pluginCallLlmRef: { fn: null },
    conversationLoopRef: { fn: null },
  };

  // Sprint 4-B §B-4 — signature verifier wired end-to-end.
  if (app.isPackaged && process.env.LVIS_DEV_SKIP_SIG) {
    console.error("[lvis] LVIS_DEV_SKIP_SIG ignored in packaged build");
  }
  const skipSig = !app.isPackaged && process.env.LVIS_DEV_SKIP_SIG === "1";
  const signatureVerifier = skipSig
    ? undefined
    : new PluginSignatureVerifier({
        publisherPublicKeysPem: BUNDLED_PUBLISHER_PUBLIC_KEYS,
      });
  if (skipSig) {
    console.warn("[lvis] boot: LVIS_DEV_SKIP_SIG=1 — plugin signature verification disabled (dev-only)");
  }

  // Capability gate helper (§B-5) — msGraph HostApi methods.
  // Note: hasMsGraphCapability now uses the manifest passed directly to createHostApi
  // to avoid a timing bug where getPluginManifest() returns undefined during createPlugin().
  let pluginRuntime!: PluginRuntime;
  const capabilityDeniedMsg = (pluginId: string) =>
    `[plugin:${pluginId}] capability not declared: ms-graph-consumer`;
  const hasMsGraphCapability = (manifest: PluginManifest): boolean =>
    manifest.capabilities?.includes("ms-graph-consumer") ?? false;
  const bundledManifestPaths = await resolveBundledManifestPaths(projectRoot);

  pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    manifestPaths: bundledManifestPaths,
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    configOverrides,
    deploymentGuard,
    signatureVerifier,
    auditLog: (level, message, data) => {
      try {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "plugin-runtime",
          type: level === "error" ? "error" : "tool_call",
          input: `[${level.toUpperCase()}] ${message}`,
          output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
        });
      } catch {}
    },
    onDisable: (pluginId) => {
      keywordEngine.unregisterByPlugin(pluginId);
      toolRegistry.unregisterByPlugin(pluginId);
      lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
    },
    createHostApi: (pluginId: string, manifest: PluginManifest): PluginHostApi => ({
      registerKeywords: (keywords) => {
        keywordEngine.registerKeywords(
          keywords.map((k) => ({ ...k, pluginId })),
        );
        console.log(`[lvis] plugin:${pluginId} registered ${keywords.length} keywords`);
      },
      emitEvent: (type, data) => {
        if (manifest.emittedEvents?.length && !manifest.emittedEvents.includes(type)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] plugin_emit_undeclared_event eventType=${type} declared=${manifest.emittedEvents.join("|")}`,
            });
          } catch { /* audit must not break host */ }
          console.warn(
            `[lvis] plugin:${pluginId} emitEvent('${type}') dropped — not declared in emittedEvents`,
          );
          return;
        }
        const requiredCap = requiredCapabilityForEmit(type);
        if (requiredCap) {
          const manifest = pluginRuntime?.getPluginManifest(pluginId);
          if (!manifest?.capabilities?.includes(requiredCap)) {
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "error",
                input: `[plugin:${pluginId}] plugin_emit_capability_denied eventType=${type} required=${requiredCap} actual=${(manifest?.capabilities ?? []).join("|")}`,
              });
            } catch { /* audit must not break host */ }
            console.warn(
              `[lvis] plugin:${pluginId} emitEvent('${type}') dropped — missing capability '${requiredCap}'`,
            );
            return;
          }
        }
        emitEvent(type, { pluginId, ...((data as Record<string, unknown>) ?? {}) });
      },
      onEvent: (type, handler) => {
        const unsubscribe = onEvent(type, handler);
        pluginRuntime.registerDisposer(pluginId, unsubscribe);
        return unsubscribe;
      },
      getCalendarSnapshot: async (options) => {
        const providerId = pluginRuntime.findPluginIdByCapability("calendar-source");
        if (!providerId) {
          throw new Error("No plugin provides capability: calendar-source");
        }
        const providerManifest = pluginRuntime.getPluginManifest(providerId);
        if (!providerManifest) {
          throw new Error("Calendar provider manifest missing");
        }
        const days = options?.days ?? 1;
        const toolName = days > 1 ? "calendar_list" : "calendar_today";
        if (!providerManifest.tools.includes(toolName)) {
          throw new Error(`No calendar snapshot tool available for days=${days}`);
        }
        const payload = days > 1 ? { days } : {};
        const result = await pluginRuntime.call(toolName, payload);
        if (!Array.isArray(result) || !result.every(isCalendarSnapshotEvent)) {
          throw new Error(`Calendar snapshot provider returned invalid payload for ${toolName}`);
        }
        return result;
      },
      addTask: (task) => {
        const categoryId = deriveCategoryId(pluginId, task.source);
        taskSourceRegistry.register({ id: categoryId, origin: "plugin", pluginId });
        taskService.add({
          title: task.title,
          description: task.description,
          source: categoryId,
          sourceRef: task.sourceRef,
          priority: task.priority ?? "medium",
          status: "pending",
        });
        console.log(`[lvis] plugin:${pluginId} created task: "${task.title.slice(0, 50)}"`);
      },
      saveNote: async (title, content) => {
        await memoryManager.saveNote(title, content);
        console.log(`[lvis] plugin:${pluginId} saved note: "${title}"`);
      },
      getSecret: (key) => {
        return settingsService.getSecret(key);
      },
      getMsGraphToken: () => {
        if (!hasMsGraphCapability(manifest)) throw new Error(capabilityDeniedMsg(pluginId));
        return msGraphService.getAccessToken();
      },
      startMsGraphAuth: async (openBrowser) => {
        if (!hasMsGraphCapability(manifest)) throw new Error(capabilityDeniedMsg(pluginId));
        await msGraphService.startInteractiveAuth(openBrowser);
      },
      isMsGraphAuthenticated: () => {
        if (!hasMsGraphCapability(manifest)) throw new Error(capabilityDeniedMsg(pluginId));
        return msGraphService.isAuthenticated();
      },
      getMsGraphAccount: () => {
        if (!hasMsGraphCapability(manifest)) throw new Error(capabilityDeniedMsg(pluginId));
        return msGraphService.getAccountName();
      },
      onMsGraphAuthChange: (handler) => {
        if (!hasMsGraphCapability(manifest)) throw new Error(capabilityDeniedMsg(pluginId));
        msGraphService.onAuthChange(handler);
      },
      withMsGraphRetry: async (fn) => {
        if (!hasMsGraphCapability(manifest)) throw new Error(capabilityDeniedMsg(pluginId));
        return withMsGraphRetry(fn, () => msGraphService.getAccessToken());
      },
      callLlm: async (prompt, opts) => {
        if (lateBinding.pluginCallLlmRef.fn) {
          return lateBinding.pluginCallLlmRef.fn(pluginId, prompt, opts);
        }
        if (!lateBinding.llmCallerRef.fn) throw new Error("LLM provider not ready");
        return lateBinding.llmCallerRef.fn(prompt, opts);
      },
      logEvent: (level, message, data) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: level === "error" ? "error" : "tool_call",
            input: `[plugin:${pluginId}] [${level.toUpperCase()}] ${message}`,
            output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
          });
        } catch (err) {
          console.warn(`[plugin:${pluginId}] logEvent failed:`, (err as Error).message);
        }
      },
      onShutdown: (handler) => {
        pluginShutdownHandlers.push({ pluginId, handler });
      },
      // ─── 외부 포털 interactive 인증 (쿠키 수집) ───────────────────
      // `external-auth-consumer` capability 로 게이팅 — 쿠키는 민감 자산이므로
      // 선언적 opt-in 없이는 호출 거부. 거부/허용 모두 AuditLogger 에 남긴다.
      //
      // 로그에는 origin + path 만 기록 — SAML/OAuth URL 에 담기는 민감 query
      // (SAMLRequest, code, state, session id 등) 은 유출 방지 위해 제외.
      openAuthWindow: async (opts) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        const cookieHostCount = Array.isArray(opts.cookieHosts) ? opts.cookieHosts.length : 0;

        if (!manifest.capabilities?.includes("external-auth-consumer")) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_window_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }

        console.log(
          `[lvis] plugin:${pluginId} openAuthWindow url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
        );
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input:
              `[plugin:${pluginId}] openAuthWindow ` +
              `url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
          });
        } catch { /* audit must not break host */ }

        // 기본값은 plugin 별 비영속 partition. Electron 의 default session 을
        // 쓰면 (a) 여러 BrowserWindow 간 쿠키가 공유되어 타 플러그인이
        // 수집한 세션을 그대로 볼 수 있고 (b) 디스크에 영속화된다. 둘 다
        // openAuthWindow 의 "호스트는 세션을 보관하지 않는다" 원칙 위반.
        //
        // 플러그인이 명시적으로 지정한 persistPartition 은 반드시 자기
        // 네임스페이스(`persist:plugin-auth:<pluginId>` 또는 그 하위 `:<sub>`)
        // 여야 한다. 그렇지 않으면 plugin A 가 `plugin-auth:pluginB` 를 지정해
        // plugin B 의 쿠키를 읽어가는 cross-plugin exfiltration 경로가 열린다.
        const encodedId = encodeURIComponent(pluginId);
        const defaultPartition = `plugin-auth:${encodedId}`;
        const allowedPersistBase = `persist:${defaultPartition}`;
        const requested = opts.persistPartition;
        if (
          requested !== undefined &&
          requested !== allowedPersistBase &&
          !requested.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] open_auth_window_invalid_partition ` +
                `persistPartition=${requested} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthWindow: persistPartition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        const effectiveOpts = requested
          ? opts
          : { ...opts, persistPartition: defaultPartition };
        return openAuthWindowService(mainWindow, effectiveOpts);
      },
    }),
  });

  await pluginRuntime.load();

  let pluginsStarted = false;
  let pluginDevWatcher:
    | ReturnType<typeof startPluginDevWatcher>
    | undefined;
  const startLoadedPlugins = async (): Promise<void> => {
    if (pluginsStarted) return;
    pluginsStarted = true;

    await pluginRuntime.startAll();
    console.log("[lvis] boot: plugins loaded:", pluginRuntime.listToolNames());

    runManifestStartupTools(pluginRuntime);
    registerPluginTools(pluginRuntime, toolRegistry);

    pluginDevWatcher = startPluginDevWatcher({
      pluginRuntime,
      onReloaded: (pluginId) => {
        const manifest = pluginRuntime.getPluginManifest(pluginId);
        if (!manifest) return;
        registerPluginTools(pluginRuntime, toolRegistry);
        console.log(`[lvis] plugin:${pluginId} hot-reloaded (${manifest.tools.length} tools)`);
      },
    });
    app.prependOnceListener("before-quit", () => {
      pluginDevWatcher?.stop();
    });
  };

  return {
    pluginRuntime,
    deploymentGuard,
    taskSourceRegistry,
    lateBinding,
    pluginShutdownHandlers,
    startLoadedPlugins,
  };
}

// Re-export so boot.ts's return statement can still reach BrowserWindow type.
export type { BrowserWindow };
