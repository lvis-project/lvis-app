import { Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import {
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

type SubscriptionProviderCapabilities = SubscriptionRuntimeCapabilities;

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
}

export interface SubscriptionProviderStatus {
  runtime: SubscriptionProviderRuntimeState;
  connection: SubscriptionConnectionState;
  /** Only a short, validated one-time device code may be projected here. */
  pendingDeviceCode?: string | null;
  pendingLoginMethod?: SubscriptionLoginMethod | null;
  /** Main opens the verified address itself; the renderer never receives it. */
  canOpenLoginBrowser?: boolean;
  /** Offered in the settings page's one model chooser, never on this card. */
  models?: readonly SubscriptionProviderModel[];
  /** Whether chat is host-verified. Only `chat` is read; the rest of the
   *  projection describes the LVIS agent harness, not this provider. */
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
  /** Adopts a subscription-backed model chosen in the settings page's chooser. */
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
 * The sign-in half of one provider row, for the row's expanded body.
 *
 * The settings page draws every provider — subscription-backed, API-key-backed,
 * or both — with ONE row renderer, so the header, the state word, the sub-line
 * and the refresh live there. What stays here is the part that is specific to a
 * subscription runtime and has no API-key counterpart: choosing and verifying
 * the official local runtime, signing in, the one-time device code, and signing
 * out. Splitting it this way is what stops a provider having two headers, two
 * state words and two refresh buttons.
 *
 * The parent owns state refresh and all IPC calls, which keeps main-process
 * validation, browser launching, cancellation, and secret handling on the
 * privileged side.
 */
export function SubscriptionAuthControls({
  provider,
  actions,
}: {
  provider: SubscriptionProviderView;
  actions: SubscriptionProviderActions;
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
  const { descriptor, status } = provider;
  const runtime = status?.runtime ?? "checking";
  const connection = status?.connection ?? "unknown";
  const chatReady = connection === "connected" && status?.capabilities?.chat === true;
  const pending = connection === "pending";
  const connected = connection === "connected";
  const hasRuntimeSelection = runtime !== "not-configured" && runtime !== "checking";
  const needsRuntimeSelection = runtime === "not-configured";
  const needsVerification = runtime === "unverified" || (runtime === "ready" && connected && !chatReady);
  const isBusy = provider.busyAction !== null && provider.busyAction !== undefined;
  const disabled = provider.disabled === true || isBusy || provider.refreshPending === true;
  const safeDeviceCode = isSafeDeviceCode(status?.pendingDeviceCode)
    ? status.pendingDeviceCode
    : null;

  return (
    <div className="space-y-3" data-testid={`subscription-provider:${descriptor.id}`}>
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
    </div>
  );
}
