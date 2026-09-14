import type { GenericMessage } from "../engine/llm/types.js";
import type { SubscriptionImageAttachmentLimits } from "../shared/subscription-runtime.js";
import {
  assertSubscriptionPromptAttachments,
  normalizeSubscriptionImageAttachment,
  normalizeSubscriptionPromptAttachment,
  subscriptionAttachmentByteLength,
  SubscriptionAttachmentTransportError,
  type SubscriptionPromptAttachment,
} from "./subscription-attachment-input.js";

interface ImageCandidate {
  messageIndex: number;
  partIndex?: number;
  attachment: SubscriptionPromptAttachment;
  fresh: boolean;
}

/** Select native images for one request without changing stored conversation rows. */
export function projectSubscriptionImageHistory(
  messages: GenericMessage[],
  limits: SubscriptionImageAttachmentLimits,
): GenericMessage[] {
  let latestUser = -1;
  let latestAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") latestUser = index;
    if (message.role === "assistant") latestAssistant = index;
  });
  const candidates: ImageCandidate[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role === "user" && messageIndex === latestUser && Array.isArray(message.content)) {
      message.content.forEach((part, partIndex) => {
        if (part.type !== "image") return;
        const attachment = normalizeSubscriptionImageAttachment(part.image, part.mimeType);
        if (!attachment) throw new SubscriptionAttachmentTransportError("subscription-attachment-not-supported");
        candidates.push({ messageIndex, partIndex, attachment, fresh: messageIndex > latestAssistant });
      });
    } else if (message.role === "tool_result" && message.image !== undefined) {
      const attachment = normalizeSubscriptionPromptAttachment({ type: "image", ...message.image });
      if (!attachment) throw new SubscriptionAttachmentTransportError("subscription-attachment-not-supported");
      candidates.push({ messageIndex, attachment, fresh: messageIndex > latestAssistant });
    }
  });
  if (candidates.length === 0) return messages;

  const newUserImages = candidates.filter((candidate) => candidate.fresh && candidate.partIndex !== undefined);
  // Authored input must fit as a whole. A tool image can instead report a
  // recoverable delivery failure alongside its original text result.
  assertSubscriptionPromptAttachments(newUserImages.map((candidate) => candidate.attachment), limits);
  let remainingCount = limits.maxCount;
  let remainingBytes = limits.maxTotalBytes;
  const selected = new Set<ImageCandidate>();
  const reserve = (candidate: ImageCandidate): void => {
    const bytes = subscriptionAttachmentByteLength(candidate.attachment);
    if (remainingCount <= 0 || bytes > limits.maxBytesPerImage || bytes > remainingBytes) return;
    selected.add(candidate);
    remainingCount -= 1;
    remainingBytes -= bytes;
  };
  newUserImages.forEach(reserve);
  candidates.filter((candidate) => candidate.fresh && candidate.partIndex === undefined).forEach(reserve);
  candidates.filter((candidate) => !candidate.fresh).reverse().forEach(reserve);

  const omitted = new Map<number, ImageCandidate[]>();
  for (const candidate of candidates) {
    if (selected.has(candidate)) continue;
    const group = omitted.get(candidate.messageIndex) ?? [];
    group.push(candidate);
    omitted.set(candidate.messageIndex, group);
  }
  if (omitted.size === 0) return messages;
  return messages.map((message, index) => {
    const skipped = omitted.get(index);
    if (!skipped) return message;
    if (message.role === "tool_result") {
      const { image: _image, ...textResult } = message;
      const fresh = skipped[0]!.fresh;
      const notice = fresh
        ? `[Image delivery failed: this request accepts at most ${limits.maxCount} images, ${limits.maxBytesPerImage} bytes per image, and ${limits.maxTotalBytes} bytes total. This image was not sent. Request fewer or smaller images with the image-reading tool. The original tool text follows.]`
        : "[Earlier image omitted from this request to make room for newer images. Read the original image again if its visual details are needed.]";
      return { ...textResult, content: `${notice}\n${message.content}`, ...(fresh ? { isError: true } : {}) };
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      const skippedParts = new Set(skipped.map((candidate) => candidate.partIndex));
      return {
        ...message,
        content: message.content.map((part, partIndex) => skippedParts.has(partIndex)
          ? { type: "text" as const, text: "[Earlier user image omitted from this request; its original remains in the conversation.]" }
          : part),
      };
    }
    return message;
  });
}
