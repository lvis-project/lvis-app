/**
 * Boot Sequence — §4.2
 *
 * 앱 시작 시 실행되는 초기화 파이프라인. Thin orchestrator —
 * 세부 로직은 src/boot/*.ts 모듈에 분리되어 있다.
 * 플러그인 특정 코드 없음 — 모든 플러그인은 HostApi를 통해 자기 등록.
 */
import { resolve } from "node:path";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { AuditLogger } from "./audit/audit-logger.js";
import { PluginRuntime } from "./plugins/runtime.js";
import { startPluginDevWatcher } from "./plugins/dev-watcher.js";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "./plugins/marketplace.js";
import type { MarketplaceFetcher } from "./plugins/marketplace.js";
import { PluginUpdateDetector, isUpdateCheckEnabled } from "./plugins/update-detector.js";
import { RealCloudMarketplaceFetcher } from "./plugins/real-cloud-marketplace-fetcher.js";
import { PluginDeploymentGuard } from "./plugins/deployment-guard.js";
import { PluginSignatureVerifier } from "./plugins/signature-verifier.js";
import { BUNDLED_PUBLISHER_PUBLIC_KEYS } from "./plugins/publisher-keys.js";
import { StarredStore } from "./data/starred-store.js";
import { FeedbackStore } from "./data/feedback-store.js";
import { McpGovernance } from "./mcp/mcp-governance.js";
import { McpManager } from "./mcp/mcp-manager.js";
import type { PluginHostApi } from "./plugins/types.js";
import { requiredCapabilityForEmit } from "./plugins/capabilities.js";
import { withMsGraphRetry } from "./main/ms-graph-retry.js";
import { TaskSourceRegistry, deriveCategoryId } from "./plugins/task-source-registry.js";

import { emitEvent, onEvent, type AppServices } from "./boot/types.js";
import { bootstrapCoreServices } from "./boot/services.js";
import { createAutoUpdater } from "./main/auto-updater.js";
import { startCrashReporter } from "./main/crash-reporter.js";
import { TelemetryService } from "./main/telemetry.js";
import { PluginTelemetryClient } from "./telemetry/client.js";
import {
  buildPluginConfigOverrides,
  registerPluginTools,
  runManifestStartupTools,
  registerPluginNotifications,
} from "./boot/plugins.js";
import {
  registerBuiltinTools,
  registerRequestPluginMetaTool,
  wireKnowledgeAndIdleScheduler,
} from "./boot/tools.js";
import {
  createProactiveEngine,
  createProactiveTriggerCoordinator,
  loadCalendarToday,
  loadWeeklyCalendarIfMonday,
} from "./boot/proactive.js";
import {
  createSystemPromptBuilder,
  createPermissionManager,
  createPostTurnHookChain,
  createApprovalGate,
  createHookRunner,
  createConversationLoop,
  createCallLlm,
  createCallLlmForPlugin,
} from "./boot/conversation.js";

export type { AppServices } from "./boot/types.js";

export async function bootstrap(projectRoot: string, mainWindow: BrowserWindow): Promise<AppServices> {
  console.log("[lvis] boot: starting...");

  // §4.2 Step 0–1+5: Core services (python, ms-graph, audit, settings, memory,
  // keyword/route/tool registry + BashTool, task service).
  const core = await bootstrapCoreServices(mainWindow);
  const {
    pythonPath,
    bashAstValidator,
    msGraphService,
    auditService,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    routeEngine,
    taskService,
  } = core;

  // Sprint 1-A A3 — AuditLogger is created before PluginRuntime so the
  // per-plugin HostApi.logEvent can route through it. Previously it was
  // instantiated later (near PostTurnHookChain); we now share this instance.
  const bootAuditLogger = new AuditLogger();

  // Sprint 1-A A3 — plugin shutdown handler registry. Runs all handlers in
  // parallel with a 5s per-handler timeout. Uses `prependOnceListener` so
  // plugin onShutdown fires BEFORE main.ts's pluginRuntime.stopAll(), and the
  // handler awaits completion via `event.preventDefault()` + `app.quit()` so
  // plugins actually finish their cleanup instead of racing shutdown.
  // Copilot review: previous fire-and-forget `void` path allowed quit to
  // proceed before handlers finished and ordered them after stop().
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

  // TaskSource 자기 등록 레지스트리 — 플러그인이 addTask 시 자동 등록
  const taskSourceRegistry = new TaskSourceRegistry();

  // §4.2 Step 3-4: 플러그인 초기화 (범용 — 플러그인 특정 코드 없음)
  // API 키를 플러그인에 범용적으로 전달
  const configOverrides = buildPluginConfigOverrides(settingsService);

  // pythonExecutable 주입 (Agent 1 산출물)
  // 특정 플러그인 id 하드코딩 없이 모든 플러그인에 선언형으로 주입한다.
  if (pythonPath) {
    configOverrides["*"] = {
      ...(configOverrides["*"] ?? {}),
      pythonExecutable: pythonPath,
    };
  }

  // §7.2 Plugin Deployment Guard — managed 플러그인 사용자 제거/비활성화 차단.
  // userInstalledDir 밖에 있는 모든 플러그인(번들/IT-push)은 default-deny.
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    userInstalledDir: resolve(projectRoot, "plugins/installed"),
  });

  // Late-binding refs — conversationLoop은 pluginRuntime 이후에 생성되므로
  // pluginRuntime 구성 시점에는 null로 시작하고, conversationLoop 생성 직후 주입한다.
  //   - llmCallerRef: 플러그인 callLlm()의 LLM 진입점
  //   - conversationLoopRef: onDisable 콜백이 conversationLoop에 접근하기 위한 핸들
  const llmCallerRef: {
    fn: ((prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>) | null;
  } = { fn: null };
  // Sprint 4-B §B-7 — plugin-scoped callLlm with per-plugin rate-limit + audit.
  // Late-bound like llmCallerRef; plugin HostApi routes through this when set.
  const pluginCallLlmRef: {
    fn:
      | ((
          pluginId: string,
          prompt: string,
          opts?: { maxTokens?: number; systemPrompt?: string },
        ) => Promise<string>)
      | null;
  } = { fn: null };
  let conversationLoopRef: import("./engine/conversation-loop.js").ConversationLoop | null = null;

  // Sprint 4-B §B-4 — signature verifier wired end-to-end.
  // Dev escape hatch LVIS_DEV_SKIP_SIG=1 disables the verifier entirely (so
  // managed plugins still load without a .sig during local development).
  // TODO(production): ship production publisher public key + enforce in CI.
  // H1: packaged builds MUST ignore LVIS_DEV_SKIP_SIG. The escape hatch is
  // only honored when app.isPackaged === false (dev / test). If the env var
  // is present in a packaged build, log an error so operators see the attempt.
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

  // Capability gate helper (§B-5) — msGraph HostApi methods are only callable
  // by plugins that declare `ms-graph-consumer` in manifest.capabilities.
  // Forward-declared here so createHostApi (which runs per-plugin at load
  // time, AFTER the manifest is registered) can query the live pluginRuntime.
  let pluginRuntime: PluginRuntime;
  const capabilityDeniedMsg = (pluginId: string) =>
    `[plugin:${pluginId}] capability not declared: ms-graph-consumer`;
  const hasMsGraphCapability = (pluginId: string): boolean => {
    const manifest = pluginRuntime?.getPluginManifest(pluginId);
    return manifest?.capabilities?.includes("ms-graph-consumer") ?? false;
  };

  pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
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
      conversationLoopRef?.onPluginDisabled(pluginId);
    },
    // 플러그인별 스코프된 HostApi 팩토리
    createHostApi: (pluginId: string): PluginHostApi => ({
      registerKeywords: (keywords) => {
        // Phase 1 Lazy Tool Scoping — plugin 호출 경로에서 pluginId 자동 주입.
        // 플러그인 소스는 수정하지 않고 host가 origin을 tag한다.
        keywordEngine.registerKeywords(
          keywords.map((k) => ({ ...k, pluginId })),
        );
        console.log(`[lvis] plugin:${pluginId} registered ${keywords.length} keywords`);
      },
      emitEvent: (type, data) => {
        // Phase 5 — capability gate on event emission.
        // Plugins emitting email.*/calendar.*/meeting.*/index.* must declare
        // the corresponding capability; otherwise the event is dropped + warned.
        const requiredCap = requiredCapabilityForEmit(type);
        if (requiredCap) {
          const manifest = pluginRuntime?.getPluginManifest(pluginId);
          if (!manifest?.capabilities?.includes(requiredCap)) {
            // M4: audit-log capability violations so operators see attempts.
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
        // Track per-plugin so PluginRuntime.disable() can scrub handlers
        // alongside keyword / tool / scope cleanup.
        pluginRuntime.registerDisposer(pluginId, unsubscribe);
        return unsubscribe;
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
      // ─── Microsoft Graph 공유 인증 (§B-5: capability-gated) ──────────
      getMsGraphToken: () => {
        if (!hasMsGraphCapability(pluginId)) throw new Error(capabilityDeniedMsg(pluginId));
        return msGraphService.getAccessToken();
      },
      startMsGraphAuth: async (openBrowser) => {
        if (!hasMsGraphCapability(pluginId)) throw new Error(capabilityDeniedMsg(pluginId));
        await msGraphService.startInteractiveAuth(openBrowser);
      },
      isMsGraphAuthenticated: () => {
        if (!hasMsGraphCapability(pluginId)) throw new Error(capabilityDeniedMsg(pluginId));
        return msGraphService.isAuthenticated();
      },
      getMsGraphAccount: () => {
        if (!hasMsGraphCapability(pluginId)) throw new Error(capabilityDeniedMsg(pluginId));
        return msGraphService.getAccountName();
      },
      onMsGraphAuthChange: (handler) => {
        if (!hasMsGraphCapability(pluginId)) throw new Error(capabilityDeniedMsg(pluginId));
        msGraphService.onAuthChange(handler);
      },
      withMsGraphRetry: async (fn) => {
        if (!hasMsGraphCapability(pluginId)) throw new Error(capabilityDeniedMsg(pluginId));
        return withMsGraphRetry(fn, () => msGraphService.getAccessToken());
      },
      callLlm: async (prompt, opts) => {
        // Sprint 4-B §B-7 — rate-limited + audited path; fall back to the
        // raw llmCallerRef only if the plugin-scoped ref hasn't been wired yet
        // (e.g. during early startup before conversationLoop construction).
        if (pluginCallLlmRef.fn) return pluginCallLlmRef.fn(pluginId, prompt, opts);
        if (!llmCallerRef.fn) throw new Error("LLM provider not ready");
        return llmCallerRef.fn(prompt, opts);
      },
      // Sprint 1-A A3 — structured log event → AuditLogger (plugin context).
      logEvent: (level, message, data) => {
        // AuditLogEntry.type is a fixed enum — "error" for error level,
        // "tool_call" otherwise. Level is encoded as a [LEVEL] tag in
        // `input` so downstream viewers can still distinguish info/warn.
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
      // Sprint 1-A A3 — shutdown handler registration (fires on before-quit).
      onShutdown: (handler) => {
        pluginShutdownHandlers.push({ pluginId, handler });
      },
    }),
  });

  await pluginRuntime.startAll();
  console.log("[lvis] boot: plugins loaded:", pluginRuntime.listToolNames());

  // 선언형 startupTools 자동 실행 (플러그인별 watcher/bootstrap 훅)
  runManifestStartupTools(pluginRuntime);

  // 플러그인 메서드를 ToolRegistry에 등록 (범용)
  registerPluginTools(pluginRuntime, toolRegistry);

  // I2 — Dev-mode plugin live-reload watcher. No-op unless LVIS_DEV_RELOAD=1.
  // After a successful reload the plugin's tools are re-registered into the
  // canonical ToolRegistry so conversationLoop sees the fresh handler.
  const pluginDevWatcher = startPluginDevWatcher({
    pluginRuntime,
    onReloaded: (pluginId) => {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (!manifest) return;
      // onDisable already scrubbed the toolRegistry during reload; re-register.
      registerPluginTools(pluginRuntime, toolRegistry);
      console.log(`[lvis] plugin:${pluginId} hot-reloaded (${manifest.tools.length} tools)`);
    },
  });
  app.prependOnceListener("before-quit", () => { pluginDevWatcher.stop(); });

  // 빌트인 도구 등록 (호스트 자체 기능)
  registerBuiltinTools(memoryManager, toolRegistry, settingsService);

  // Phase 1.5 Option C — request_plugin 메타 툴 (항상 활성, scope filter 통과)
  registerRequestPluginMetaTool(toolRegistry);

  // §4.4 HybridRetriever + Knowledge Tools DI (Agent 3 산출물 연결)
  // §6.1 IdleSchedulerService 배선 (Agent 5 산출물)
  const { idleScheduler, knowledgeAvailable } = await wireKnowledgeAndIdleScheduler({
    pluginRuntime,
    toolRegistry,
    auditService,
  });

  // §9.5 M4: select marketplace backend from settings (default = mock local JSON).
  const marketplaceSettings = settingsService.get("marketplace");
  let marketplaceFetcher: MarketplaceFetcher;
  if (
    marketplaceSettings.backend === "real-cloud" &&
    marketplaceSettings.realCloudBaseUrl
  ) {
    marketplaceFetcher = new RealCloudMarketplaceFetcher({
      baseUrl: marketplaceSettings.realCloudBaseUrl,
      apiKey: settingsService.getSecret("marketplace.apiKey") ?? undefined,
      allowPrivateNetwork: marketplaceSettings.realCloudAllowPrivateNetwork,
    });
    console.log("[lvis] boot: marketplace backend = real-cloud (%s)", marketplaceSettings.realCloudBaseUrl);
  } else {
    marketplaceFetcher = new MockMarketplaceFetcher(
      resolve(projectRoot, "plugins/marketplace.json"),
    );
  }
  const pluginMarketplace = new PluginMarketplaceService(
    projectRoot,
    deploymentGuard,
    marketplaceFetcher,
  );

  // §4.5.9: SystemPromptBuilder
  const systemPromptBuilder = createSystemPromptBuilder({
    memoryManager, toolRegistry, pluginRuntime,
  });

  // §6.3: PermissionManager (Layer 2-3)
  const permissionManager = await createPermissionManager();

  // §7: Proactive Engine (Daily Briefing) — event subscriptions + hints.
  // Sprint 2-D: wire 5 gating deps — feature flag, LLM caller, date persistence,
  // dismissal state. `callLlm` uses late-bound llmCallerRef (same entrypoint as
  // plugin HostApi.callLlm), so briefing generation reuses the ConversationLoop
  // LLM path once conversationLoop has been constructed below.
  const proactiveEngine = createProactiveEngine({
    taskService,
    memoryManager,
    pluginRuntime,
    isDailyBriefingEnabled: () =>
      settingsService.get("proactive")?.enableDailyBriefing ?? false,
    callLlm: async (prompt, opts) => {
      if (!llmCallerRef.fn) throw new Error("LLM provider not ready");
      return llmCallerRef.fn(prompt, opts);
    },
    getLastBriefingDate: () => settingsService.get("proactive")?.lastBriefingAt,
    setLastBriefingDate: (dateKst) => {
      const cur = settingsService.get("proactive") ?? { enableDailyBriefing: false };
      settingsService.patch({ proactive: { ...cur, lastBriefingAt: dateKst } });
    },
    getLastDismissedAt: () => settingsService.get("proactive")?.lastDismissedAt,
    auditLogger: bootAuditLogger,
  });

  // Sprint 3-A-2: ProactiveTriggerCoordinator — condition-based heartbeat
  // (schedule / meeting / task-deadline / idle). Flag default OFF via proactive
  // settings; kill-switch DISABLE_PROACTIVE_COORDINATOR=1. Idle path above
  // remains wired for back-compat; coordinator idleSignal fires in parallel
  // but engine-level debounce (30min) + once-per-day gate collapse duplicates.
  let proactiveScheduleLastDay: string | undefined;
  const proactiveCoordinator = createProactiveTriggerCoordinator({
    proactiveEngine,
    taskService,
    pluginRuntime,
    isIdleScanActive: () => idleScheduler?.getState() === "IDLE_SCAN",
    isScheduleEnabled: () =>
      settingsService.get("proactive")?.enableDailyBriefing ?? false,
    // Issue 3 fix: separate post-turn flag; default false.
    isPostTurnEnabled: () =>
      settingsService.get("proactive")?.enablePostTurnBriefing ?? false,
    getScheduleLastFiredDayKey: () => proactiveScheduleLastDay,
    setScheduleLastFiredDayKey: (key) => { proactiveScheduleLastDay = key; },
  });
  proactiveCoordinator.start();
  if (idleScheduler) {
    const existing = idleScheduler;
    // Chain: keep existing state listener and also notify coordinator.
    const notifyCoordinator = (state: import("./main/idle-scheduler.js").IdleState) => {
      if (state === "IDLE_SCAN") proactiveCoordinator.notify("idle-scan");
    };
    // PR#44 Copilot: setStateChangeListener accepts only one listener; this
    // `composite` IS the idle-scheduler wiring for proactive — it fans the
    // IDLE_SCAN signal into (a) direct briefing generation and (b) the
    // coordinator notifier above.
    const composite = (
      newState: import("./main/idle-scheduler.js").IdleState,
      oldState: import("./main/idle-scheduler.js").IdleState,
      reason: string,
    ): void => {
      if (newState === "IDLE_SCAN" && !proactiveCoordinator.isWithinGlobalCooldown()) {
        proactiveEngine
          .generateDailyBriefing({ idleState: "long_idle" })
          .then((r) => {
            if (r.status === "generated") {
              const win = mainWindow;
              if (!win.isDestroyed()) {
                try {
                  win.webContents.send("lvis:proactive:briefing", r.briefing);
                } catch (e) {
                  console.warn("[lvis] boot: briefing webContents.send failed:", (e as Error).message);
                }
              }
            }
          })
          .catch((e: Error) =>
            console.warn("[lvis] boot: daily briefing trigger failed (non-fatal):", e.message),
          );
      }
      notifyCoordinator(newState);
      void oldState; void reason;
    };
    existing.setStateChangeListener(composite);
  }

  // 오늘 일정 초기 로드 (calendar-source capability 플러그인에서 *_today 메서드 자동 탐색)
  loadCalendarToday(pluginRuntime, proactiveEngine);

  // §35 — Forward plugin events from main-process event bus → renderer.
  // Issue 4: Coalescing wrapper for high-frequency transcript events.
  //   Events matching *.transcript.updated are coalesced: rapid non-final events
  //   are debounced (100ms), final events flush immediately. Non-transcript events
  //   pass through unchanged. Generic — no plugin-id hardcode.
  // Issue 5: Tie subscription lifecycle to the window (closed event) rather than
  //   app before-quit so re-created windows (macOS activate) get a fresh bridge.

  /** True if the event type is a high-frequency transcript stream event. */
  function isTranscriptEvent(type: string): boolean {
    return type.endsWith(".transcript.updated");
  }

  /** Build a coalescing send wrapper for a given event type + window. */
  function makeCoalescingSend(
    type: string,
    getWin: () => import("electron").BrowserWindow,
  ): (data: unknown) => void {
    let lastData: unknown = undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = (data: unknown) => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      const win = getWin();
      if (win.isDestroyed()) return;
      try {
        win.webContents.send("lvis:plugin:event", type, data);
      } catch (e) {
        console.warn(`[lvis] boot: ${type} send failed:`, (e as Error).message);
      }
    };

    return (data: unknown) => {
      const payload = data as Record<string, unknown> | undefined;
      const isFinal = payload?.isFinal === true;
      if (isFinal) {
        // Final event: flush immediately with this data (skip any pending debounce).
        flush(data);
        lastData = undefined;
      } else {
        // Non-final: store latest and schedule a 100ms coalesced flush.
        lastData = data;
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            if (lastData !== undefined) flush(lastData);
          }, 100);
        }
      }
    };
  }

  // Collect event types declared by plugin manifests (notificationEvents + emittedEvents
  // where available). Always include meeting.transcript.updated for back-compat.
  function collectPluginEventTypes(): Set<string> {
    const types = new Set<string>(["meeting.transcript.updated"]);
    for (const { manifest } of pluginRuntime.listPluginManifests()) {
      // manifest.emittedEvents may be present in plugin.json even if not in the TS type
      const raw = manifest as unknown as Record<string, unknown>;
      if (Array.isArray(raw["emittedEvents"])) {
        for (const t of raw["emittedEvents"] as unknown[]) {
          if (typeof t === "string" && t.trim()) types.add(t.trim());
        }
      }
    }
    return types;
  }

  // Register the plugin event bridge for the current window.
  // Returns an unsubscribeAll disposer. Called once on boot, and again if the
  // window is recreated on macOS (activate event).
  function registerPluginEventBridge(win: import("electron").BrowserWindow): () => void {
    const unsubs: Array<() => void> = [];
    const eventTypes = collectPluginEventTypes();

    for (const type of eventTypes) {
      const sendFn = isTranscriptEvent(type)
        ? makeCoalescingSend(type, () => win)
        : (data: unknown) => {
            if (win.isDestroyed()) return;
            try {
              win.webContents.send("lvis:plugin:event", type, data);
            } catch (e) {
              console.warn(`[lvis] boot: ${type} send failed:`, (e as Error).message);
            }
          };
      unsubs.push(onEvent(type, sendFn));
    }

    const unsubscribeAll = () => { for (const u of unsubs) u(); };
    // Issue 5: tie lifecycle to window closed, not app before-quit.
    win.once("closed", unsubscribeAll);
    return unsubscribeAll;
  }

  // manifest.notificationEvents 선언 기반 OS 알림 등록 (플러그인 무관)
  let disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow);

  // manifest.emittedEvents 선언 기반 renderer 이벤트 브릿지 (플러그인 특정 코드 없음)
  // §1: boot.ts에 plugin ID / event literal 하드코딩 금지 — manifest-driven generic bridge.
  let disposePluginEventBridge = registerPluginEventBridge(mainWindow);

  // §4.5 + Agent 6: PostTurnHookChain 조립 (shares bootAuditLogger from A3 wiring)
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager,
    idleScheduler,
    settingsService,
    auditLogger: bootAuditLogger,
  });

  // B1: Policy 로드 후 ApprovalGate 생성 — mainWindow.webContents 준비 후
  // §F7: bootAuditLogger 주입 → requested/decided/timeout/send-failed 4 phase 감사
  const approvalGate = await createApprovalGate(mainWindow, bootAuditLogger);

  // Tier A4 (W3): external hook executor 부착된 HookRunner
  const hookRunner = createHookRunner();

  // §4.5: ConversationLoop
  const conversationLoop = createConversationLoop({
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
    permissionManager,
    proactiveEngine,
    idleScheduler,
    postTurnHookChain,
    bashAstValidator,
    approvalGate,
    hookRunner,
    pluginRuntime,
  });

  // Late-binding 주입 — 두 ref 모두 여기서 채워진다.
  conversationLoopRef = conversationLoop;
  llmCallerRef.fn = createCallLlm(conversationLoop);
  // Sprint 4-B §B-7 — plugin-scoped callLlm with rate-limit + audit.
  pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger);
  console.log("[lvis] boot: plugin callLlm ready (rate-limited)");

  // Feature 4: 월요일 주간 일정 캐시 로드 (KST 기준)
  loadWeeklyCalendarIfMonday(pluginRuntime, proactiveEngine);

  // §9.5: MCP Server 연결 (거버넌스 승인 서버만)
  const mcpGovernance = new McpGovernance();
  const mcpManager = new McpManager(mcpGovernance, toolRegistry);
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      console.log("[lvis] boot: MCP servers connected");
    }
  } catch (err) {
    console.warn("[lvis] boot: MCP initialization failed (non-fatal):", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh();

  console.log("[lvis] boot: ready (%d tools, %d plugins, %d mcp)", toolRegistry.size, pluginRuntime.listPluginIds().length, mcpManager.listServers().filter(s => s.status === "connected").length);

  // Sprint 4.C — starred messages store (persisted in ~/.lvis/starred.json)
  const starredStore = new StarredStore();
  // D6 privacy hardening — feedback store (persisted in ~/.lvis/feedback.jsonl)
  const feedbackStore = new FeedbackStore();

  // Production release prep — auto-updater, crash reporter, telemetry.
  // All default-off or read user settings; no-op in dev without publish config.
  let telemetry: TelemetryService | undefined;
  let pluginTelemetry: PluginTelemetryClient | undefined;
  let autoUpdaterStop: (() => void) | undefined;
  try {
    startCrashReporter({
      userDataPath: app.getPath("userData"),
      telemetry: settingsService.get("telemetry"),
    });
    telemetry = new TelemetryService({
      // Accessor form — re-reads settings each flush so user toggles apply live.
      settings: () => settingsService.get("telemetry"),
      appVersion: app.getVersion(),
      // M2: endpoint validation (https + allowlist; localhost blocked when packaged).
      isPackaged: app.isPackaged,
      auditLogger: bootAuditLogger,
    });
    telemetry.start();
    telemetry.track("app_start");

    // S12 — plugin lifecycle telemetry (opt-in).
    // First-boot: if user has never answered the consent prompt, emit an IPC
    // event so the renderer can show the "Help improve LVIS?" dialog.
    // MUST check after window is ready; webContents.send is safe here because
    // bootstrap() is called from main.ts only after BrowserWindow is visible.
    const telemetrySettings = settingsService.get("telemetry");
    if (!telemetrySettings.telemetryPromptAnswered) {
      // Defer one tick so the renderer has time to attach its listener.
      setTimeout(() => {
        try {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("lvis:telemetry:consent-prompt");
          }
        } catch (e) {
          console.warn("[lvis] boot: telemetry consent prompt send failed:", (e as Error).message);
        }
      }, 500);
    }
    // S12 — PluginTelemetryClient: batched plugin lifecycle events to marketplace.
    // D6: install_token reuses "marketplace.apiKey" secret (GitHub App token).
    const ptClient = new PluginTelemetryClient({
      settings: () => settingsService.get("telemetry"),
      marketplaceBaseUrl: () => settingsService.get("marketplace").realCloudBaseUrl,
      installToken: () => settingsService.getSecret("marketplace.apiKey"),
      deviceUuidPath: resolve(app.getPath("userData"), ".lvis", "device-uuid"),
    });
    pluginTelemetry = ptClient;
    ptClient.start();

    // Wire plugin lifecycle events → telemetry.
    // Events are emitted by ipc-bridge (install/uninstall) and pluginRuntime (error).
    // We subscribe here rather than in ipc-bridge to keep telemetry out of the
    // IPC layer and to ensure the client is fully constructed before listening.
    onEvent("plugin.installed", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_install", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.uninstalled", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_uninstall", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.updated", (data) => {
      const d = data as { pluginId?: string; version?: string } | undefined;
      ptClient.track("plugin_update", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
      });
    });
    onEvent("plugin.error", (data) => {
      const d = data as { pluginId?: string; version?: string; errorClass?: string } | undefined;
      ptClient.track("plugin_error", {
        slug: d?.pluginId ?? "unknown",
        version: d?.version ?? "unknown",
        errorClass: d?.errorClass,
      });
    });

    // Retain reference for shutdown flush.
    app.prependOnceListener("before-quit", () => {
      try {
        ptClient.stop();
        void ptClient.flush();
      } catch (err) {
        console.warn("[lvis] shutdown: plugin telemetry final flush failed:", (err as Error).message);
      }
    });

    const updater = createAutoUpdater({
      mainWindow,
      isEnabled: () => settingsService.get("updates")?.autoCheckEnabled ?? true,
    });
    updater.start();
    autoUpdaterStop = updater.stop;
    // Retain telemetry + updater-stop on AppServices so main.ts's before-quit
    // path (which already has `services`) can flush + clear the interval.
    const retainedTelemetry = telemetry;
    app.prependOnceListener("before-quit", () => {
      try { autoUpdaterStop?.(); } catch { /* noop */ }
      try {
        retainedTelemetry.stop();
        void retainedTelemetry.flush();
      } catch (err) {
        console.warn("[lvis] shutdown: telemetry final flush failed:", (err as Error).message);
      }
    });
    console.log("[lvis] boot: release prep wired (updater/crash/telemetry)");
  } catch (err) {
    console.warn("[lvis] boot: release prep init failed (non-fatal):", (err as Error).message);
  }

  // S8 — Plugin update detection. Runs once at boot then on a configurable
  // interval (default 6h). Fires IPC event `marketplace:updates-available` to
  // the renderer when newer catalog versions are found.
  // Feature flag: settings.marketplace.updateCheckEnabled (default true).
  // Env var LVIS_MARKETPLACE_UPDATE_CHECK=0 also disables (for CI/testing).
  const updateCheckFeatureEnabled =
    (marketplaceSettings?.updateCheckEnabled ?? true) && isUpdateCheckEnabled();
  let updateCheckTimer: ReturnType<typeof setInterval> | undefined;
  if (updateCheckFeatureEnabled) {
    const registryPath = resolve(projectRoot, "plugins/registry.json");
    const updateDetector = new PluginUpdateDetector(registryPath, marketplaceFetcher, {
      canaryOptIn: marketplaceSettings?.canaryOptIn ?? false,
    });
    const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

    // Track the last broadcast so renderer state stays in sync with the
    // latest check — when a previously-available update is removed (e.g.
    // user upgraded via CLI between checks) the renderer must learn about
    // it instead of seeing stale update banners. Only emit when the current
    // result set differs from the last broadcast, to keep info-level logs
    // quiet on the steady-state "no updates" path.
    let lastBroadcastKey = "";
    const runUpdateCheck = async () => {
      try {
        const updates = await updateDetector.checkForUpdates();
        const key = updates
          .map((u) => `${u.pluginId}@${u.installedVersion}->${u.latestVersion}`)
          .sort()
          .join("|");
        if (key === lastBroadcastKey) {
          // Quiet path — no state change since last check.
          console.debug("[lvis] update-check: no change (%d)", updates.length);
          return;
        }
        lastBroadcastKey = key;
        // Always send the current snapshot (possibly empty) so the renderer
        // can clear stale banners when updates are no longer available.
        mainWindow?.webContents?.send("marketplace:updates-available", updates);
        if (updates.length > 0) {
          console.log("[lvis] update-check: %d plugin update(s) available", updates.length);
        } else {
          console.debug("[lvis] update-check: cleared previous updates");
        }
      } catch (err) {
        console.warn("[lvis] update-check: error:", (err as Error).message);
      }
    };

    // Run once at boot (non-blocking).
    void runUpdateCheck();

    const intervalMs =
      settingsService.get("marketplace")?.updateCheckIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
    if (intervalMs > 0) {
      updateCheckTimer = setInterval(() => void runUpdateCheck(), intervalMs);
      updateCheckTimer.unref?.();
    }

    app.prependOnceListener("before-quit", () => {
      if (updateCheckTimer) clearInterval(updateCheckTimer);
    });
  }

  return {
    pluginRuntime, pluginMarketplace, taskService, taskSourceRegistry, settingsService,
    memoryManager, keywordEngine, routeEngine, toolRegistry,
    systemPromptBuilder, conversationLoop, proactiveEngine, mcpManager,
    idleScheduler, bashAstValidator, auditService, auditLogger: bootAuditLogger, postTurnHookChain,
    approvalGate, knowledgeAvailable, starredStore, feedbackStore,
    telemetry, pluginTelemetry, autoUpdaterStop,
    refreshPluginNotifications: () => {
      disposePluginNotifications();
      disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow);
      disposePluginEventBridge();
      disposePluginEventBridge = registerPluginEventBridge(mainWindow);
    },
    registerPluginEventBridge,
  };
}
