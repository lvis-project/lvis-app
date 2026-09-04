import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Switch } from "../../../components/ui/switch.js";
import { Store } from "lucide-react";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";
import { isIpcErrorResult, type LvisApi, type MarketplaceItem } from "../types.js";
import type { MarketplaceSettings } from "../../../data/settings-store.js";
import {
  MARKETPLACE_PACKAGE_FILTER_OPTIONS,
  canInstallMarketplacePackageType,
  canUninstallMarketplacePackageType,
  isMarketplaceAssetPackageType,
  marketplacePackageLabel,
  marketplacePackageTypeOf,
  marketplaceTrustLabelKeysForPackage,
  type MarketplacePackageFilter,
} from "../../../shared/marketplace-package-sections.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { PluginInstallDialog } from "../dialogs/PluginInstallDialog.js";
import { mergeMarketplaceCandidates } from "../marketplace-candidates.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  buildNetworkAccessAcknowledgement,
  hasNetworkAccessDisclosure,
} from "../../../shared/network-access.js";
import {
  marketplaceMessagingConnectionFromAsset,
  marketplaceProviderPresetFromAsset,
} from "../../../shared/marketplace-package-assets.js";
import { isMarketplaceEligibleLLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { errorMessage } from "../../../shared/error-message.js";

type MarketplaceAssetInstallState = Pick<
  MarketplaceSettings,
  | "installedProviderIds"
  | "installedProviderPresets"
  | "installedThemeBundleIds"
  | "installedLanguagePacks"
  | "installedMessagingConnections"
>;

const NO_ASSETS_INSTALLED: MarketplaceAssetInstallState = {
  installedProviderIds: [],
  installedProviderPresets: [],
  installedThemeBundleIds: [],
  installedLanguagePacks: [],
  installedMessagingConnections: [],
};

function installedAssetsFromMarketplace(
  marketplace?: Partial<MarketplaceSettings>,
): MarketplaceAssetInstallState {
  return {
    installedProviderIds: Array.isArray(marketplace?.installedProviderIds)
      ? marketplace.installedProviderIds
      : [],
    installedProviderPresets: Array.isArray(marketplace?.installedProviderPresets)
      ? marketplace.installedProviderPresets
      : [],
    installedThemeBundleIds: Array.isArray(marketplace?.installedThemeBundleIds)
      ? marketplace.installedThemeBundleIds
      : [],
    installedLanguagePacks: Array.isArray(marketplace?.installedLanguagePacks)
      ? marketplace.installedLanguagePacks
      : [],
    installedMessagingConnections: Array.isArray(marketplace?.installedMessagingConnections)
      ? marketplace.installedMessagingConnections
      : [],
  };
}

function isMarketplaceAssetPackage(item: MarketplaceItem): boolean {
  const packageType = marketplacePackageTypeOf(item);
  return (
    packageType !== undefined &&
    isMarketplaceAssetPackageType(packageType) &&
    item.packageAsset?.type === packageType
  );
}

/**
 * A row this build can show but not install: an asset package whose payload it
 * cannot read, or a row of a kind released after this app. Both are answered
 * the same way — name it, and say LVIS has to be updated.
 */
function isUnsupportedMarketplaceAssetPackage(item: MarketplaceItem): boolean {
  const packageType = marketplacePackageTypeOf(item);
  if (packageType === undefined) return true;
  return isMarketplaceAssetPackageType(packageType) && !isMarketplaceAssetPackage(item);
}

function isMarketplaceAssetInstalled(
  item: MarketplaceItem,
  installed: MarketplaceAssetInstallState,
): boolean {
  const asset = item.packageAsset;
  if (!asset) return false;
  if (asset.type === "provider") {
    if (isMarketplaceEligibleLLMVendor(asset.providerId)) {
      return installed.installedProviderIds.includes(asset.providerId);
    }
    return installed.installedProviderPresets.some(
      (preset) => preset.providerId === asset.providerId,
    );
  }
  if (asset.type === "theme") {
    return installed.installedThemeBundleIds.includes(asset.bundleId);
  }
  if (asset.type === "messaging-connection") {
    return installed.installedMessagingConnections.some(
      (connection) => connection.connectionId === asset.connectionId,
    );
  }
  return installed.installedLanguagePacks.includes(asset.locale);
}

function withMarketplaceAssetInstallState(
  items: readonly MarketplaceItem[],
  installed: MarketplaceAssetInstallState,
): MarketplaceItem[] {
  return items.map((item) => {
    if (!isMarketplaceAssetPackage(item)) return item;
    return {
      ...item,
      installed: isMarketplaceAssetInstalled(item, installed),
      enabled: isMarketplaceAssetInstalled(item, installed),
    };
  });
}

function addUnique<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function removeValue<T>(values: readonly T[], value: T): T[] {
  return values.filter((entry) => entry !== value);
}

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
  initialFilter?: MarketplacePackageFilter;
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
    initialFilter = "all",
  } = props;
  const [packages, setPackages] = useState<MarketplaceItem[]>([]);
  const [packageStatus, setPackageStatus] = useState(() => t("marketplaceTab.statusLoading"));
  const [filter, setFilter] = useState<MarketplacePackageFilter>(initialFilter);
  const [workingSlug, setWorkingSlug] = useState<string | null>(null);
  // The package a pre-install disclosure is open for, if any.
  const [installDialogTarget, setInstallDialogTarget] = useState<MarketplaceItem | null>(null);

  // Update check + offline cache. Both were environment-only flags
  // (`LVIS_MARKETPLACE_UPDATE_CHECK`, `LVIS_MARKETPLACE_USE_CACHE`), which a
  // packaged app's user has no way to set. They are ordinary settings now; the
  // environment still decides when a deployment sets it, and the notice below
  // says so rather than showing a switch that does nothing.
  const envForcedPaths = useEnvForcedSettings(api);
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(true);
  const [offlineCacheEnabled, setOfflineCacheEnabled] = useState(true);
  const [marketplaceFlagsLoaded, setMarketplaceFlagsLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const settings = await api.getSettings();
      if (!alive) return;
      setUpdateCheckEnabled(settings.marketplace?.updateCheckEnabled ?? true);
      setOfflineCacheEnabled(settings.marketplace?.offlineCacheEnabled ?? true);
      setMarketplaceFlagsLoaded(true);
    })();
    return () => { alive = false; };
  }, [api]);
  const persistMarketplaceFlag = useCallback(async (
    patch: Partial<MarketplaceSettings>,
  ) => {
    const result = await api.updateSettings({ marketplace: patch });
    if (isIpcErrorResult(result)) {
      throw new Error(result.message ?? result.error);
    }
    onSaved();
  }, [api, onSaved]);
  useEffect(() => {
    setFilter(initialFilter);
  }, [initialFilter]);


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
      const [items, settings] = await Promise.all([
        api.listMarketplacePlugins(),
        api.getSettings(),
      ]);
      const mergedItems = withMarketplaceAssetInstallState(
        mergeMarketplaceCandidates(items),
        installedAssetsFromMarketplace(settings.marketplace),
      );
      setPackages(mergedItems);
      setPackageStatus(t("marketplaceTab.packageCount", { count: String(mergedItems.length) }));
    } catch (err) {
      let installed: MarketplaceAssetInstallState = NO_ASSETS_INSTALLED;
      try {
        const settings = await api.getSettings();
        installed = installedAssetsFromMarketplace(settings.marketplace);
      } catch {
        /* keep empty install state */
      }
      setPackages(withMarketplaceAssetInstallState(mergeMarketplaceCandidates([]), installed));
      setPackageStatus(t("marketplaceTab.loadFailed", { message: errorMessage(err) }));
    }
  }, [api, t]);

  useEffect(() => {
    void refreshPackages();
  }, [refreshPackages]);

  // A row of an unrecognised kind belongs to no filter, so it appears only
  // under "all" — a kind filter that listed it would be claiming to know it.
  const visiblePackages = useMemo(() => (
    filter === "all"
      ? packages
      : packages.filter((item) => marketplacePackageTypeOf(item) === filter)
  ), [filter, packages]);
  const needsInstallDisclosure = useCallback((item: MarketplaceItem): boolean => {
    if (marketplacePackageTypeOf(item) !== "plugin") return false;
    return item.installPolicy === "admin" || hasNetworkAccessDisclosure(item.networkAccess);
  }, []);

  const updateMarketplaceAssetInstall = useCallback(async (
    item: MarketplaceItem,
    install: boolean,
  ) => {
    const asset = item.packageAsset;
    if (!asset) {
      throw new Error("Marketplace package is missing asset metadata");
    }
    const settings = await api.getSettings();
    const installed = installedAssetsFromMarketplace(settings.marketplace);
    const marketplace: Partial<MarketplaceSettings> = {};
    const llmVendorsPatch: Record<string, { model?: string; baseUrl?: string }> = {};
    if (asset.type === "provider") {
      if (isMarketplaceEligibleLLMVendor(asset.providerId)) {
        marketplace.installedProviderIds = install
          ? addUnique(installed.installedProviderIds, asset.providerId)
          : removeValue(installed.installedProviderIds, asset.providerId);
        if (install && (asset.defaultModel || asset.baseUrl)) {
          llmVendorsPatch[asset.providerId] = {
            ...(asset.defaultModel ? { model: asset.defaultModel } : {}),
            ...(asset.baseUrl ? { baseUrl: asset.baseUrl } : {}),
          };
        }
      } else {
        const preset = marketplaceProviderPresetFromAsset(asset, item.name);
        if (!preset) {
          throw new Error("Marketplace provider package is missing preset metadata");
        }
        const result = install
          ? await api.installMarketplaceProviderPreset(preset)
          : await api.uninstallMarketplaceProviderPreset(preset.providerId);
        if (isIpcErrorResult(result)) {
          throw new Error(result.message ?? result.error);
        }
        return;
      }
    } else if (asset.type === "theme") {
      marketplace.installedThemeBundleIds = install
        ? addUnique(installed.installedThemeBundleIds, asset.bundleId)
        : removeValue(installed.installedThemeBundleIds, asset.bundleId);
    } else if (asset.type === "messaging-connection") {
      // The declaration only. Whatever the connection asks its owner for is
      // entered in the connection's own surface and stored encrypted there.
      const connection = marketplaceMessagingConnectionFromAsset(asset);
      if (!connection) {
        throw new Error("Marketplace messaging connection is missing its declaration");
      }
      const remaining = installed.installedMessagingConnections.filter(
        (entry) => entry.connectionId !== connection.connectionId,
      );
      marketplace.installedMessagingConnections = install
        ? [...remaining, connection]
        : remaining;
    } else {
      marketplace.installedLanguagePacks = install
        ? addUnique(installed.installedLanguagePacks, asset.locale)
        : removeValue(installed.installedLanguagePacks, asset.locale);
    }
    const result = await api.updateSettings({
      marketplace,
      ...(Object.keys(llmVendorsPatch).length > 0
        ? { llm: { vendors: llmVendorsPatch } }
        : {}),
    });
    if (isIpcErrorResult(result)) {
      throw new Error(result.message ?? result.error);
    }
  }, [api]);

  const installPackage = useCallback(async (
    item: MarketplaceItem,
    options: { networkAccessAcknowledged?: boolean } = {},
  ) => {
    if (item.upgradeRequired) {
      setPackageStatus(item.upgradeRequired.message);
      return;
    }
    const packageType = marketplacePackageTypeOf(item);
    if (packageType === undefined) {
      setPackageStatus(t("marketplaceTab.unsupportedAssetPackageTitle"));
      return;
    }
    setWorkingSlug(item.id);
    try {
      if (isMarketplaceAssetPackage(item)) {
        await updateMarketplaceAssetInstall(item, true);
      } else if (packageType === "mcp") {
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
      setPackageStatus(t("marketplaceTab.operationFailed", { message: errorMessage(err) }));
    } finally {
      setWorkingSlug(null);
    }
  }, [api, refreshPackages, t, updateMarketplaceAssetInstall]);

  const uninstallPackage = useCallback(async (item: MarketplaceItem) => {
    const packageType = marketplacePackageTypeOf(item);
    setWorkingSlug(item.id);
    try {
      if (isMarketplaceAssetPackage(item)) {
        await updateMarketplaceAssetInstall(item, false);
      } else if (packageType === "agent") {
        const result = await getHostMarketplaceApi().uninstallMarketplaceAgent?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Agent uninstall API unavailable");
      } else if (packageType === "skill") {
        const result = await getHostMarketplaceApi().uninstallMarketplaceSkill?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Skill uninstall API unavailable");
      } else if (packageType === "mcp") {
        await window.lvis.mcp.removeConfig(item.id);
      } else if (packageType === "plugin") {
        const result = await getHostMarketplaceApi().uninstallMarketplacePlugin(item.id);
        if (!result.ok) throw new Error(result.message ?? result.error);
      }
      await refreshPackages();
    } catch (err) {
      setPackageStatus(t("marketplaceTab.operationFailed", { message: errorMessage(err) }));
    } finally {
      setWorkingSlug(null);
    }
  }, [refreshPackages, t, updateMarketplaceAssetInstall]);

  const rollbackPackage = useCallback(async (item: MarketplaceItem) => {
    setWorkingSlug(item.id);
    try {
      const result = await getHostMarketplaceApi().rollbackMarketplacePlugin?.(item.id);
      if (!result?.ok) {
        throw new Error(result?.message ?? result?.error ?? "Plugin rollback API unavailable");
      }
      await refreshPackages();
    } catch (err) {
      setPackageStatus(t("marketplaceTab.operationFailed", { message: errorMessage(err) }));
    } finally {
      setWorkingSlug(null);
    }
  }, [refreshPackages, t]);

  const filterOptions = MARKETPLACE_PACKAGE_FILTER_OPTIONS;

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
        data-settings-section="marketplace-inventory"
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
              const packageType = marketplacePackageTypeOf(item);
              // What the catalog called it, which is the only name this build
              // has for a kind it does not know.
              const declaredKind = packageType ?? item.unsupportedPackageKind ?? "";
              const isWorking = workingSlug === item.id;
              const upgradeRequired = item.upgradeRequired;
              const supportedAssetPackage = isMarketplaceAssetPackage(item);
              const unsupportedAssetPackage = isUnsupportedMarketplaceAssetPackage(item);
              const canInstall = !upgradeRequired
                && packageType !== undefined
                && canInstallMarketplacePackageType(packageType, {
                  hasSupportedAsset: supportedAssetPackage,
                });
              const canUninstall = item.installed && packageType !== undefined && (
                canUninstallMarketplacePackageType(packageType, {
                  hasSupportedAsset: supportedAssetPackage,
                })
              );
              const actionDisabled = isWorking || (item.installed ? !canUninstall : !canInstall);
              const actionLabel = isWorking
                ? t("marketplaceTab.processingLabel")
                : item.installed
                  ? t("marketplaceTab.removeButton")
                  : upgradeRequired
                    ? "Update LVIS"
                    : unsupportedAssetPackage
                      ? t("marketplaceTab.unsupportedAssetPackageButton")
                      : canInstall
                        ? t("marketplaceTab.installButton")
                        : t("marketplaceTab.comingSoon");
              const unavailableTitle = upgradeRequired
                ? upgradeRequired.message
                : packageType === undefined
                  ? t("marketplaceTab.unsupportedAssetPackageTitle")
                  : canInstall
                    ? undefined
                    : unsupportedAssetPackage
                      ? t("marketplaceTab.unsupportedAssetPackageTitle")
                      : t("marketplaceTab.packageInstallUnavailableTitle", {
                        label: marketplacePackageLabel(packageType),
                      });
              const trustLabelKeys = packageType === undefined
                ? []
                : marketplaceTrustLabelKeysForPackage(packageType, {
                  hasSupportedAsset: supportedAssetPackage,
                });
              return (
                <div key={`${declaredKind}:${item.id}`} className="flex items-start justify-between gap-3 p-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 line-clamp-1 text-sm font-medium">{item.name}</span>
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">{declaredKind}</Badge>
                      {packageType === "mcp" && item.mcpAuth?.mode === "oauth" && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">OAuth</Badge>
                      )}
                      {item.installed && <Badge variant="default" className="h-5 px-1.5 text-[10px]">{t("marketplaceTab.installedBadge")}</Badge>}
                      {upgradeRequired && (
                        <Badge
                          variant="outline"
                          className="h-5 px-1.5 text-[10px]"
                          data-testid={`marketplace:upgrade-required:${item.id}`}
                        >
                          Update LVIS
                        </Badge>
                      )}
                      {unsupportedAssetPackage && (
                        <Badge
                          variant="outline"
                          className="h-5 px-1.5 text-[10px]"
                          data-testid={`marketplace:unsupported-asset:${item.id}`}
                        >
                          {t("marketplaceTab.unsupportedAssetPackageBadge")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{item.description || item.packageSpec}</p>
                    {upgradeRequired && (
                      <p
                        className="mt-0.5 text-[11px] text-warning"
                        data-testid={`marketplace:upgrade-required-message:${item.id}`}
                      >
                        {upgradeRequired.message}
                      </p>
                    )}
                    {trustLabelKeys.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1" data-testid={`marketplace:trust:${item.id}`}>
                        {trustLabelKeys.map((key) => (
                          <Badge key={key} variant="outline" className="h-5 px-1.5 text-[10px]">
                            {t(key)}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{item.id}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {item.installed && packageType === "plugin" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        data-testid={`marketplace:rollback:${item.id}`}
                        disabled={isWorking}
                        onClick={() => void rollbackPackage(item)}
                      >
                        {t("marketplaceTab.rollbackButton")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={item.installed ? "outline" : "default"}
                      className="h-7 px-2 text-xs"
                      data-testid={`marketplace:action:${item.id}`}
                      disabled={actionDisabled}
                      title={unavailableTitle}
                      onClick={() => {
                        if (item.installed) {
                          void uninstallPackage(item);
                          return;
                        }
                        // Admin-policy and networkAccess plugins
                        // show install-time disclosures before the install starts.
                        if (needsInstallDisclosure(item)) {
                          setInstallDialogTarget(item);
                          return;
                        }
                        void installPackage(item);
                      }}
                    >
                      {actionLabel}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SettingsSection>

      {/* Update check + offline cache — plain on/off settings that used to be
          reachable only through the environment. */}
      <SettingsSection
        data-settings-section="marketplace-maintenance"
        title={t("marketplaceTab.maintenanceTitle")}
        description={t("marketplaceTab.maintenanceDescription")}
      >
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">
            {t("marketplaceTab.updateCheckLabel")}
          </span>
          <Switch
            checked={updateCheckEnabled}
            disabled={!marketplaceFlagsLoaded}
            aria-label={t("marketplaceTab.updateCheckLabel")}
            data-testid="marketplace:update-check"
            onCheckedChange={(checked) => {
              setUpdateCheckEnabled(checked);
              void persistMarketplaceFlag({ updateCheckEnabled: checked });
            }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="marketplace:update-check:help">
          {t("marketplaceTab.updateCheckHelp")}
        </p>
        <EnvForcedNotice
          settingsPath="marketplace.updateCheckEnabled"
          forcedPaths={envForcedPaths}
          messageKey="marketplaceTab.updateCheckEnvForced"
          testId="marketplace:update-check:forced"
          className="mt-2"
        />

        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">
            {t("marketplaceTab.offlineCacheLabel")}
          </span>
          <Switch
            checked={offlineCacheEnabled}
            disabled={!marketplaceFlagsLoaded}
            aria-label={t("marketplaceTab.offlineCacheLabel")}
            data-testid="marketplace:offline-cache"
            onCheckedChange={(checked) => {
              setOfflineCacheEnabled(checked);
              void persistMarketplaceFlag({ offlineCacheEnabled: checked });
            }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="marketplace:offline-cache:help">
          {t("marketplaceTab.offlineCacheHelp")}
        </p>
        <EnvForcedNotice
          settingsPath="marketplace.offlineCacheEnabled"
          forcedPaths={envForcedPaths}
          messageKey="marketplaceTab.offlineCacheEnvForced"
          testId="marketplace:offline-cache:forced"
          className="mt-2"
        />
      </SettingsSection>

      {/* ── Advanced options ───────────────────────────────────
          Moved to the bottom of the Marketplace tab so the primary
          surface (CTA -> package inventory) is what most users see first.
          The entire server-connection surface (URL editor + warning banner +
          API key + private-network toggle) lives behind this collapse.
          Default-deployment users never have to interact with it. */}
      <SettingsSection
        data-settings-section="marketplace-advanced"
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
