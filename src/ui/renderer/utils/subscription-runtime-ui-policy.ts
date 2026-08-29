import type {
  SubscriptionChatRuntimeSelection,
  SubscriptionImageAttachmentLimits,
  SubscriptionRuntimeCapabilities,
  SubscriptionRuntimeId,
} from "../../../shared/subscription-runtime.js";
import { isPositiveSafeInteger } from "../../../shared/safe-integer.js";

/**
 * Renderer-safe projection of the selected subscription runtime's verified
 * status. This is deliberately the only place that turns raw status
 * capabilities into chat/composer affordances, so the picker, paste path,
 * send guard, side chat, and settings chip cannot drift apart.
 */
export interface SubscriptionRuntimeUiPolicy {
  readonly activeSubscriptionRuntime: SubscriptionChatRuntimeSelection | null;
  readonly subscriptionSelected: boolean;
  readonly provider: SubscriptionRuntimeId | undefined;
  /** Null means the selected runtime's safe status is still being checked. */
  readonly chatReady: boolean | null;
  /** True only with both image capability and a validated native-image budget. */
  readonly imagesReady: boolean | null;
  readonly filesReady: boolean | null;
  /** Null outside an image-ready subscription runtime. */
  readonly imageAttachmentLimits: SubscriptionImageAttachmentLimits | null;
  readonly chatPending: boolean;
  readonly chatUnavailable: boolean;
  readonly unavailableProvider: SubscriptionRuntimeId | undefined;
  readonly pendingProvider: SubscriptionRuntimeId | undefined;
  readonly imageAttachmentProvider: SubscriptionRuntimeId | undefined;
  readonly fileAttachmentProvider: SubscriptionRuntimeId | undefined;
  /**
   * Both status loading and a selected runtime without verified chat block all
   * attachment ingress. API-key providers keep their established policy.
   */
  readonly attachmentInputsReady: boolean;
  readonly imagesEnabled: boolean;
  readonly filesEnabled: boolean;
}

export interface SubscriptionRuntimeUiPolicyInput {
  readonly activeSubscriptionRuntime: SubscriptionChatRuntimeSelection | null;
  readonly settingsLoaded: boolean;
  /**
   * Null while the active runtime's safe status request is in flight. A failed
   * or malformed response is represented by the all-false shared default.
   */
  readonly capabilities: SubscriptionRuntimeCapabilities | null;
}

/**
 * IPC responses are still an external boundary from the renderer's
 * perspective. Do not turn a truthy object, float, or malformed budget into
 * permission to send original bytes.
 */
function safeImageAttachmentLimits(value: unknown): SubscriptionImageAttachmentLimits | null {
  if (!value || typeof value !== "object") return null;
  const limits = value as Partial<SubscriptionImageAttachmentLimits>;
  if (
    !isPositiveSafeInteger(limits.maxCount)
    || !isPositiveSafeInteger(limits.maxBytesPerImage)
    || !isPositiveSafeInteger(limits.maxTotalBytes)
  ) {
    return null;
  }
  return {
    maxCount: limits.maxCount,
    maxBytesPerImage: limits.maxBytesPerImage,
    maxTotalBytes: limits.maxTotalBytes,
  };
}

export type SubscriptionImageAttachmentLimitViolation =
  | "count"
  | "per-image-bytes"
  | "total-bytes";

export interface SubscriptionImageAttachmentBudgetEntry {
  readonly bytes: number;
}

/**
 * Returns the first truthful native-image budget violation, if any. A null
 * budget is intentionally unrestricted here because API-key providers have
 * their own transport policy; selected subscription runtimes reach this helper
 * only after the selector has required a non-null verified budget.
 */
export function subscriptionImageAttachmentLimitViolation(
  limits: SubscriptionImageAttachmentLimits | null | undefined,
  images: readonly SubscriptionImageAttachmentBudgetEntry[],
): SubscriptionImageAttachmentLimitViolation | null {
  if (!limits) return null;
  if (images.length > limits.maxCount) return "count";
  let totalBytes = 0;
  for (const image of images) {
    if (!isPositiveSafeInteger(image.bytes) || image.bytes > limits.maxBytesPerImage) {
      return "per-image-bytes";
    }
    totalBytes += image.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      return "total-bytes";
    }
  }
  return null;
}

export function selectSubscriptionRuntimeUiPolicy({
  activeSubscriptionRuntime,
  settingsLoaded,
  capabilities,
}: SubscriptionRuntimeUiPolicyInput): SubscriptionRuntimeUiPolicy {
  const subscriptionSelected = activeSubscriptionRuntime !== null;
  const provider = activeSubscriptionRuntime?.provider;
  const statusPending = subscriptionSelected && capabilities === null;
  const chatReady = subscriptionSelected
    ? statusPending
      ? null
      : capabilities?.chat === true
    : false;
  const imageAttachmentLimits = subscriptionSelected && capabilities?.images === true
    ? safeImageAttachmentLimits(capabilities.imageAttachmentLimits)
    : null;
  const imagesReady = subscriptionSelected
    ? statusPending
      ? null
      : capabilities?.images === true && imageAttachmentLimits !== null
    : false;
  const filesReady = subscriptionSelected
    ? statusPending
      ? null
      : capabilities?.files === true
    : false;
  const chatPending = chatReady === null;
  const chatUnavailable = subscriptionSelected && chatReady === false;
  const attachmentInputsReady = settingsLoaded
    && (!subscriptionSelected || chatReady === true);
  const imagesEnabled = attachmentInputsReady
    && (!subscriptionSelected || imagesReady === true);
  const filesEnabled = attachmentInputsReady
    && (!subscriptionSelected || filesReady === true);

  return {
    activeSubscriptionRuntime,
    subscriptionSelected,
    provider,
    chatReady,
    imagesReady,
    filesReady,
    imageAttachmentLimits,
    chatPending,
    chatUnavailable,
    unavailableProvider: chatUnavailable ? provider : undefined,
    pendingProvider: chatPending ? provider : undefined,
    imageAttachmentProvider: subscriptionSelected && imagesReady !== true ? provider : undefined,
    fileAttachmentProvider: subscriptionSelected && filesReady !== true ? provider : undefined,
    attachmentInputsReady,
    imagesEnabled,
    filesEnabled,
  };
}
