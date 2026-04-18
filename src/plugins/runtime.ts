import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PluginManifest,
  PluginToolHandler,
  PluginUiExtension,
  PluginHostApi,
  RuntimePlugin,
  RuntimePluginFactory,
} from "./types.js";
import { readPluginRegistry, resolveManifestPathsFromRegistry, updatePluginRegistry } from "./registry.js";
import type { Actor, PluginDeploymentGuard } from "./deployment-guard.js";
import type { PluginSignatureVerifier } from "./signature-verifier.js";

type LoadedPlugin = {
  manifest: PluginManifest;
  pluginRoot: string;
  instance: RuntimePlugin;
  methods: Map<string, PluginToolHandler>;
};

/**
 * Phase 1.5 Option C — 비활성 plugin 카탈로그 카드.
 * SystemPromptBuilder가 "사용 가능한 플러그인 (비활성)" 섹션 렌더링,
 * request_plugin 메타 툴이 허용 가능한 pluginId 목록 산출에 사용.
 */
export interface PluginCard {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
}

export interface PluginRuntimeOptions {
  hostRoot: string;
  manifestPaths?: string[];
  registryPath?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  /** 플러그인별 HostApi를 생성하는 팩토리 — boot.ts에서 주입 */
  createHostApi?: (pluginId: string) => PluginHostApi;
  /** Phase 1.5 §7.3: disable 시 managed 플러그인 차단 */
  deploymentGuard?: PluginDeploymentGuard;
  /**
   * Sprint 3-B §9.6: ed25519 manifest signature check. When provided:
   *   - managed plugins whose signature is missing/invalid are dropped.
   *   - user plugins whose signature is missing produce a warning but load.
   *   - user plugins with invalid signatures are dropped.
   * When absent, signatures are not checked (backward compat).
   */
  signatureVerifier?: PluginSignatureVerifier;
  /** Optional sink for signature-related audit events. */
  auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /**
   * HIGH-1: plugin disable 시 호출되는 콜백.
   * keywordEngine.unregisterByPlugin / toolRegistry.unregisterByPlugin /
   * conversationLoop.onPluginDisabled 을 boot.ts에서 주입한다.
   */
  onDisable?: (pluginId: string) => void;
}

export class PluginRuntime {
  private readonly hostRoot: string;
  private readonly manifestPaths: string[];
  private readonly registryPath?: string;
  private readonly configOverrides: Record<string, Record<string, unknown>>;
  private readonly createHostApi?: (pluginId: string) => PluginHostApi;
  private readonly deploymentGuard?: PluginDeploymentGuard;
  private readonly signatureVerifier?: PluginSignatureVerifier;
  private readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  private readonly onDisable?: (pluginId: string) => void;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly methodMap = new Map<string, { pluginId: string; handler: PluginToolHandler }>();
  /**
   * Per-plugin disposers (e.g. event subscriptions). Invoked in order on
   * disable() so host-side state scrubbing is deterministic.
   */
  private readonly disposers = new Map<string, Array<() => void>>();
  private loaded = false;

  constructor(options: PluginRuntimeOptions) {
    this.hostRoot = resolve(options.hostRoot);
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.configOverrides = options.configOverrides ?? {};
    this.createHostApi = options.createHostApi;
    this.deploymentGuard = options.deploymentGuard;
    this.signatureVerifier = options.signatureVerifier;
    this.auditLog = options.auditLog;
    this.onDisable = options.onDisable;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const manifestPaths = await this.resolveManifestPaths();
    for (const manifestPath of manifestPaths) {
      let manifest: PluginManifest;
      try {
        manifest = await this.readManifest(manifestPath);
      } catch (err) {
        // Sprint 1-A A4: fail-soft drop on manifest validation — other
        // plugins keep loading. Error message already contains pluginId,
        // field path, reason, and an example.
        console.error(`[plugin-runtime] ${(err as Error).message}`);
        continue;
      }
      const pluginRoot = dirname(manifestPath);

      // Sprint 3-B §9.6 — manifest signature gate.
      // Managed plugins require a valid signature; unsigned user plugins are
      // allowed but audit-logged. Invalid signatures always drop the plugin.
      if (this.signatureVerifier) {
        const sigResult = await this.signatureVerifier.verifyManifestFile(manifestPath);
        const isManaged = manifest.deployment === "managed";
        if (!sigResult.valid) {
          if (isManaged) {
            console.error(
              `[plugin-runtime] managed plugin '${manifest.id}' rejected — ${sigResult.reason ?? "signature invalid"}`,
            );
            this.auditLog?.("error", `plugin_signature_rejected`, {
              pluginId: manifest.id,
              reason: sigResult.reason,
              sha256: sigResult.sha256,
            });
            continue;
          }
          if (sigResult.reason === "signature file missing") {
            this.auditLog?.("warn", `plugin_signature_missing`, {
              pluginId: manifest.id,
              sha256: sigResult.sha256,
            });
            console.warn(
              `[plugin-runtime] user plugin '${manifest.id}' has no signature — loading unsigned`,
            );
          } else {
            console.error(
              `[plugin-runtime] user plugin '${manifest.id}' rejected — ${sigResult.reason}`,
            );
            this.auditLog?.("error", `plugin_signature_rejected`, {
              pluginId: manifest.id,
              reason: sigResult.reason,
              sha256: sigResult.sha256,
            });
            continue;
          }
        } else {
          this.auditLog?.("info", `plugin_signature_verified`, {
            pluginId: manifest.id,
            sha256: sigResult.sha256,
          });
        }
      }

      const entryPath = this.resolveEntryPath(pluginRoot, manifest.entry);
      const module = (await import(pathToFileURL(entryPath).href)) as {
        default?: RuntimePluginFactory;
        createPlugin?: RuntimePluginFactory;
      };
      const createPlugin = module.default ?? module.createPlugin;
      if (!createPlugin) {
        throw new Error(`Plugin entry does not export default/createPlugin: ${manifest.id}`);
      }

      // 플러그인별 스코프된 HostApi 생성
      const hostApi = this.createHostApi?.(manifest.id) ?? createNoopHostApi();

      const instance = await createPlugin({
        pluginId: manifest.id,
        pluginRoot,
        hostRoot: this.hostRoot,
        config: {
          ...(manifest.config ?? {}),
          ...(this.configOverrides["*"] ?? {}),       // 와일드카드: 모든 플러그인에 적용
          ...(this.configOverrides[manifest.id] ?? {}), // 플러그인별 오버라이드
        },
        log: (message, meta) => {
          if (meta !== undefined) {
            console.log(`[plugin:${manifest.id}] ${message}`, meta);
            return;
          }
          console.log(`[plugin:${manifest.id}] ${message}`);
        },
        hostApi,
      });

      const methods = new Map<string, PluginToolHandler>();
      for (const toolName of manifest.tools) {
        const handler = instance.handlers[toolName];
        if (!handler) {
          // Fail-soft: skip this tool but keep the plugin loaded so its other
          // tools stay usable. Silent full-plugin drop misleads users into
          // thinking the whole plugin is broken.
          console.warn(`[plugin:${manifest.id}] missing handler '${toolName}' — tool disabled`);
          continue;
        }
        methods.set(toolName, handler);
        if (this.methodMap.has(toolName)) {
          throw new Error(`Duplicate plugin method registered: ${toolName}`);
        }
        this.methodMap.set(toolName, { pluginId: manifest.id, handler });
      }

      // 매니페스트에 선언된 키워드 자동 등록
      if (manifest.keywords && manifest.keywords.length > 0) {
        hostApi.registerKeywords(manifest.keywords);
      }

      this.plugins.set(manifest.id, {
        manifest,
        pluginRoot,
        instance,
        methods,
      });
    }
    this.loaded = true;
  }

  async startAll(): Promise<void> {
    await this.load();
    // Sprint 1-A A1 — parallel start with slow-plugin warning and optional
    // hard timeout. handler Map is already registered in load() so method
    // availability is not gated by slow starts.
    const SLOW_THRESHOLD_MS = 5000;
    const failed: Array<{ id: string; reason: string }> = [];

    const tasks = [...this.plugins.values()].map((plugin) => {
      const { id } = plugin.manifest;
      const startedAt = Date.now();
      const slowTimer = setTimeout(() => {
        console.warn(`[plugin-runtime] slow plugin: ${id} (>${SLOW_THRESHOLD_MS}ms)`);
      }, SLOW_THRESHOLD_MS);

      const startPromise = (async () => {
        try {
          if (!plugin.instance.start) return;
          const hardTimeoutMs = plugin.manifest.startupTimeoutMs;
          if (hardTimeoutMs && hardTimeoutMs > 0) {
            // Promise.race enforces the timeout. The underlying start() is NOT
            // cancelled — no AbortController is wired through; the host simply
            // drops the plugin fail-soft once the timer rejects. Adding an
            // AbortSignal would require a PluginRuntimeContext change.
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`startup timeout (>${hardTimeoutMs}ms)`));
              }, hardTimeoutMs);
            });
            try {
              await Promise.race([
                Promise.resolve(plugin.instance.start()),
                timeout,
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          } else {
            await plugin.instance.start();
          }
        } finally {
          clearTimeout(slowTimer);
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed > SLOW_THRESHOLD_MS) {
          console.warn(`[plugin-runtime] slow plugin: ${id} finished in ${elapsed}ms`);
        }
      })();

      return startPromise.then(
        () => ({ id, ok: true as const }),
        (err: Error) => ({ id, ok: false as const, reason: err.message }),
      );
    });

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const item = result.value;
      if (!item.ok) failed.push({ id: item.id, reason: item.reason });
    }

    for (const { id, reason } of failed) {
      console.error(`[plugin:${id}] start failed (non-fatal): ${reason}`);
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      for (const method of plugin.methods.keys()) {
        this.methodMap.delete(method);
      }
      this.plugins.delete(id);
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.instance.stop?.();
    }
  }

  async restartAll(): Promise<void> {
    await this.stopAll();
    this.resetLoadedState();
    await this.startAll();
  }

  /**
   * Disable a loaded plugin at runtime — stops the instance, removes its method
   * handlers, and marks enabled=false in registry.json.
   *
   * §7.2 / §7.3: 기본 actor는 "user". managed 플러그인은 guard가 차단.
   */
  async disable(pluginId: string, actor: Actor = "user"): Promise<void> {
    if (this.deploymentGuard) {
      const result = await this.deploymentGuard.canDisable(pluginId, actor);
      if (!result.allowed) {
        throw new Error(result.reason ?? `Plugin disable denied: ${pluginId}`);
      }
    }

    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    try {
      await plugin.instance.stop?.();
    } catch (err) {
      console.error(`[plugin:${pluginId}] stop during disable failed:`, (err as Error).message);
    }

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);

    // Flush per-plugin disposers (event handlers etc.) before notifying host.
    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          console.error(`[plugin:${pluginId}] disposer failed:`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }

    if (this.registryPath) {
      // §M1 F-round: atomic update under registry lock.
      await updatePluginRegistry(this.registryPath, (registry) => {
        const entry = registry.plugins.find((p) => p.id === pluginId);
        if (entry) {
          entry.enabled = false;
        }
      });
    }

    // HIGH-1: keyword / tool / scope state 정리
    this.onDisable?.(pluginId);
  }

  async call(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      throw new Error(`Plugin method not found: ${method}`);
    }
    return entry.handler(payload);
  }

  /**
   * H2: Renderer-originated plugin invocation. Restricted to the method list
   * each plugin declares in manifest.uiCallable. Everything else must go
   * through ConversationLoop so MAX_PLUGIN_EXPANSION / PermissionManager /
   * ApprovalGate / scope filters are enforced.
   */
  async callFromUi(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      throw new Error(`Plugin method not found: ${method}`);
    }
    const plugin = this.plugins.get(entry.pluginId);
    const uiCallable = plugin?.manifest.uiCallable ?? [];
    if (!uiCallable.includes(method)) {
      throw new Error(
        `Method '${method}' is not UI-callable for plugin '${entry.pluginId}'. ` +
        `Declare it in manifest.uiCallable[] to allow renderer invocation.`,
      );
    }
    return entry.handler(payload);
  }

  /**
   * Register a disposer to run when `pluginId` is disabled. Used by boot's
   * HostApi.onEvent wrapper to clean up host-side event handlers.
   */
  registerDisposer(pluginId: string, dispose: () => void): void {
    let list = this.disposers.get(pluginId);
    if (!list) {
      list = [];
      this.disposers.set(pluginId, list);
    }
    list.push(dispose);
  }

  listToolNames(): string[] {
    return [...this.methodMap.keys()].sort();
  }

  listPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  getPluginManifest(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest;
  }

  /**
   * Phase 1.5 Option C — listPluginCards()
   *
   * LLM 판단 기반 lazy-load 요청을 위한 카탈로그. 각 loaded plugin의
   * pluginId, name, 1-line description, 샘플 tool names (최대 3개)를 반환한다.
   * SystemPromptBuilder가 비활성 plugin 목록을 렌더할 때 사용.
   */
  listPluginCards(toolRegistry?: { getVisibleTools(): Array<{ name: string }> }): PluginCard[] {
    const visibleNames = toolRegistry
      ? new Set(toolRegistry.getVisibleTools().map((t) => t.name))
      : null;
    const cards: PluginCard[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      const manifest = plugin.manifest;
      const allTools = manifest.tools ?? [];
      const filteredTools = visibleNames
        ? allTools.filter((t) => visibleNames.has(t))
        : allTools;
      const sampleTools = filteredTools.slice(0, 3);
      // C11: manifest.description 우선, 없으면 toolSchemas 요약, 최후 fallback.
      let description: string;
      if (manifest.description) {
        description = manifest.description;
      } else {
        const schemas = manifest.toolSchemas;
        if (schemas) {
          const parts: string[] = [];
          for (const toolName of sampleTools) {
            const desc = schemas[toolName]?.description;
            if (desc) parts.push(desc);
          }
          description = parts.length > 0 ? parts.join(" / ") : `Plugin: ${manifest.name}`;
        } else {
          description = `Plugin: ${manifest.name}`;
        }
      }
      cards.push({
        id: pluginId,
        name: manifest.name,
        description,
        sampleTools,
      });
    }
    return cards;
  }

  listPluginManifests(): Array<{ pluginId: string; manifest: PluginManifest }> {
    const result: Array<{ pluginId: string; manifest: PluginManifest }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      result.push({ pluginId, manifest: plugin.manifest });
    }
    return result;
  }

  findPluginIdByCapability(capability: string): string | undefined {
    const matches = this.listPluginIdsByCapability(capability);
    if (matches.length > 1) {
      console.warn(
        `[plugin-runtime] Multiple plugins declare capability '${capability}': ${matches.join(", ")}. ` +
        `Using '${matches[0]}'. Ensure only one plugin provides this capability.`,
      );
    }
    return matches[0];
  }

  listPluginIdsByCapability(capability: string): string[] {
    const result: string[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.manifest.capabilities?.includes(capability)) {
        result.push(pluginId);
      }
    }
    return result;
  }

  /**
   * Retrieve a loaded plugin's instance by id.
   * Returns undefined when the plugin failed to load or is not registered.
   * Public accessor so callers (e.g. boot.ts knowledge-tools DI) do not
   * reach into the private `plugins` Map via `as any` casts.
   */
  getPluginInstance<T = unknown>(pluginId: string): T | undefined {
    return this.plugins.get(pluginId)?.instance as T | undefined;
  }

  listUiExtensions(): Array<{ pluginId: string; extension: PluginUiExtension; entryUrl?: string }> {
    const result: Array<{ pluginId: string; extension: PluginUiExtension; entryUrl?: string }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      for (const extension of plugin.manifest.ui ?? []) {
        const entrySource = extension.entry ?? extension.page;
        const entryPath = entrySource ? this.resolveEntryPath(plugin.pluginRoot, entrySource) : undefined;
        result.push({
          pluginId,
          extension,
          entryUrl: entryPath ? pathToFileURL(entryPath).href : undefined,
        });
      }
    }
    return result;
  }

  private async readManifest(path: string): Promise<PluginManifest> {
    // Sprint 1-A A4 — detailed, per-field error messages shaped as
    //   "Invalid plugin manifest '<pluginId>' at '<fieldPath>': <reason>. Example: <correction>"
    // so operators can fix manifests without re-reading the loader.
    const raw = await readFile(path, "utf-8");
    let parsed: PluginManifest;
    try {
      parsed = JSON.parse(raw) as PluginManifest;
    } catch (err) {
      throw new Error(
        `Invalid plugin manifest '<unknown>' at '${path}': JSON parse error (${(err as Error).message}). ` +
        `Example: {"id":"com.lge.sample","name":"Sample","version":"1.0.0","entry":"dist/index.js","tools":["sample_ping"]}`,
      );
    }
    const pid = typeof parsed?.id === "string" && parsed.id.length > 0 ? parsed.id : "<unknown>";
    const fail = (fieldPath: string, reason: string, example: string): never => {
      throw new Error(
        `Invalid plugin manifest '${pid}' at '${fieldPath}' (${path}): ${reason}. Example: ${example}`,
      );
    };

    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      fail("id", "must be a non-empty string", `"id": "com.lge.meeting-recorder"`);
    }
    if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+/.test(parsed.version)) {
      fail("version", "must be a semver string like 'MAJOR.MINOR.PATCH'", `"version": "1.0.0"`);
    }
    if (typeof parsed.entry !== "string" || parsed.entry.length === 0) {
      fail("entry", "must be a non-empty relative path to the plugin ESM entry", `"entry": "dist/index.js"`);
    }
    if (!Array.isArray(parsed.tools)) {
      fail("tools", "must be an array of tool name strings", `"tools": ["sample_ping"]`);
    }

    // Tool names exposed to LLMs must satisfy ^[a-zA-Z_][a-zA-Z0-9_]*$ (vendor requirement).
    // Plugin id is the package identity and may contain dots (e.g. com.lge.meeting-recorder),
    // but tools are LLM tool names — no dots allowed, no runtime conversion is performed.
    const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    for (let i = 0; i < parsed.tools.length; i += 1) {
      const method = parsed.tools[i];
      if (typeof method !== "string") {
        fail(`tools[${i}]`, "must be a string", `"tools": ["meeting_start"]`);
      }
      if (!TOOL_NAME_PATTERN.test(method)) {
        // Backwards-compat: older tests match /Invalid tool name '...'/ — keep that
        // substring so the fresh error message still triggers the same assertion.
        throw new Error(
          `Invalid tool name '${method}' in plugin '${pid}' at 'tools[${i}]' (${path}): ` +
          `tool names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). ` +
          `Example: "tools": ["meeting_start"] (not "meeting.start")`,
        );
      }
    }

    if (parsed.startupTools !== undefined && !Array.isArray(parsed.startupTools)) {
      fail(
        "startupTools",
        "must be an array of strings (each value must appear in tools[])",
        `"startupTools": ["meeting_watch"]`,
      );
    }
    const startupTools = parsed.startupTools ?? [];
    for (let i = 0; i < startupTools.length; i += 1) {
      const startupMethod = startupTools[i];
      if (typeof startupMethod !== "string") {
        fail(
          `startupTools[${i}]`,
          "must be a string",
          `"startupTools": ["meeting_watch"]`,
        );
      }
      if (!parsed.tools.includes(startupMethod)) {
        fail(
          `startupTools[${i}]`,
          `entry '${startupMethod}' is not declared in tools[]`,
          `add "${startupMethod}" to tools[] or remove it from startupTools[]`,
        );
      }
    }

    if (parsed.startupTimeoutMs !== undefined) {
      // Schema declares integer; runtime enforces matching constraint.
      if (typeof parsed.startupTimeoutMs !== "number" || !Number.isInteger(parsed.startupTimeoutMs) || parsed.startupTimeoutMs <= 0) {
        fail(
          "startupTimeoutMs",
          "must be a positive integer (ms)",
          `"startupTimeoutMs": 8000`,
        );
      }
    }

    return parsed;
  }

  private resolveEntryPath(pluginRoot: string, entry: string): string {
    if (isAbsolute(entry)) return entry;
    return resolve(pluginRoot, entry);
  }

  private async resolveManifestPaths(): Promise<string[]> {
    if (this.manifestPaths.length > 0) {
      return this.manifestPaths;
    }
    if (!this.registryPath) {
      throw new Error("Either manifestPaths or registryPath must be provided.");
    }
    const registry = await readPluginRegistry(this.registryPath);
    const resolved = resolveManifestPathsFromRegistry(this.registryPath, registry.plugins);
    return resolved;
  }

  private resetLoadedState(): void {
    // Flush every plugin's disposers before clearing maps.
    for (const [pluginId, list] of this.disposers) {
      for (const d of list) {
        try { d(); } catch (err) {
          console.error(`[plugin:${pluginId}] disposer failed:`, (err as Error).message);
        }
      }
    }
    this.disposers.clear();
    this.plugins.clear();
    this.methodMap.clear();
    this.loaded = false;
    // Note: 호스트의 keywordEngine/toolRegistry는 boot.ts의 createHostApi에서
    // pluginId 기반으로 정리됨 (restartAll → 새로 load 시 재등록)
  }
}

/** 폴백: HostApi 없이 동작하는 noop 구현 */
function createNoopHostApi(): PluginHostApi {
  return {
    registerKeywords: () => {},
    emitEvent: () => {},
    onEvent: () => () => {},
    addTask: () => {},
    saveNote: () => {},
    getSecret: () => null,
    getMsGraphToken: async () => null,
    startMsGraphAuth: async () => {},
    isMsGraphAuthenticated: () => false,
    getMsGraphAccount: () => null,
    onMsGraphAuthChange: () => {},
    callLlm: async () => { throw new Error("LLM not available in noop context"); },
    logEvent: () => {},
    onShutdown: () => {},
  };
}
