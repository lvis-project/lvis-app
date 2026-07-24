import { createHash } from "node:crypto";
import { parseHookConfig, type HookConfigEntry } from "./hook-config.js";
import type { PluginHookOwner } from "./hook-registry.js";
import type { ActivePluginGeneration } from "../plugins/plugin-generation-coordinator.js";
import { anchorBundledCommand } from "../plugins/plugin-bundled-command.js";
import { PluginContributionTrustStore } from "../plugins/plugin-contribution-trust.js";

export interface PreparedPluginHookProjection {
  owner: PluginHookOwner;
  entries: readonly HookConfigEntry[];
}

/** Exact-version/fingerprint trust records. Records never transfer to a new version. */
export class PluginHookTrustStore {
  private readonly store: PluginContributionTrustStore;

  constructor(path?: string) {
    this.store = new PluginContributionTrustStore("hook", path);
  }

  approve(projection: PreparedPluginHookProjection): void {
    this.store.approve(projection.owner);
  }

  isApproved(projection: PreparedPluginHookProjection): boolean {
    return this.store.isApproved(projection.owner);
  }

  revoke(projection: PreparedPluginHookProjection): void {
    this.store.revoke(projection.owner);
  }
}

/** Parse/fingerprint-only preparation. It performs no spawn or hook registration. */
export function preparePluginHookGeneration(
  generation: ActivePluginGeneration,
  payloadRoot: string,
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
    const anchoredEntries: HookConfigEntry[] = [];
    const commandFingerprints: string[] = [];
    for (const entry of parsed.entries) {
      const anchored = anchorBundledCommand(
        payloadRoot,
        contribution.path,
        entry.command,
        contribution.fingerprint,
        `plugin Hook '${contribution.localId}'`,
      );
      commandFingerprints.push(anchored.fingerprint);
      anchoredEntries.push(Object.freeze({ ...entry, command: [...anchored.command] }));
    }
    const owner: PluginHookOwner = Object.freeze({
      pluginId: generation.pluginId,
      pluginVersion: generation.pluginVersion,
      activationId: generation.generationId,
      generationId: generation.artifactGenerationId,
      localId: contribution.localId,
      fingerprint: commandFingerprints.length === 0
        ? contribution.fingerprint
        : createHash("sha256").update(commandFingerprints.sort().join("\0")).digest("hex"),
    });
    projections.push(Object.freeze({ owner, entries: Object.freeze(anchoredEntries) }));
  }
  return Object.freeze(projections);
}
