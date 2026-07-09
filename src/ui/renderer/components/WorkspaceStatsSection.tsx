import { useMemo } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Puzzle,
  Wrench,
  Bot,
  Sparkles,
  UserCog,
  Store,
  RefreshCw,
} from "lucide-react";
import type { LvisApi } from "../types.js";
import { SettingsSection } from "./SettingsSection.js";
import { useWorkspaceStats } from "../hooks/use-workspace-stats.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SettingsTab } from "../../../shared/settings-tabs.js";

export interface WorkspaceStatsSectionProps {
  api: LvisApi;
  /**
   * Navigate the sibling settings nav to a different tab. Stat cards use this
   * to deep-link into the detail tab when the user clicks a count card.
   */
  onNavigate: (tab: SettingsTab) => void;
}

interface StatCardProps {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  onClick: () => void;
  loading: boolean;
  testId?: string;
}

function StatCard({ label, count, icon: Icon, onClick, loading, testId }: StatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/(--opacity-strong) hover:bg-accent/(--opacity-medium) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" aria-hidden={true} />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <span className="text-2xl font-semibold tabular-nums text-foreground">
        {loading ? "–" : count}
      </span>
    </button>
  );
}

/**
 * Workspace statistics — installed plugin / tool / agent / skill / role counts
 * plus marketplace connection status. Relocated from the former General tab
 * onto the Usage surface; the cards deep-link into their detail tab via
 * `onNavigate`. `useWorkspaceStats` remains the single data source.
 */
export function WorkspaceStatsSection({ api, onNavigate }: WorkspaceStatsSectionProps) {
  const { t, locale } = useTranslation();
  const { stats, loading, refresh } = useWorkspaceStats(api);

  const marketplaceStatus: { dot: string; label: string } = useMemo(() => {
    if (!stats.marketplace.configured) return { dot: "bg-muted-foreground/(--opacity-medium)", label: t("generalTab.marketplaceNotConnected") };
    if (stats.marketplace.online) return { dot: "bg-success", label: t("generalTab.marketplaceOnline") };
    return { dot: "bg-destructive", label: t("generalTab.marketplaceNoResponse") };
  }, [stats.marketplace.configured, stats.marketplace.online, locale, t]);

  const lastSyncedLabel = useMemo(() => {
    if (!stats.lastSyncedAt) return t("generalTab.notYetSynced");
    const dt = new Date(stats.lastSyncedAt);
    return t("generalTab.lastSynced", { time: dt.toLocaleTimeString() });
  }, [stats.lastSyncedAt, locale, t]);

  return (
    <SettingsSection
      title={t("generalTab.workspaceTitle")}
      description={t("generalTab.workspaceDescription")}
      actions={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{lastSyncedLabel}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t("generalTab.refreshStatsAriaLabel")}
          >
            <RefreshCw className="size-3" aria-hidden={true} />
          </Button>
        </div>
      }
    >
      <div
        role="group"
        aria-label={t("generalTab.statsGroupAriaLabel")}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <StatCard
          label={t("generalTab.statPlugins")}
          count={stats.pluginCount}
          icon={Puzzle}
          onClick={() => onNavigate("plugin-config")}
          loading={loading}
          testId="general-tab-card-plugin"
        />
        <StatCard
          label={t("generalTab.statTools")}
          count={stats.toolCount}
          icon={Wrench}
          onClick={() => onNavigate("plugin-config")}
          loading={loading}
          testId="general-tab-card-tool"
        />
        <StatCard
          label={t("generalTab.statAgents")}
          count={stats.agentCount}
          icon={Bot}
          onClick={() => onNavigate("marketplace")}
          loading={loading}
          testId="general-tab-card-agent"
        />
        <StatCard
          label={t("generalTab.statSkills")}
          count={stats.skillCount}
          icon={Sparkles}
          onClick={() => onNavigate("marketplace")}
          loading={loading}
          testId="general-tab-card-skill"
        />
        <StatCard
          label={t("generalTab.statRoles")}
          count={stats.roleCount}
          icon={UserCog}
          onClick={() => onNavigate("roles")}
          loading={loading}
          testId="general-tab-card-role"
        />
      </div>

      <button
        type="button"
        onClick={() => onNavigate("marketplace")}
        className="flex w-full items-center justify-between rounded-md border bg-card px-4 py-3 text-left transition-colors hover:border-primary/(--opacity-strong) hover:bg-accent/(--opacity-medium) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="general-tab-marketplace-status"
      >
        <div className="flex items-center gap-3">
          <Store className="size-4 text-muted-foreground" aria-hidden={true} />
          <div>
            <p className="text-sm font-medium">{t("generalTab.marketplaceLabel")}</p>
            <p className="text-[11px] text-muted-foreground">
              {stats.marketplace.configured
                ? t("generalTab.marketplaceConnectedHint")
                : t("generalTab.marketplaceNotConfigured")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-block size-2.5 rounded-full ${marketplaceStatus.dot}`} aria-hidden={true} />
          <span className="text-sm font-medium">{marketplaceStatus.label}</span>
        </div>
      </button>
    </SettingsSection>
  );
}
