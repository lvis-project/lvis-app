import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PluginManifest,
  PluginMethodHandler,
  PluginUiExtension,
  PluginHostApi,
  RuntimePlugin,
  RuntimePluginFactory,
} from "./types.js";
import { readPluginRegistry, resolveManifestPathsFromRegistry } from "./registry.js";

type LoadedPlugin = {
  manifest: PluginManifest;
  pluginRoot: string;
  instance: RuntimePlugin;
  methods: Map<string, PluginMethodHandler>;
};

export interface PluginRuntimeOptions {
  hostRoot: string;
  manifestPaths?: string[];
  registryPath?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  /** 플러그인별 HostApi를 생성하는 팩토리 — boot.ts에서 주입 */
  createHostApi?: (pluginId: string) => PluginHostApi;
}

export class PluginRuntime {
  private readonly hostRoot: string;
  private readonly manifestPaths: string[];
  private readonly registryPath?: string;
  private readonly configOverrides: Record<string, Record<string, unknown>>;
  private readonly createHostApi?: (pluginId: string) => PluginHostApi;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly methodMap = new Map<string, { pluginId: string; handler: PluginMethodHandler }>();
  private loaded = false;

  constructor(options: PluginRuntimeOptions) {
    this.hostRoot = resolve(options.hostRoot);
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.configOverrides = options.configOverrides ?? {};
    this.createHostApi = options.createHostApi;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const manifestPaths = await this.resolveManifestPaths();
    for (const manifestPath of manifestPaths) {
      const manifest = await this.readManifest(manifestPath);
      const pluginRoot = dirname(manifestPath);
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

      const methods = new Map<string, PluginMethodHandler>();
      for (const methodName of manifest.methods) {
        const handler = instance.handlers[methodName];
        if (!handler) {
          throw new Error(`Missing handler '${methodName}' in plugin '${manifest.id}'`);
        }
        methods.set(methodName, handler);
        if (this.methodMap.has(methodName)) {
          throw new Error(`Duplicate plugin method registered: ${methodName}`);
        }
        this.methodMap.set(methodName, { pluginId: manifest.id, handler });
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
    // 개별 플러그인 시작 실패가 전체 앱을 죽이지 않도록 격리
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.instance.start?.();
      } catch (err) {
        console.error(`[plugin:${plugin.manifest.id}] start failed (non-fatal):`, (err as Error).message);
        // 실패한 플러그인의 메서드를 제거하여 호출 시 에러 방지
        for (const method of plugin.methods.keys()) {
          this.methodMap.delete(method);
        }
        this.plugins.delete(plugin.manifest.id);
      }
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

  async call(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      throw new Error(`Plugin method not found: ${method}`);
    }
    return entry.handler(payload);
  }

  listMethods(): string[] {
    return [...this.methodMap.keys()].sort();
  }

  listPluginIds(): string[] {
    return [...this.plugins.keys()];
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
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as PluginManifest;
    if (!parsed.id || !parsed.entry || !Array.isArray(parsed.methods)) {
      throw new Error(`Invalid plugin manifest: ${path}`);
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
    onEvent: () => {},
    addTask: () => {},
    saveNote: () => {},
    getSecret: () => null,
  };
}
