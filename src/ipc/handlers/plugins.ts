/**
 * plugins.ts (handlers) — transport-agnostic plugin handler logic (#1409 C10).
 *
 * Pure `handle*` functions import NOTHING from the Electron transport; the
 * `ipcMain.handle` wrapper stays in `domains/plugins.ts`. Public card/catalog
 * reads delegate directly. The E2E bundle projection remains behind its
 * trusted-renderer + LVIS_E2E wrapper.
 */
import type { IpcDeps } from "../types.js";
import type { PluginCard } from "../../plugins/runtime/index.js";
import { filterRegistryByEventAndTool } from "../../hooks/hook-registry.js";

export type PluginBundleE2eSnapshot =
  | {
      ok: false;
      error:
        | "invalid-plugin-id"
        | "invalid-skill-local-id"
        | "invalid-hook-probe-tool-name";
    }
  | {
      ok: true;
      pluginId: string;
      active: {
        version: string;
        generationId: string;
        artifactGenerationId: string;
      } | null;
      skill: {
        name: string;
        body: string;
        owner: {
          pluginId: string;
          pluginVersion: string;
          generationId: string;
          localId: string;
          fingerprint: string;
        };
      } | null;
      tools: Array<{
        name: string;
        source: "plugin" | "mcp";
        version: string;
        pluginId?: string;
        mcpServerId?: string;
        generationId?: string;
      }>;
      hooks: {
        probeToolName: string;
        registered: Array<{
          id: string;
          event: "pre";
          matcher?: string;
          owner: {
            pluginId: string;
            pluginVersion: string;
            activationId: string;
            generationId: string;
            localId: string;
            fingerprint: string;
          };
        }>;
        matchingPreToolUse: string[];
      };
    };

const E2E_PLUGIN_ID = /^[a-z][a-z0-9-]{2,127}$/;
const E2E_LOCAL_ID = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Test-only bundle observability projection.
 *
 * The IPC wrapper is available only under LVIS_E2E=1 and a trusted Host
 * renderer. Keeping the projection here transport-agnostic makes its
 * allowlist and owner filtering independently testable. It intentionally
 * exposes neither arbitrary Skill paths nor registry entries owned by other
 * plugins.
 */
export async function handlePluginBundleE2eSnapshot(
  deps: IpcDeps,
  pluginId: unknown,
  skillLocalId: unknown,
  hookProbeToolName: unknown,
): Promise<PluginBundleE2eSnapshot> {
  if (typeof pluginId !== "string" || !E2E_PLUGIN_ID.test(pluginId)) {
    return { ok: false, error: "invalid-plugin-id" };
  }
  if (typeof skillLocalId !== "string" || !E2E_LOCAL_ID.test(skillLocalId)) {
    return { ok: false, error: "invalid-skill-local-id" };
  }
  if (
    typeof hookProbeToolName !== "string" ||
    !E2E_LOCAL_ID.test(hookProbeToolName)
  ) {
    return { ok: false, error: "invalid-hook-probe-tool-name" };
  }

  const registeredHookEntries = (deps.scriptHookManager?.hooksOfType("pre") ?? [])
    .filter((entry) => entry.owner?.pluginId === pluginId);
  const hooks = {
    probeToolName: hookProbeToolName,
    registered: registeredHookEntries
      .map((entry) => ({
        id: entry.id,
        event: entry.event as "pre",
        ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
        owner: { ...entry.owner! },
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    matchingPreToolUse: filterRegistryByEventAndTool(
      registeredHookEntries,
      "pre",
      hookProbeToolName,
    )
      .map((entry) => entry.id)
      .sort(),
  };

  const lifecycle = deps.pluginBundleLifecycle;
  if (!lifecycle) {
    return { ok: true, pluginId, active: null, skill: null, tools: [], hooks };
  }

  let lease;
  try {
    lease = await lifecycle.acquire(pluginId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `plugin '${pluginId}' has no active generation`
    ) {
      return { ok: true, pluginId, active: null, skill: null, tools: [], hooks };
    }
    throw error;
  }

  try {
    const active = lease.generation;
    const loadedSkill = deps.skillStore?.loadPluginGeneration(
      active,
      `plugin:${pluginId}:${skillLocalId}`,
    );
    const skillOwner = loadedSkill?.pluginOwner;
    const tools = deps.toolRegistry
      .listAll()
      .filter(
        (tool) =>
          (tool.source === "plugin" || tool.source === "mcp") &&
          tool.pluginGeneration?.pluginId === pluginId &&
          tool.pluginGeneration.generationId === active.generationId,
      )
      .map((tool) => ({
        name: tool.name,
        source: tool.source as "plugin" | "mcp",
        version: tool.version,
        ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
        ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
        ...(tool.pluginGeneration
          ? { generationId: tool.pluginGeneration.generationId }
          : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      ok: true,
      pluginId,
      active: {
        version: active.pluginVersion,
        generationId: active.generationId,
        artifactGenerationId: active.artifactGenerationId,
      },
      skill:
        loadedSkill && skillOwner?.pluginId === pluginId
          ? {
              name: loadedSkill.name,
              body: loadedSkill.body,
              owner: { ...skillOwner },
            }
          : null,
      tools,
      hooks,
    };
  } finally {
    lease.release();
  }
}

/** PUBLIC `lvis:plugins:cards` — installed plugin cards for the renderer/api. */
export function handlePluginCards(deps: IpcDeps) {
  const cards = deps.pluginRuntime.listPluginCards(deps.toolRegistry);
  const existingIds = new Set(cards.map((card) => card.id));
  const failureCards: PluginCard[] = deps.pluginMarketplace
    .getInstallFailureDiagnostics()
    .filter((failure) => !existingIds.has(failure.id))
    .map((failure) => ({
      id: failure.id,
      name: failure.name,
      description: `Marketplace install failed: ${failure.error}`,
      sampleTools: [],
      tools: [],
      capabilities: [],
      isManaged: failure.isManaged,
      installPolicy: failure.installPolicy,
      loadStatus: "failed",
      active: false,
      runtimeLoaded: false,
      installAliases: failure.installAliases,
      ...(failure.installFailureKind ? { installFailureKind: failure.installFailureKind } : {}),
      installFailureMessage: failure.error,
      ...(failure.networkAccess ? { networkAccess: failure.networkAccess } : {}),
      ...(failure.version ? { version: failure.version } : {}),
      ...(failure.publisher ? { publisher: failure.publisher } : {}),
    }));
  return [...cards, ...failureCards];
}

/** PUBLIC `lvis:plugins:marketplace:list` — marketplace catalog listing. */
export function handleMarketplaceList(deps: IpcDeps) {
  return deps.pluginMarketplace.list();
}
