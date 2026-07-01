import { useEffect } from "react";
import type { useTranslation } from "../../../i18n/react.js";
import type { useChatState } from "./use-chat-state.js";
import type { useStatusBar } from "./use-status-bar.js";

type TFn = ReturnType<typeof useTranslation>["t"];
type ChatState = ReturnType<typeof useChatState>;
type StatusBar = ReturnType<typeof useStatusBar>;

export interface UseChatStatusIndicatorsDeps {
  t: TFn;
  isCompacting: boolean;
  compactTriggerSource: ChatState["compactTriggerSource"];
  isRecoveryExhausted: boolean;
  statusUpsertPersistent: StatusBar["upsertPersistent"];
  statusRemovePersistent: StatusBar["removePersistent"];
}

/**
 * Persistent StatusBar indicators driven by useChatState flags, extracted
 * verbatim from App.tsx. Upserts an "auto-compact in progress" item while a
 * pre-turn compaction runs (distinct labels for force-recover / rate-limit
 * sources, #916) and an "exhausted force-recover budget" warning (#917); both
 * clear when their flag flips off. Independent effects; returns void.
 */
export function useChatStatusIndicators({
  t,
  isCompacting,
  compactTriggerSource,
  isRecoveryExhausted,
  statusUpsertPersistent,
  statusRemovePersistent,
}: UseChatStatusIndicatorsDeps): void {
  // Show a persistent StatusBar indicator while a pre-turn auto-compact runs.
  // `compact_started` sets isCompacting → this effect upserts the item.
  // `compact_notice` clears isCompacting → this effect removes the item.
  // Issue #916: force-recover (autoCompact OFF-override) shows a distinct label.
  useEffect(() => {
    const COMPACT_ITEM_ID = "auto-compact-in-progress";
    if (isCompacting) {
      const isForceRecover = compactTriggerSource === "force-recover";
      const isRateLimitRecover = compactTriggerSource === "rate-limit";
      statusUpsertPersistent({
        id: COMPACT_ITEM_ID,
        severity: isForceRecover || isRateLimitRecover ? "warning" : "info",
        label: t("app.compactStatusLabel"),
        value: isForceRecover
          ? t("app.compactForceRecoverValue")
          : isRateLimitRecover
            ? t("app.compactRateLimitValue")
            : t("app.compactInProgressValue"),
      });
    } else {
      statusRemovePersistent(COMPACT_ITEM_ID);
    }
  }, [isCompacting, compactTriggerSource, statusUpsertPersistent, statusRemovePersistent]);

  // Issue #917: show a persistent warning banner when force-recover budget is exhausted.
  // Cleared when the user starts a new chat (clearForNewChat resets isRecoveryExhausted).
  useEffect(() => {
    const EXHAUSTED_ITEM_ID = "recovery-exhausted";
    if (isRecoveryExhausted) {
      statusUpsertPersistent({
        id: EXHAUSTED_ITEM_ID,
        severity: "error",
        label: t("app.compactExhaustedLabel"),
        value: t("app.compactExhaustedValue"),
      });
    } else {
      statusRemovePersistent(EXHAUSTED_ITEM_ID);
    }
  }, [isRecoveryExhausted, statusUpsertPersistent, statusRemovePersistent]);
}
