import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Store } from "lucide-react";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";
import type { LvisApi, MarketplaceItem } from "../types.js";
import type { MarketplacePackageType } from "../../../shared/assistant-context.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { PluginInstallDialog } from "../dialogs/PluginInstallDialog.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  buildNetworkAccessAcknowledgement,
  hasNetworkAccessDisclosure,
} from "../../../shared/network-access.js";

export interface MarketplaceTabProps {
  api: LvisApi;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  allowPrivateNetwork: boolean;
  setAllowPrivateNetwork: (v: boolean) => void;
  hasApiKey: boolean;
  setHasApiKey: (v: boolean) => void;
  apiKeyInput: string;
  setApiKeyInput: (v: string) => void;
  onSaved: () => void;
  /** Debounced immediate-apply hook — fires on private-network toggle and on
   *  the explicit URL / API key Save buttons (200ms after the React state
   *  update commits, so the save reads fresh values). */
  onImmediateChange?: () => void;
}

export function MarketplaceTab(props: MarketplaceTabProps) {
  const { t, locale } = useTranslation();
  const {
    api,
    baseUrl,
    setBaseUrl,
    allowPrivateNetwork,
    setAllowPrivateNetwork,
    hasApiKey,
    setHasApiKey,
    apiKeyInput,
    setApiKeyInput,
    onSaved,
    onImmediateChange,
  } = props;
  const [packages, setPackages] = useState<MarketplaceItem[]>([]);
  const [packageStatus, setPackageStatus] = useState(() => t("marketplaceTab.statusLoading"));
  const [filter, setFilter] = useState<"all" | MarketplacePackageType>("all");
  const [workingSlug, setWorkingSlug] = useState<string | null>(null);
  // #1098/#1279 — plugin installs that need explicit pre-install disclosure.
  const [installDialogTarget, setInstallDialogTarget] = useState<MarketplaceItem | null>(null);


  // the parent setter (and marketplace endpoint switchover) fire when Save
  // is pressed. Re-sync the draft if the parent value changes externally
  // (cross-window broadcast, initial load).
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  useEffect(() => { setUrlDraft(baseUrl); }, [baseUrl]);
  const isUrlDirty = urlDraft.trim() !== baseUrl.trim();
  const commitUrl = useCallback(() => {
    setBaseUrl(urlDraft.trim());
    // Use the debounced save scheduler instead of a synchronous flush.
    // Synchronous `s.save("marketplace")` would close over the PRE-update
    // orchestration state — `setBaseUrl` schedules a re-render and the new
    // value isn't visible to the closure until the next render. The
    // debounce gives React time to commit before firing.
    onImmediateChange?.();
  }, [urlDraft, setBaseUrl, onImmediateChange]);

  // API key — same debounced pattern. The value is already in `apiKeyInput`
  // (no separate draft); Save schedules the debounced persist.
  const commitApiKey = useCallback(() => {
    onImmediateChange?.();
  }, [onImmediateChange]);

  // "Leave without saving" warning. Fires on window close when there are
  // unsaved URL changes or a typed-but-not-saved API key. Private-network
  // toggle is immediate-apply (no dirty tracking needed).
  useEffect(() => {
    const isDirty = urlDraft.trim() !== baseUrl.trim() || apiKeyInput.trim() !== "";
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // preventDefault alone is sufficient in modern browsers / Electron
      // to trigger the native "leave?" confirm. The legacy `returnValue`
      // assignment is now deprecated (TS6385); preventDefault is the
      // standards-track replacement.
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [urlDraft, baseUrl, apiKeyInput]);


  // users keep the default endpoint with no auth.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Connection health pill for the primary CTA. Polls `pingMarketplace`
  // once on mount (and whenever the saved baseUrl changes) so the user

  const [pingState, setPingState] = useState<
    | { phase: "loading" }
    | { phase: "result"; configured: boolean; online: boolean }
  >({ phase: "loading" });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await api.pingMarketplace();
        if (alive) setPingState({ phase: "result", ...res });
      } catch {
        if (alive) setPingState({ phase: "result", configured: false, online: false });
      }
    })();
    return () => { alive = false; };
  }, [api, baseUrl]);
  const statusBadge = useMemo(() => {
    if (pingState.phase === "loading") {
      return { dot: "bg-muted-foreground/(--opacity-medium)", label: t("marketplaceTab.pingChecking") };
    }
    if (!pingState.configured) return { dot: "bg-muted-foreground/(--opacity-medium)", label: t("marketplaceTab.pingNotConnected") };
    if (pingState.online) return { dot: "bg-success", label: t("marketplaceTab.pingOk") };
    return { dot: "bg-destructive", label: t("marketplaceTab.pingNoResponse") };
  }, [pingState, locale, t]);
  const openMarketplace = useCallback(() => {
    const url = baseUrl.trim();
    if (url) void api.openExternalUrl(url);
  }, [api, baseUrl]);

  const refreshPackages = useCallback(async () => {
    try {
      const items = await api.listMarketplacePlugins();
      setPackages(items);
      setPackageStatus(t("marketplaceTab.packageCount", { count: String(items.length) }));
    } catch (err) {
      setPackageStatus(t("marketplaceTab.loadFailed", { message: (err as Error).message }));
    }
  }, [api, t]);

  useEffect(() => {
    void refreshPackages();
  }, [refreshPackages]);

  const visiblePackages = useMemo(() => (
    filter === "all"
      ? packages
      : packages.filter((item) => (item.pluginType ?? "plugin") === filter)
  ), [filter, packages]);
  const needsInstallDisclosure = useCallback((item: MarketplaceItem): boolean => {
    if ((item.pluginType ?? "plugin") !== "plugin") return false;
    return item.installPolicy === "admin" || hasNetworkAccessDisclosure(item.networkAccess);
  }, []);

  const installPackage = useCallback(async (
    item: MarketplaceItem,
    options: { networkAccessAcknowledged?: boolean } = {},
  ) => {
    const packageType = item.pluginType ?? "plugin";
    setWorkingSlug(item.id);
    try {
      if (packageType === "mcp") {
        const result = await api.installMcpFromMarketplace(item.id);
        if (!result.ok) throw new Error(result.message);
      } else if (packageType === "agent") {
        const result = await getHostMarketplaceApi().installMarketplaceAgent?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Agent install API unavailable");
      } else if (packageType === "skill") {
        const result = await getHostMarketplaceApi().installMarketplaceSkill?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Skill install API unavailable");
      } else {
        const result = await getHostMarketplaceApi().installMarketplacePlugin(
          item.id,
          undefined,
          options.networkAccessAcknowledged
            ? { networkAccessAcknowledgement: buildNetworkAccessAcknowledgement(item.networkAccess) }
            : undefined,
        );
        if (!result.ok) throw new Error(result.message ?? result.error);
      }
      await refreshPackages();
    } catch (err) {
      setPackageStatus(t("marketplaceTab.operationFailed", { message: (err as Error).message }));
    } finally {
      setWorkingSlug(null);
    }
  }, [api, refreshPackages, t]);

  const uninstallPackage = useCallback(async (item: MarketplaceItem) => {
    const packageType = item.pluginType ?? "plugin";
    setWorkingSlug(item.id);
    try {
      if (packageType === "agent") {
        const result = await getHostMarketplaceApi().uninstallMarketplaceAgent?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Agent uninstall API unavailable");
      } else if (packageType === "skill") {
        const result = await getHostMarketplaceApi().uninstallMarketplaceSkill?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Skill uninstall API unavailable");
      } else if (packageType === "plugin") {
        const result = await getHostMarketplaceApi().uninstallMarketplacePlugin(item.id);
        if (!result.ok) throw new Error(result.message ?? result.error);
      }
      await refreshPackages();
    } catch (err) {
      setPackageStatus(t("marketplaceTab.operationFailed", { message: (err as Error).message }));
    } finally {
      setWorkingSlug(null);
    }
  }, [refreshPackages, t]);

  const filterOptions: Array<{ value: "all" | MarketplacePackageType; label: string }> = [
    { value: "all", label: "All" },
    { value: "plugin", label: "Plugins" },
    { value: "mcp", label: "MCP" },
    { value: "agent", label: "Agents" },
    { value: "skill", label: "Skills" },
  ];

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("marketplaceTab.pageTitle")}
        description={t("marketplaceTab.pageDescription")}
      />

      {/* ── Primary onboarding CTA ────────────────────────────
          Big violet-gradient launcher to the marketplace web UI plus a
          tiny status dot. Most users only need this row; the connection
          / auth knobs sit behind the advanced-options collapse below so the
          surface stays decluttered. */}
      <div
        className="flex flex-col items-center gap-3 rounded-xl border border-primary/(--opacity-muted) bg-gradient-to-br from-primary/(--opacity-subtle) via-primary/(--opacity-faint) to-transparent px-4 py-6 text-center"
        data-testid="marketplace:cta"
      >
        <Button
          type="button"
          size="lg"
          onClick={openMarketplace}
          disabled={!baseUrl.trim()}
          className="bg-gradient-to-r from-primary to-primary/(--opacity-intense) px-6 py-5 text-base font-semibold shadow-md hover:from-primary/(--opacity-near) hover:to-primary/(--opacity-stronger)"
          data-testid="marketplace:cta:open"
          aria-label={t("marketplaceTab.openMarketplaceAriaLabel")}
        >
          <Store className="mr-2 size-5" aria-hidden={true} />
          {t("marketplaceTab.openMarketplaceButton")}
        </Button>
        <p className="text-sm text-muted-foreground">
          {t("marketplaceTab.browseCta")}
        </p>
        <div
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          data-testid="marketplace:cta:status"
        >
          <span
            className={`inline-block size-2 rounded-full ${statusBadge.dot}`}
            aria-hidden={true}
          />
          <span>{statusBadge.label}</span>
        </div>
      </div>

      <SettingsSection
        title={t("marketplaceTab.inventoryTitle")}
        description={packageStatus}
        actions={
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void refreshPackages()}>
            {t("marketplaceTab.refreshButton")}
          </Button>
        }
      >
        <div className="flex flex-wrap gap-1">
          {filterOptions.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={filter === option.value ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <ScrollArea className="h-64 rounded-md border">
          <div className="divide-y">
            {visiblePackages.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">{t("marketplaceTab.emptyPackages")}</div>
            ) : visiblePackages.map((item) => {
              const packageType = item.pluginType ?? "plugin";
              const isWorking = workingSlug === item.id;
              const canUninstall = item.installed && (packageType === "plugin" || packageType === "agent" || packageType === "skill");
              return (
                <div key={`${packageType}:${item.id}`} className="flex items-start justify-between gap-3 p-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 line-clamp-1 text-sm font-medium">{item.name}</span>
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">{packageType}</Badge>
                      {packageType === "mcp" && item.mcpAuth?.mode === "oauth" && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">OAuth</Badge>
                      )}
                      {item.installed && <Badge variant="default" className="h-5 px-1.5 text-[10px]">{t("marketplaceTab.installedBadge")}</Badge>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{item.description || item.packageSpec}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{item.id}</p>
                  </div>
                  <Button
                    size="sm"
                    variant={item.installed ? "outline" : "default"}
                    className="h-7 shrink-0 px-2 text-xs"
                    data-testid={`marketplace:action:${item.id}`}
                    disabled={isWorking || (item.installed && !canUninstall)}
                    onClick={() => {
                      if (item.installed) {
                        void uninstallPackage(item);
                        return;
                      }
                      // #1098/#1279 — admin-policy and networkAccess plugins
                      // show install-time disclosures before the install starts.
                      if (needsInstallDisclosure(item)) {
                        setInstallDialogTarget(item);
                        return;
                      }
                      void installPackage(item);
                    }}
                  >
                    {isWorking ? t("marketplaceTab.processingLabel") : item.installed ? t("marketplaceTab.removeButton") : t("marketplaceTab.installButton")}
                  </Button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SettingsSection>

      {/* ── Advanced options ───────────────────────────────────
          Moved to the bottom of the Marketplace tab so the primary
          surface (CTA -> package inventory) is what most users see first.
          The entire server-connection surface (URL editor + warning banner +
          API key + private-network toggle) lives behind this collapse.
          Default-deployment users never have to interact with it. */}
      <SettingsSection
        title={t("marketplaceTab.advancedTitle")}
        description={t("marketplaceTab.advancedDescription")}
      >
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded-md py-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={advancedOpen}
          data-testid="marketplace:advanced:toggle"
        >
          <span className="inline-block w-3 text-xs leading-none">{advancedOpen ? "▾" : "▸"}</span>
          {advancedOpen ? t("marketplaceTab.advancedCollapse") : t("marketplaceTab.advancedExpand")}
        </button>

        {advancedOpen && (
          <div className="space-y-4 pt-2" data-testid="marketplace:advanced:body">
            <div className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning">
              {t("marketplaceTab.applyTimingWarning")}
            </div>

            {/* URL — draft state means typing doesn't churn the marketplace
                endpoint on every keystroke; Save is disabled when draft
                equals the committed value. */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("marketplaceTab.serverUrlLabel")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="url"
                  placeholder="https://marketplace.your-corp.example"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && isUrlDirty) commitUrl(); }}
                  className="flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={commitUrl}
                  disabled={!isUrlDirty}
                  title={isUrlDirty ? t("marketplaceTab.urlSaveTitleDirty") : t("marketplaceTab.urlSaveTitleClean")}
                  data-testid="marketplace:url:save"
                >
                  {t("marketplaceTab.saveButton")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("marketplaceTab.serverUrlHelp")}
              </p>
            </div>

            {/* API key */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("marketplaceTab.apiKeyLabel")}</Label>
              <div className="flex items-center gap-2">
                {hasApiKey
                  ? <Badge variant="default" className="text-xs">{t("marketplaceTab.apiKeySet")}</Badge>
                  : <Badge variant="secondary" className="text-xs">{t("marketplaceTab.apiKeyNotSet")}</Badge>}
                {hasApiKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-destructive"
                    onClick={() => void api.deleteMarketplaceApiKey().then(() => {
                      setHasApiKey(false);
                      onSaved();
                    })}
                  >
                    {t("marketplaceTab.deleteApiKeyButton")}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  placeholder={hasApiKey ? t("marketplaceTab.apiKeyPlaceholderReplace") : t("marketplaceTab.apiKeyPlaceholderNew")}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && apiKeyInput.trim()) commitApiKey(); }}
                  className="flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={commitApiKey}
                  disabled={!apiKeyInput.trim()}
                  title={t("marketplaceTab.apiKeySaveTitle")}
                  data-testid="marketplace:apikey:save"
                >
                  {t("marketplaceTab.saveButton")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("marketplaceTab.apiKeyHelp")}
              </p>
            </div>

            {/* Private network toggle */}
            <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
              <Checkbox
                checked={allowPrivateNetwork}
                aria-labelledby="marketplace-allow-private-network-label"
                className="mt-0.5 size-5"
                onCheckedChange={(checked) => {
                  setAllowPrivateNetwork(checked === true);
                  onImmediateChange?.();
                }}
              />
              <div className="space-y-0.5">
                <p
                  id="marketplace-allow-private-network-label"
                  className="flex items-center gap-2 text-sm font-medium"
                >
                  {t("marketplaceTab.privateNetworkLabel")}
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("marketplaceTab.immediateApply")}
                  </span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t("marketplaceTab.privateNetworkHelp")}
                </p>
              </div>
            </div>
          </div>
        )}
      </SettingsSection>

      <PluginInstallDialog
        target={installDialogTarget}
        working={workingSlug === installDialogTarget?.id}
        onClose={() => setInstallDialogTarget(null)}
        onConfirm={async (id) => {
          const item = installDialogTarget?.id === id ? installDialogTarget : null;
          setInstallDialogTarget(null);
          if (item) await installPackage(item, { networkAccessAcknowledged: true });
        }}
      />
    </div>
  );
}
