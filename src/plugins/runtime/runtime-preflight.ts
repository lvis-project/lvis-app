import { dirname } from "node:path";
import type { PluginAccessSpec, PluginManifest } from "../types.js";
import type { ManifestLoadPlan } from "./types.js";

const BOOT_PREFLIGHT_CONCURRENCY = 4;

export type PluginIntegrityCheckResult =
  | {
      ok: true;
      verified?: {
        installSource: "marketplace" | "local-dev";
        signerKeyId: string | null;
        artifactSha256: string | null;
      };
    }
  | {
      ok: false;
      reason: string;
      error?: unknown;
    };

export type BootPreflightOutcome =
  | {
      ok: true;
      plan: ManifestLoadPlan;
      manifest: PluginManifest;
      approvedPluginAccess: PluginAccessSpec | undefined;
      integrityResult?: PluginIntegrityCheckResult;
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "integrity";
      integrityResult: PluginIntegrityCheckResult & { ok: false };
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "manifest";
      error: unknown;
      integrityResult?: PluginIntegrityCheckResult;
    };

interface BootPreflightOperations {
  prepare(): Promise<unknown>;
  verify(pluginId: string, pluginRoot: string): Promise<PluginIntegrityCheckResult>;
  readManifest(manifestPath: string): Promise<PluginManifest>;
}

export async function preflightPluginLoadPlan(
  loadPlan: ManifestLoadPlan[],
  operations: BootPreflightOperations,
): Promise<BootPreflightOutcome[]> {
  if (loadPlan.length === 0) return [];
  await operations.prepare();
  return mapBoundedInOrder(
    loadPlan,
    BOOT_PREFLIGHT_CONCURRENCY,
    async (plan): Promise<BootPreflightOutcome> => {
      let integrityResult: PluginIntegrityCheckResult | undefined;
      if (plan.pluginIdHint) {
        try {
          integrityResult = await operations.verify(
            plan.pluginIdHint,
            dirname(plan.manifestPath),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          integrityResult = {
            ok: false,
            reason: `install receipt verification failed unexpectedly: ${detail}`,
            error,
          };
        }
        if (!integrityResult.ok) {
          return { ok: false, plan, kind: "integrity", integrityResult };
        }
      }
      try {
        return {
          ok: true,
          plan,
          manifest: await operations.readManifest(plan.manifestPath),
          approvedPluginAccess: plan.approvedPluginAccess,
          integrityResult,
        };
      } catch (error) {
        return { ok: false, plan, kind: "manifest", error, integrityResult };
      }
    },
  );
}

async function mapBoundedInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapItem(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker),
  );
  return results;
}
