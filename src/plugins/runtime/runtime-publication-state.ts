import type {
  PluginRuntimeGenerationProjection,
  PreparedPluginRuntimeGenerationPublication,
} from "../plugin-host-generation.js";
import { createLogger } from "../../lib/logger.js";
import { PluginRuntimeState } from "./runtime-state.js";

const log = createLogger("plugin-runtime");

/** Host-private in-memory projections for an already prepared plugin generation. */
export abstract class PluginRuntimePublicationState extends PluginRuntimeState {
  getRuntimeGenerationProjection(pluginId: string): PluginRuntimeGenerationProjection | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    return Object.freeze({
      activationId: plugin.activationId,
      installId: this.requirePluginInstallClaim(pluginId),
      manifest: plugin.manifest,
      pluginRoot: plugin.pluginRoot,
      instance: plugin.instance,
      methods: new Map(plugin.methods),
      ...(plugin.approvedPluginAccess ? { approvedPluginAccess: plugin.approvedPluginAccess } : {}),
      disposers: Object.freeze([...(this.disposers.get(pluginId) ?? [])]),
      ...(plugin.hostEffects ? { hostEffects: plugin.hostEffects } : {}),
      ...(plugin.deactivateHostApi ? { deactivateHostApi: plugin.deactivateHostApi } : {}),
      ...(plugin.drainHostApiOperations
        ? { drainHostApiOperations: plugin.drainHostApiOperations }
        : {}),
      ...(plugin.lifecycleHookScope ? { lifecycleHookScope: plugin.lifecycleHookScope } : {}),
    });
  }

  prepareRuntimeGeneration(
    runtime: PluginRuntimeGenerationProjection,
    predecessorGenerationId: string | undefined,
  ): PreparedPluginRuntimeGenerationPublication {
    const pluginId = runtime.manifest.id;
    if (runtime.installId === undefined) {
      throw new Error(`Plugin runtime generation install provenance missing: ${pluginId}`);
    }
    this.assertPluginIdentityNamespace(
      [{ pluginId, alias: runtime.installId ?? undefined }],
      runtime.installId === null ? [] : [runtime.installId],
    );
    const nextMethods = new Map(this.methodMap);
    for (const [toolName, entry] of nextMethods) {
      if (entry.pluginId === pluginId) nextMethods.delete(toolName);
    }
    for (const toolName of runtime.methods.keys()) {
      const owner = nextMethods.get(toolName)?.pluginId;
      if (owner && owner !== pluginId) throw new Error(`Duplicate plugin method registered: ${toolName}`);
      nextMethods.set(toolName, { pluginId, handler: runtime.methods.get(toolName)! });
    }
    const nextPlugins = new Map(this.plugins);
    nextPlugins.set(pluginId, {
      activationId: runtime.activationId,
      manifest: runtime.manifest,
      pluginRoot: runtime.pluginRoot,
      instance: runtime.instance,
      methods: new Map(runtime.methods),
      approvedPluginAccess: runtime.approvedPluginAccess,
      hostEffects: runtime.hostEffects,
      started: true,
      deactivateHostApi: runtime.deactivateHostApi,
      drainHostApiOperations: runtime.drainHostApiOperations,
      lifecycleHookScope: runtime.lifecycleHookScope,
    });
    const nextDisposers = new Map(this.disposers);
    nextDisposers.set(pluginId, [...(runtime.disposers ?? [])]);
    const predecessorAuthKey = predecessorGenerationId === undefined
      ? undefined
      : `${pluginId}\0${predecessorGenerationId}`;
    const publishHostEffects = runtime.hostEffects?.preparePublish();
    let published = false;
    return Object.freeze({
      pluginId,
      publish: () => {
        if (published) return;
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        publishHostEffects?.();
        this.publishValidatedPluginInstallAlias(pluginId, runtime.installId ?? undefined);
        this.methodMap = nextMethods;
        this.plugins = nextPlugins;
        this.disposers = nextDisposers;
        this.rememberPluginManifest(pluginId, runtime.manifest, runtime.approvedPluginAccess);
        this.markPluginUiRevision(pluginId);
        this.failedPluginIds.delete(pluginId);
        this.loadFailureInfo.delete(pluginId);
        this.disabledPluginIds.delete(pluginId);
        // Auth outcomes can arrive after preparation. Retain the live bridge
        // and erase only the exact predecessor's mutable generation state.
        if (predecessorAuthKey !== undefined) {
          this.pluginAccountHashes.delete(predecessorAuthKey);
          this.pluginAuthInvocationEpochs.delete(predecessorAuthKey);
          this.pluginAuthPublishedEpochs.delete(predecessorAuthKey);
          for (const key of this.pluginAuthFailurePrincipals.keys()) {
            if (key.startsWith(`${predecessorAuthKey}\0`)) {
              this.pluginAuthFailurePrincipals.delete(key);
            }
          }
        }
        published = true;
      },
    });
  }

  prepareRuntimeRemoval(
    pluginId: string,
    predecessorGenerationId: string | undefined,
  ): PreparedPluginRuntimeGenerationPublication {
    const nextMethods = new Map(this.methodMap);
    for (const [toolName, entry] of nextMethods) {
      if (entry.pluginId === pluginId) nextMethods.delete(toolName);
    }
    const nextPlugins = new Map(this.plugins);
    nextPlugins.delete(pluginId);
    const nextDisposers = new Map(this.disposers);
    nextDisposers.delete(pluginId);
    const predecessorAuthKey = predecessorGenerationId === undefined
      ? undefined
      : `${pluginId}\0${predecessorGenerationId}`;
    let published = false;
    return Object.freeze({
      pluginId,
      publish: () => {
        if (published) return;
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        this.methodMap = nextMethods;
        this.plugins = nextPlugins;
        this.disposers = nextDisposers;
        this.invalidatePluginUiRevision(pluginId);
        if (predecessorAuthKey !== undefined) {
          this.pluginAccountHashes.delete(predecessorAuthKey);
          this.pluginAuthInvocationEpochs.delete(predecessorAuthKey);
          this.pluginAuthPublishedEpochs.delete(predecessorAuthKey);
          for (const key of this.pluginAuthFailurePrincipals.keys()) {
            if (key.startsWith(`${predecessorAuthKey}\0`)) {
              this.pluginAuthFailurePrincipals.delete(key);
            }
          }
        }
        published = true;
      },
    });
  }

  async postPublishRuntimeGeneration(runtime: PluginRuntimeGenerationProjection): Promise<void> {
    const faults: Error[] = [];
    for (const error of runtime.hostEffects?.postPublish() ?? []) {
      log.error(`generation post-publish signal failed for ${runtime.manifest.id}: %s`, error.message);
      faults.push(error);
    }
    try {
      await runtime.instance.onPublished?.();
    } catch (error) {
      log.error(`generation post-publish startup degraded for ${runtime.manifest.id}: %s`, (error as Error).message);
      this.auditLog?.("warn", "plugin_post_publish_startup_degraded", {
        pluginId: runtime.manifest.id,
        version: runtime.manifest.version,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      faults.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (faults.length > 0) {
      throw new AggregateError(faults, `plugin '${runtime.manifest.id}' runtime post-publish failed`);
    }
  }

  publishRuntimeGeneration(
    runtime: PluginRuntimeGenerationProjection,
    predecessorGenerationId: string | undefined,
  ): void {
    this.prepareRuntimeGeneration(runtime, predecessorGenerationId).publish();
  }

  unpublishRuntimeGeneration(
    pluginId: string,
    predecessorGenerationId: string | undefined,
  ): void {
    this.prepareRuntimeRemoval(pluginId, predecessorGenerationId).publish();
  }
}
