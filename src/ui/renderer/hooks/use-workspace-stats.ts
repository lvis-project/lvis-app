/**
 * useWorkspaceStats — aggregates host-side inventory counts + marketplace
 * status for the Settings "일반" tab dashboard.
 *
 * Combines existing IPC channels (no new main-side handler) so the
 * dashboard surface stays at parity with whatever the other settings
 * tabs already render:
 *   - 플러그인  → `listPluginUiExtensions` (UI-mounted plugins; the
 *     same source PluginConfigTab uses)
 *   - 도구      → sum of `listPluginCards()[].tools.length`
 *     (host-side per-plugin tool list)
 *   - 에이전트  → `listAgentProfiles().agents.length`
 *   - 스킬      → `listSkills().skills.length`
 *   - 역할      → `listPersonaPromptSummaries().prompts.length`
 *   - 마켓플레이스 → `pingMarketplace()` (configured + online flags)
 *
 * Refresh runs once on mount and on demand via the returned `refresh()`.
 * Errors are swallowed per-slice so a single failing IPC never blanks
 * the entire dashboard — each count falls back to its last known value
 * (or 0 on first error).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

export interface WorkspaceStats {
  pluginCount: number;
  toolCount: number;
  agentCount: number;
  skillCount: number;
  roleCount: number;
  marketplace: {
    configured: boolean;
    online: boolean;
  };
  /** ISO timestamp of the last successful refresh. */
  lastSyncedAt: string | null;
}

const EMPTY: WorkspaceStats = {
  pluginCount: 0,
  toolCount: 0,
  agentCount: 0,
  skillCount: 0,
  roleCount: 0,
  marketplace: { configured: false, online: false },
  lastSyncedAt: null,
};

export function useWorkspaceStats(api: LvisApi): {
  stats: WorkspaceStats;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [stats, setStats] = useState<WorkspaceStats>(EMPTY);
  const [loading, setLoading] = useState(true);
  // `aliveRef` guards against setState-after-unmount when the user closes
  // the settings window mid-refresh. The combined Promise.allSettled below
  // can resolve hundreds of ms after the tab unmounts on slow machines.
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [
      pluginsRes,
      cardsRes,
      agentsRes,
      skillsRes,
      promptsRes,
      pingRes,
    ] = await Promise.allSettled([
      api.listPluginUiExtensions(),
      api.listPluginCards(),
      api.listAgentProfiles(),
      api.listSkills(),
      api.listPersonaPromptSummaries(),
      api.pingMarketplace(),
    ]);
    if (!aliveRef.current) return;

    const next: WorkspaceStats = { ...stats };

    if (pluginsRes.status === "fulfilled") {
      next.pluginCount = pluginsRes.value.length;
    }
    if (cardsRes.status === "fulfilled") {
      // Sum the per-plugin tool counts — `tools` on PluginCardSummary is
      // the host-derived list of tool names registered for that plugin.
      next.toolCount = cardsRes.value.reduce(
        (sum, card) => sum + (Array.isArray(card.tools) ? card.tools.length : 0),
        0,
      );
    }
    if (agentsRes.status === "fulfilled") {
      next.agentCount = agentsRes.value.agents.length;
    }
    if (skillsRes.status === "fulfilled") {
      next.skillCount = skillsRes.value.skills.length;
    }
    if (promptsRes.status === "fulfilled") {
      next.roleCount = promptsRes.value.prompts.length;
    }
    if (pingRes.status === "fulfilled") {
      next.marketplace = {
        configured: pingRes.value.configured,
        online: pingRes.value.online,
      };
    }
    next.lastSyncedAt = new Date().toISOString();

    setStats(next);
    setLoading(false);
  }, [api, stats]);

  useEffect(() => {
    aliveRef.current = true;
    // Fire-and-forget initial load. The depended-on `refresh` already
    // captures `api`; this effect only needs to run once per api identity.
    void refresh();
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  return { stats, loading, refresh };
}
