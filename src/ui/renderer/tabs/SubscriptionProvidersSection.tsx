import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  type SubscriptionConnectionState,
  type SubscriptionLoginMethod,
  type SubscriptionRuntimeCapabilities,
  type SubscriptionRuntimeErrorCode,
  type SubscriptionRuntimeId,
  type SubscriptionRuntimeState,
} from "../../../shared/subscription-runtime.js";

/**
 * Renderer-safe subscription provider identifier. The main process owns any
 * executable paths, authentication URLs, account tokens, and raw runtime
 * output; none of those values belong in this UI contract.
 */
type SubscriptionProviderId = SubscriptionRuntimeId;

type SubscriptionProviderRuntimeState = SubscriptionRuntimeState | "checking";

/**
 * Width bound for the subscription model popup, above `sm`.
 *
 * Anchoring and the trigger-matched width are `SelectContent`'s own defaults
 * now. This overrides only the upper half of the trigger's `w-full sm:w-80`
 * rule: from `sm` up the trigger is a fixed 20rem control with room beside it,
 * so the popup keeps its natural width for long model ids rather than being
 * squeezed to 20rem, bounded by the space Radix reports.
 */
const MODEL_POPUP_LAYOUT =
  "sm:w-auto sm:max-w-(--radix-select-content-available-width)";

export type SubscriptionBusyAction =
  | "refresh"
  | "configure-runtime"
  | "verify-runtime"
  | "forget-runtime"
  | "login-browser"
  | "login-device-code"
  | "open-login-browser"
  | "cancel-login"
  | "logout"
  | "select-model"
  | "load-models"
  | "use-for-chat";

/** Stable, renderer-safe error codes. Raw runtime errors must be mapped in main. */
type SubscriptionProviderErrorCode = SubscriptionRuntimeErrorCode;

export interface SubscriptionProviderModel {
  /** Provider model identifier, not an account credential. */
  id: string;
  /** Main-validated model display name. */
  label: string;
  isDefault?: boolean;
}

export type SubscriptionProviderCapabilities = SubscriptionRuntimeCapabilities;

interface SubscriptionProviderDescriptor {
  id: SubscriptionProviderId;
  /** Static, browser-safe provider name, for example "Codex". */
  label: string;
  /** Static, browser-safe provider description. */
  description: string;
  loginMethods: readonly SubscriptionLoginMethod[];
  /** Whether the provider requires an official local runtime selection. */
  supportsRuntimeSelection?: boolean;
  supportsLogout?: boolean;
  /** A provider can use a server default, require a selected model, or expose none. */
  modelSelection?: "none" | "optional" | "required";
}

export interface SubscriptionProviderStatus {
  runtime: SubscriptionProviderRuntimeState;
  connection: SubscriptionConnectionState;
  /** Only a short, validated one-time device code may be projected here. */
  pendingDeviceCode?: string | null;
  pendingLoginMethod?: SubscriptionLoginMethod | null;
  /** Main opens the verified address itself; the renderer never receives it. */
  canOpenLoginBrowser?: boolean;
  models?: readonly SubscriptionProviderModel[];
  selectedModelId?: string | null;
  /** Missing capability projections are rendered as unknown, never enabled. */
  capabilities?: Partial<SubscriptionProviderCapabilities>;
  errorCode?: SubscriptionProviderErrorCode | null;
}

export interface SubscriptionProviderView {
  descriptor: SubscriptionProviderDescriptor;
  /** Omitted while the main process is still loading the safe status projection. */
  status?: SubscriptionProviderStatus | null;
  busyAction?: SubscriptionBusyAction | null;
  /** A status re-read is in flight without displacing an in-flight mutation. */
  refreshPending?: boolean;
  disabled?: boolean;
}

/** The selected subscription provider and model used by the chat runtime. */
export interface SubscriptionChatSelection {
  providerId: SubscriptionProviderId;
  modelId: string | null;
}

interface SubscriptionProviderActions {
  refreshStatus?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  configureRuntime?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  verifyRuntime?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  forgetRuntime?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  beginLogin?: (providerId: SubscriptionProviderId, method: SubscriptionLoginMethod) => void | Promise<void>;
  /** Opens a main-owned, verified login page without exposing its URL to the renderer. */
  openLoginBrowser?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  cancelLogin?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  logout?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  loadModels?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  selectModel?: (providerId: SubscriptionProviderId, modelId: string) => void | Promise<void>;
  useForChat?: (providerId: SubscriptionProviderId, modelId: string | null) => void | Promise<void>;
  /** Explicitly return chat to the separately configured API-key provider. */
  useApiForChat?: () => void | Promise<void>;
}

export interface SubscriptionProvidersSectionProps {
  /** Browser-safe provider descriptors, statuses, and capability projections only. */
  providers: readonly SubscriptionProviderView[];
  /** Main-owned active chat selection, projected without authentication data. */
  activeSelection: SubscriptionChatSelection | null;
  /** `true` when the separately configured API-key provider is the active chat path. */
  apiChatActive?: boolean;
  /** A subscription/API chat-selection request is in flight in this surface. */
  chatSelectionBusy?: boolean;
  apiChatBusy?: boolean;
  apiChatError?: SubscriptionProviderErrorCode | null;
  actions: SubscriptionProviderActions;
  /** Use a stable custom anchor only when the embedding settings page needs one. */
  sectionId?: string;
}

const DEFAULT_CAPABILITIES = DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES;

type BooleanCapabilityKey = Exclude<keyof SubscriptionProviderCapabilities, "imageAttachmentLimits">;

const CAPABILITY_ROWS: readonly {
  readonly key: BooleanCapabilityKey;
  readonly labelKey: string;
}[] = [
  { key: "chat", labelKey: "subscriptionProvidersSection.capabilityChat" },
  { key: "images", labelKey: "subscriptionProvidersSection.capabilityImages" },
  { key: "files", labelKey: "subscriptionProvidersSection.capabilityFiles" },
  { key: "tools", labelKey: "subscriptionProvidersSection.capabilityTools" },
  { key: "projectAccess", labelKey: "subscriptionProvidersSection.capabilityProject" },
  { key: "plugins", labelKey: "subscriptionProvidersSection.capabilityPlugins" },
  { key: "mcp", labelKey: "subscriptionProvidersSection.capabilityMcp" },
  { key: "generateText", labelKey: "subscriptionProvidersSection.capabilityGenerateText" },
  { key: "compaction", labelKey: "subscriptionProvidersSection.capabilityCompaction" },
  { key: "routine", labelKey: "subscriptionProvidersSection.capabilityRoutine" },
  { key: "subagent", labelKey: "subscriptionProvidersSection.capabilitySubagent" },
];

/**
 * One checklist for every connection. Subscription runtimes report verified
 * capabilities per provider; the API path reports the host-engine projection
 * (`API_PATH_RUNTIME_CAPABILITIES`). Both render through this so the two never
 * describe the same feature with different words.
 *
 * `known` carries the distinction the labels depend on: a capability the
 * runtime has not answered for is "unknown", not "unavailable".
 */
export function ProviderCapabilityGrid({
  capabilities,
  known,
  testIdPrefix,
}: {
  capabilities: SubscriptionProviderCapabilities;
  known: (key: BooleanCapabilityKey) => boolean;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  const label = (available: boolean, isKnown: boolean): string => {
    if (!isKnown) return t("subscriptionProvidersSection.capabilityUnknown");
    return t(available
      ? "subscriptionProvidersSection.capabilityAvailable"
      : "subscriptionProvidersSection.capabilityUnavailable");
  };
  return (
    <dl
      className="grid gap-2 rounded-md border bg-muted/(--opacity-muted) px-3 py-2 text-xs sm:grid-cols-2 lg:grid-cols-3"
      data-testid={`${testIdPrefix}:capabilities`}
    >
      {CAPABILITY_ROWS.map(({ key, labelKey }) => (
        <div className="space-y-0.5" key={key} data-testid={`${testIdPrefix}:capability:${key}`}>
          <dt className="font-medium text-foreground">{t(labelKey)}</dt>
          <dd className="text-muted-foreground">{label(capabilities[key], known(key))}</dd>
        </div>
      ))}
    </dl>
  );
}

export const ERROR_MESSAGE_KEYS: Record<SubscriptionProviderErrorCode, string> = {
  "subscription-provider-not-supported": "subscriptionProvidersSection.errorProviderNotSupported",
  "subscription-runtime-not-configured": "subscriptionProvidersSection.errorRuntimeNotConfigured",
  "subscription-runtime-unavailable": "subscriptionProvidersSection.errorRuntimeUnavailable",
  "subscription-login-in-progress": "subscriptionProvidersSection.errorLoginInProgress",
  "subscription-login-failed": "subscriptionProvidersSection.errorLoginFailed",
  "subscription-verification-url-unavailable": "subscriptionProvidersSection.errorVerificationUrlUnavailable",
  "subscription-logout-not-supported": "subscriptionProvidersSection.errorLogoutNotSupported",
  "subscription-chat-unavailable": "subscriptionProvidersSection.errorChatUnavailable",
  "subscription-operation-failed": "subscriptionProvidersSection.errorOperationFailed",
};

/**
 * Device codes are the sole transient authentication value this renderer may
 * display. Reject values that look like URLs, bearer tokens, or raw logs.
 */
function isSafeDeviceCode(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(value);
}

/**
 * A renderer-only common surface for subscription-backed providers.
 *
 * The parent owns state refresh and all IPC calls. That keeps main-process
 * validation, browser launching, cancellation, and secret handling on the
 * privileged side while giving Codex and ACP-backed providers one consistent
 * login/model/chat-selection experience.
 */

/**
 * One provider's row.
 *
 * Extracted so the settings page can lay subscription providers and API-key
 * providers out in ONE list. Two row renderers would drift, and a user cannot
 * be expected to learn that "connected" means one thing on the left of a page
 * and another on the right.
 *
 * `leading` is where the embedding list contributes what it knows and this
 * component cannot — the API-key half of a provider that has both.
 */
export function SubscriptionProviderRow({
  provider,
  activeSelection,
  chatSelectionBusy = false,
  actions,
  label,
  leading,
  subline,
  authAction,
  trailing,
  routeName,
}: {
  provider: SubscriptionProviderView;
  /** The name the embedding list uses — the company, not the runtime. */
  label?: string;
  activeSelection: SubscriptionChatSelection | null;
  chatSelectionBusy?: boolean;
  actions: SubscriptionProviderActions;
  /** Contributed beside the provider name — the API-key half of this provider. */
  leading?: ReactNode;
  /** Contributed under the provider name — what the API half reaches and what
   *  its last model-list handshake did. */
  subline?: ReactNode;
  /** Contributed among the sign-in buttons — the API-key route is one of the
   *  ways in, so it belongs with the others rather than beside the name. */
  authAction?: ReactNode;
  /** Contributed at the end of the row — the API-key credential form. */
  trailing?: ReactNode;
  /** Names the route this row's connection state is about. Given when the
   *  provider is reachable a second way as well, so "connected" here and
   *  "not set" on the API-key chip beside it read as two routes, not as one
   *  row contradicting itself. */
  routeName?: string;
}) {
  const { t } = useTranslation();
  const invoke = (operation: (() => void | Promise<void>) | undefined) => {
    if (!operation) return;
    try {
      // The parent maps rejected IPC operations to a safe status.errorCode.
      // Never surface an arbitrary runtime exception in the renderer.
      void Promise.resolve(operation()).catch(() => undefined);
    } catch {
      // Synchronous callback failures follow the same safe parent-state path.
    }
  };
  const statusLabel = (status: SubscriptionProviderStatus | null | undefined): string => {
    if (!status || status.runtime === "checking" || status.connection === "unknown") {
      return t("subscriptionProvidersSection.statusChecking");
    }
    if (status.runtime === "not-configured") return t("subscriptionProvidersSection.statusRuntimeNotConfigured");
    if (status.runtime === "unverified") return t("subscriptionProvidersSection.statusRuntimeUnverified");
    if (status.runtime === "unavailable") return t("subscriptionProvidersSection.statusRuntimeUnavailable");
    if (status.connection === "pending") {
      return status.pendingLoginMethod === "device-code"
        ? t("subscriptionProvidersSection.statusDeviceCodePending")
        : t("subscriptionProvidersSection.statusBrowserPending");
    }
    if (status.connection === "connected") return t("subscriptionProvidersSection.statusConnected");
    if (status.connection === "signed-out") return t("subscriptionProvidersSection.statusSignedOut");
    return t("subscriptionProvidersSection.statusReady");
  };
  const { descriptor, status } = provider;
  const runtime = status?.runtime ?? "checking";
  const connection = status?.connection ?? "unknown";
  const capabilities = { ...DEFAULT_CAPABILITIES, ...status?.capabilities };
  const models = status?.models ?? [];
  const selectedModelId = status?.selectedModelId
    ?? (activeSelection?.providerId === descriptor.id ? activeSelection.modelId : null);
  const activeForChat = activeSelection?.providerId === descriptor.id;
  const chatReady = connection === "connected" && capabilities.chat === true;
  const pending = connection === "pending";
  const connected = connection === "connected";
  const runtimeUnavailable = runtime === "unavailable";
  const hasRuntimeSelection = runtime !== "not-configured" && runtime !== "checking";
  const needsRuntimeSelection = runtime === "not-configured";
  const needsVerification = runtime === "unverified" || (runtime === "ready" && connected && !chatReady);
  const isBusy = provider.busyAction !== null && provider.busyAction !== undefined;
  const isRefreshing = provider.refreshPending === true;
  const disabled = provider.disabled === true || isBusy || isRefreshing;
  const requiresModel = descriptor.modelSelection === "required";
  const canUseForChat = chatReady && (!requiresModel || selectedModelId !== null);
  const safeDeviceCode = isSafeDeviceCode(status?.pendingDeviceCode)
    ? status.pendingDeviceCode
    : null;

  return (
    <div
      className="space-y-3 rounded-md border bg-card p-3"
      data-provider-row={descriptor.id}
      data-testid={`subscription-provider:${descriptor.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2" aria-live="polite">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{label ?? descriptor.label}</span>
            {leading}
            <Badge
              variant={connected ? "default" : "secondary"}
              className={runtimeUnavailable ? "bg-destructive text-destructive-foreground" : undefined}
              data-testid={`subscription-provider:${descriptor.id}:connection`}
            >
              {routeName
                ? t("subscriptionProvidersSection.routeStatus", { route: routeName, status: statusLabel(status) })
                : statusLabel(status)}
            </Badge>
            {activeForChat ? (
              <Badge
                variant={chatReady ? "default" : "outline"}
                data-testid={`subscription-provider:${descriptor.id}:active-selection`}
              >
                {chatReady
                  ? t("subscriptionProvidersSection.usedForChat")
                  : t("subscriptionProvidersSection.selectedForChat")}
              </Badge>
            ) : null}
          </div>
          {descriptor.description ? (
            <p className="text-xs text-muted-foreground">{descriptor.description}</p>
          ) : null}
          {subline}
        </div>
        {actions.refreshStatus ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => invoke(() => actions.refreshStatus?.(descriptor.id))}
            disabled={disabled}
            aria-label={t("subscriptionProvidersSection.refreshStatus", { provider: descriptor.label })}
            data-testid={`subscription-provider:${descriptor.id}:refresh`}
          >
            {isRefreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </Button>
        ) : null}
      </div>

      {status?.errorCode ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
          data-testid={`subscription-provider:${descriptor.id}:error`}
        >
          {t(ERROR_MESSAGE_KEYS[status.errorCode])}
        </p>
      ) : null}

      {pending ? (
        <div className="space-y-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
          <p>{t("subscriptionProvidersSection.loginPendingNotice")}</p>
          {safeDeviceCode ? (
            <div className="space-y-1 rounded-sm bg-muted/(--opacity-muted) px-2 py-2">
              <p className="font-medium text-foreground">{t("subscriptionProvidersSection.deviceCodeLabel")}</p>
              <code
                className="block select-all break-all rounded bg-background px-2 py-1 font-mono text-sm text-foreground"
                data-testid={`subscription-provider:${descriptor.id}:device-code`}
              >
                {safeDeviceCode}
              </code>
              <p>{t("subscriptionProvidersSection.deviceCodeHint")}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <ProviderCapabilityGrid
        capabilities={capabilities}
        known={(key) => status?.capabilities?.[key] !== undefined}
        testIdPrefix={`subscription-provider:${descriptor.id}`}
      />

      {connected && descriptor.modelSelection !== "none" ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t("subscriptionProvidersSection.modelLabel")}</p>
          {actions.loadModels ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => invoke(() => actions.loadModels?.(descriptor.id))}
              disabled={disabled}
              data-testid={`subscription-provider:${descriptor.id}:load-models`}
            >
              {provider.busyAction === "load-models" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
              {provider.busyAction === "load-models"
                ? t("subscriptionProvidersSection.loadingModels")
                : t("subscriptionProvidersSection.loadModels")}
            </Button>
          ) : null}
          {models.length > 0 ? (
            <Select
              value={selectedModelId ?? undefined}
              onValueChange={(modelId) => invoke(() => actions.selectModel?.(descriptor.id, modelId))}
              disabled={disabled || !actions.selectModel}
            >
              <SelectTrigger
                className="w-full sm:w-80"
                aria-label={t("subscriptionProvidersSection.modelSelect", { provider: descriptor.label })}
                data-testid={`subscription-provider:${descriptor.id}:model-select`}
              >
                <SelectValue placeholder={t("subscriptionProvidersSection.modelPlaceholder")} />
              </SelectTrigger>
              <SelectContent className={MODEL_POPUP_LAYOUT}>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate">{model.label}</span>
                      {model.isDefault ? (
                        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                          {t("subscriptionProvidersSection.defaultModel")}
                        </Badge>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid={`subscription-provider:${descriptor.id}:no-models`}>
              {t("subscriptionProvidersSection.noModels")}
            </p>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {needsRuntimeSelection && descriptor.supportsRuntimeSelection && actions.configureRuntime ? (
          <Button
            type="button"
            size="sm"
            onClick={() => invoke(() => actions.configureRuntime?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:configure-runtime`}
          >
            {provider.busyAction === "configure-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "configure-runtime"
              ? t("subscriptionProvidersSection.configuringRuntime")
              : t("subscriptionProvidersSection.configureRuntime")}
          </Button>
        ) : null}
        {hasRuntimeSelection && descriptor.supportsRuntimeSelection && actions.configureRuntime ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.configureRuntime?.(descriptor.id))}
            disabled={disabled || pending}
            data-testid={`subscription-provider:${descriptor.id}:change-runtime`}
          >
            {provider.busyAction === "configure-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "configure-runtime"
              ? t("subscriptionProvidersSection.configuringRuntime")
              : t("subscriptionProvidersSection.changeRuntime")}
          </Button>
        ) : null}

        {hasRuntimeSelection && descriptor.supportsRuntimeSelection && actions.forgetRuntime ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => invoke(() => actions.forgetRuntime?.(descriptor.id))}
            disabled={disabled || pending}
            data-testid={`subscription-provider:${descriptor.id}:forget-runtime`}
          >
            {provider.busyAction === "forget-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "forget-runtime"
              ? t("subscriptionProvidersSection.forgettingRuntime")
              : t("subscriptionProvidersSection.forgetRuntime")}
          </Button>
        ) : null}
        {needsVerification && actions.verifyRuntime ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.verifyRuntime?.(descriptor.id))}
            disabled={disabled || pending}
            data-testid={`subscription-provider:${descriptor.id}:verify-runtime`}
          >
            {provider.busyAction === "verify-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "verify-runtime"
              ? t("subscriptionProvidersSection.verifyingRuntime")
              : t("subscriptionProvidersSection.verifyRuntime")}
          </Button>
        ) : null}

        {pending && status?.canOpenLoginBrowser && actions.openLoginBrowser ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.openLoginBrowser?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:open-login-browser`}
          >
            {provider.busyAction === "open-login-browser" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "open-login-browser"
              ? t("subscriptionProvidersSection.openingLoginBrowser")
              : t("subscriptionProvidersSection.openLoginBrowser")}
          </Button>
        ) : null}

        {pending && actions.cancelLogin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.cancelLogin?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:cancel-login`}
          >
            {provider.busyAction === "cancel-login" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "cancel-login"
              ? t("subscriptionProvidersSection.cancellingLogin")
              : t("subscriptionProvidersSection.cancelLogin")}
          </Button>
        ) : null}

        {!pending && !connected && runtime === "ready" ? descriptor.loginMethods.map((method) => (
          <Button
            key={method}
            type="button"
            size="sm"
            variant={method === "browser" ? "default" : "outline"}
            onClick={() => invoke(() => actions.beginLogin?.(descriptor.id, method))}
            disabled={disabled || !actions.beginLogin}
            data-testid={`subscription-provider:${descriptor.id}:login-${method}`}
          >
            {provider.busyAction === `login-${method}` ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === `login-${method}`
              ? t("subscriptionProvidersSection.startingLogin")
              : method === "browser"
                ? t("subscriptionProvidersSection.loginBrowser")
                : t("subscriptionProvidersSection.loginDeviceCode")}
          </Button>
        )) : null}

        {authAction}

        {connected && actions.useForChat ? (
          <Button
            type="button"
            size="sm"
            onClick={() => invoke(() => actions.useForChat?.(descriptor.id, selectedModelId))}
            disabled={disabled || chatSelectionBusy || !canUseForChat}
            title={requiresModel && !selectedModelId ? t("subscriptionProvidersSection.selectModelBeforeChat") : undefined}
            data-testid={`subscription-provider:${descriptor.id}:use-for-chat`}
          >
            {provider.busyAction === "use-for-chat" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "use-for-chat"
              ? t("subscriptionProvidersSection.usingForChat")
              : activeForChat
                ? t("subscriptionProvidersSection.usedForChat")
                : t("subscriptionProvidersSection.useForChat")}
          </Button>
        ) : null}

        {connected && descriptor.supportsLogout && actions.logout ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => invoke(() => actions.logout?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:logout`}
          >
            {provider.busyAction === "logout" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "logout"
              ? t("subscriptionProvidersSection.signingOut")
              : t("subscriptionProvidersSection.signOut")}
          </Button>
        ) : null}
      </div>

      {activeForChat && !chatReady ? (
        <p className="text-xs text-muted-foreground" data-testid={`subscription-provider:${descriptor.id}:active-selection-not-ready`}>
          {t("subscriptionProvidersSection.activeSelectionNotReady")}
        </p>
      ) : null}
      {trailing}
    </div>
  );
}
