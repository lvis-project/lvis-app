/**
 * ComposerApiKeyChip — the "no LLM credential yet" affordance.
 *
 * Lives in the composer's reserved top zone, mirrored across from
 * `ComposerProjectSelector` (which sits at `left-0` in the same strip). Being an
 * absolutely-positioned chip plus an overlay popover, it contributes ZERO layout
 * height — which is the whole point: it replaced a `min-h-[min(12rem,36vh)]`
 * transcript card whose vertical footprint forced `ChatView` to shrink the
 * centered composer's lift (`centeredLift="compact"`) just to make room. With
 * the card gone the composer stays optically centered on an empty conversation.
 *
 * Render condition is a single flag: `hasApiKey === false`. That prop is
 * `App.tsx`'s `effectiveLlmReady`, which already ORs in `llmReadyWithoutApiKey`
 * — so a keyless-ready session (a reachable local Ollama, or an
 * OpenAI-compatible vendor with a `baseUrl`) never renders the
 * chip. `null` means the boot probe has not resolved; we stay silent then, same
 * as the card did, so no fake "log in" flash paints before the probe lands.
 *
 * Both destinations from the old card are preserved — settings for a provider
 * key, marketplace for a keyless local/router provider — so nothing is lost by
 * collapsing it into a popover. Copy reuses the card's existing `chatView.*`
 * message keys verbatim.
 */
import { KeyRound, Store } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";

import type { SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
export interface ComposerApiKeyChipProps {
  subscriptionPendingProvider?: string;
  subscriptionRuntimePolicy?: SubscriptionRuntimeUiPolicy;
  onOpenSettings: (tab?: string) => void;
  subscriptionUnavailableProvider?: string;
}

export function ComposerApiKeyChip({
  onOpenSettings,
  subscriptionUnavailableProvider,
  subscriptionRuntimePolicy,
  subscriptionPendingProvider,
}: ComposerApiKeyChipProps) {
  const { t } = useTranslation();
  const subscriptionUnavailable = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.chatUnavailable
    : subscriptionUnavailableProvider !== undefined;
  const subscriptionPending = subscriptionRuntimePolicy ? subscriptionRuntimePolicy.chatPending : subscriptionPendingProvider !== undefined;
  const subscriptionIssue = subscriptionUnavailable || subscriptionPending;
  const title = subscriptionPending
    ? t("subscriptionProvidersSection.statusChecking")
    : subscriptionUnavailable
    ? t("formatIpcError.subscriptionChatUnavailable")
    : t("chatView.noApiKeyTitle");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={subscriptionIssue ? "composer-subscription-runtime-chip" : "composer-api-key-chip"}
          className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-secondary px-2.5 py-1 text-[11px] text-secondary-foreground transition-colors hover:bg-muted"
        >
          <KeyRound className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          {title}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[17rem] p-1"
        data-testid="composer-api-key-popover"
      >
        <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">
          {subscriptionIssue ? title : t("chatView.noApiKeyDescription")}
        </p>
        <button
          type="button"
          data-testid="composer-api-key-chip:settings"
          onClick={() => onOpenSettings("llm")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-secondary-foreground transition-colors hover:bg-muted"
        >
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t("chatView.openSettingsButton")}
        </button>
        {!subscriptionIssue ? <button
          type="button"
          data-testid="composer-api-key-chip:marketplace"
          onClick={() => onOpenSettings("marketplace")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-secondary-foreground transition-colors hover:bg-muted"
        >
          <Store className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t("chatView.openMarketplaceButton")}
        </button> : null}
      </PopoverContent>
    </Popover>
  );
}
