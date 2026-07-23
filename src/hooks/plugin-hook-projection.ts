import { parseHookConfig, type HookConfigEntry } from "./hook-config.js";
import type { PluginHookOwner } from "./hook-registry.js";
import type { ActivePluginGeneration } from "../plugins/plugin-generation-coordinator.js";

export interface PreparedPluginHookProjection {
  owner: PluginHookOwner;
  entries: readonly HookConfigEntry[];
}

function trustKey(owner: PluginHookOwner): string {
  return [owner.pluginId, owner.pluginVersion, owner.localId, owner.fingerprint].join("|");
}

/** Exact-version/fingerprint trust records. Records never transfer to a new version. */
export class PluginHookTrustStore {
  private readonly approved = new Set<string>();

  approve(projection: PreparedPluginHookProjection): void {
    this.approved.add(trustKey(projection.owner));
  }

  isApproved(projection: PreparedPluginHookProjection): boolean {
    return this.approved.has(trustKey(projection.owner));
  }

  revoke(projection: PreparedPluginHookProjection): void {
    this.approved.delete(trustKey(projection.owner));
  }
}

/** Parse/fingerprint-only preparation. It performs no spawn or hook registration. */
export function preparePluginHookGeneration(
  generation: ActivePluginGeneration,
): readonly PreparedPluginHookProjection[] {
  const projections: PreparedPluginHookProjection[] = [];
  for (const contribution of generation.contributions) {
    if (contribution.kind !== "hook") continue;
    if (contribution.files.length !== 1) {
      throw new Error(`plugin Hook '${contribution.localId}' must materialize exactly one config file`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contribution.files[0].content) as unknown;
    } catch (error) {
      throw new Error(`plugin Hook '${contribution.localId}' is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = parseHookConfig(raw);
    if (parsed.errors.length > 0) {
      throw new Error(`plugin Hook '${contribution.localId}' is invalid: ${parsed.errors.join("; ")}`);
    }
    const owner: PluginHookOwner = Object.freeze({
      pluginId: generation.pluginId,
      pluginVersion: generation.pluginVersion,
      generationId: generation.generationId,
      localId: contribution.localId,
      fingerprint: contribution.fingerprint,
    });
    projections.push(Object.freeze({ owner, entries: Object.freeze(parsed.entries.map((entry) => Object.freeze({ ...entry }))) }));
  }
  return Object.freeze(projections);
}
