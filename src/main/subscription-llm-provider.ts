/**
 * Engine adapter for isolated subscription-backed chat.
 *
 * This is intentionally not an API-key vendor adapter. It accepts only the
 * host's governed conversation boundary and delegates transport ownership to
 * the main-process SubscriptionRuntimeService.
 */
import type {
  GenericMessage,
  LLMProvider,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  StreamEvent,
  ToolSchema,
  StreamTurnParams,
} from "../engine/llm/types.js";
import { userContentText } from "../engine/llm/types.js";
import { stubMarkedToolResults } from "../engine/wire-serialize.js";
import { classifyProviderError, type ErrorCategory } from "../engine/llm/error-classifier.js";
import {
  extractProviderErrorDiagnostics,
  type ProviderErrorDiagnostics,
} from "../engine/llm/provider-error-diagnostics.js";
import { rejectedToolNameFromError } from "../engine/llm/rejected-tool-schema.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionChatRuntimeSelection,
} from "../shared/subscription-runtime.js";
import { estimateMultimodalTokenOverhead } from "../shared/multimodal-token-estimate.js";
import { estimateTokens } from "../shared/token-estimate.js";
import { MAX_ACP_SUBSCRIPTION_TEXT_WITH_IMAGES_BYTES } from "./acp-subscription-session-client.js";
import {
  getSubscriptionRuntimeService,
  SubscriptionRuntimeServiceError,
  type GetSubscriptionRuntimeServiceOptions,
  type SubscriptionOpenExternal,
  type SubscriptionRuntimeService,
  type SubscriptionTextSession,
} from "./subscription-runtime-service.js";
import {
  normalizeSubscriptionImageAttachment,
  SubscriptionAttachmentTransportError,
  type SubscriptionPromptAttachment,
} from "./subscription-attachment-input.js";
import { SubscriptionToolBridge } from "./subscription-tool-bridge.js";

const MAX_SERIALIZED_INPUT_BYTES = 700 * 1024;
const MAX_ACP_SERIALIZED_INPUT_BYTES = 512 * 1024;

/**
 * Original user images cross this boundary only as strict native attachments.
 * Normal LVIS files keep their existing path-marker plus governed read-tool
 * flow; a generic raw file payload never gains an unreviewed upload path here.
 */
export const SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED = "subscription-attachments-not-supported";
export const SUBSCRIPTION_ATTACHMENT_INPUT_TOO_LARGE = "subscription-attachment-too-large";

export class SubscriptionAttachmentInputRejectedError extends Error {
  readonly code = SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED;

  constructor() {
    super(SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED);
    this.name = "SubscriptionAttachmentInputRejectedError";
  }
}

/** A local envelope-size rejection; it must never consume transport retries. */
class SubscriptionInputTooLargeError extends Error {
  readonly code = "subscription-input-too-large";

  constructor() {
    super("subscription-input-too-large");
    this.name = "SubscriptionInputTooLargeError";
  }
}

type ErrorStreamEvent = Extract<StreamEvent, { type: "error" }>;
/** Fixed renderer-safe response for every rejected boundary or runtime fault. */
const SUBSCRIPTION_CHAT_UNAVAILABLE = "Subscription runtime could not complete. Verify the connected runtime and try again.";
const SUBSCRIPTION_ATTACHMENT_UNAVAILABLE = "The selected subscription runtime cannot send this attachment.";
const SUBSCRIPTION_ATTACHMENT_TOO_LARGE = "The selected subscription runtime cannot send an attachment this large.";

export interface SubscriptionLlmProviderOptions {
  /** A settings-normalized selection; it is never an API-key vendor config. */
  readonly selection: SubscriptionChatRuntimeSelection;
  /** Parent selection for a transient sub-agent Codex model candidate. */
  readonly fallbackSelection?: SubscriptionChatRuntimeSelection;
  /** Main-owned opener used only if the singleton has not already been created. */
  readonly openExternal?: SubscriptionOpenExternal;
  /** Main-test seam; production resolves the process singleton. */
  readonly service?: Pick<SubscriptionRuntimeService, "openTextSession">;
  /** Optional redacted audit hook forwarded only at singleton creation. */
  readonly runtimeServiceOptions?: GetSubscriptionRuntimeServiceOptions;
}

function immutableSelection(
  selection: SubscriptionChatRuntimeSelection,
): SubscriptionChatRuntimeSelection {
  return Object.freeze({
    kind: "subscription",
    provider: selection.provider,
    ...(selection.model === undefined ? {} : { model: selection.model }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorStreamEvent(value: unknown): value is ErrorStreamEvent {
  return isRecord(value) && value.type === "error" && typeof value.error === "string";
}

function isErrorCategory(value: unknown): value is ErrorCategory {
  return value === "api-key"
    || value === "rate-limit"
    || value === "context-length"
    || value === "model"
    || value === "network"
    || value === "unknown";
}

function safeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000
    ? value
    : undefined;
}

function safeTpmDiagnostics(
  diagnostics: ProviderErrorDiagnostics,
): ProviderErrorDiagnostics | undefined {
  const rateLimit = diagnostics.rateLimit;
  if (rateLimit?.kind !== "tokens-per-minute") return undefined;
  const projected: NonNullable<ProviderErrorDiagnostics["rateLimit"]> = {
    kind: "tokens-per-minute",
  };
  const limit = safeNonNegativeNumber(rateLimit.limit);
  const used = safeNonNegativeNumber(rateLimit.used);
  const requested = safeNonNegativeNumber(rateLimit.requested);
  const retryAfterSeconds = safeNonNegativeNumber(rateLimit.retryAfterSeconds);
  if (limit !== undefined) projected.limit = limit;
  if (used !== undefined) projected.used = used;
  if (requested !== undefined) projected.requested = requested;
  if (retryAfterSeconds !== undefined) projected.retryAfterSeconds = retryAfterSeconds;
  return {
    origin: diagnostics.origin,
    providerType: "tokens",
    providerCode: "rate_limit_exceeded",
    classification: "rate-limit",
    // This is deliberately a normalized diagnostic, never provider text.
    messagePreview: "subscription runtime tokens-per-minute rate limit",
    rateLimit: projected,
  };
}

/**
 * Preserve only recovery signals the engine can act on. The raw third-party
 * error remains confined to this function: renderer-facing `error` is always
 * the fixed subscription message below, while diagnostics contain either a
 * declared tool name or bounded numeric rate-limit facts.
 */
function subscriptionFailure(
  failure: unknown,
  tools: readonly { name: string }[] | undefined,
): ErrorStreamEvent {
  if (failure instanceof SubscriptionAttachmentTransportError) {
    const tooLarge = failure.code === "subscription-attachment-too-large";
    return {
      type: "error",
      error: tooLarge ? SUBSCRIPTION_ATTACHMENT_TOO_LARGE : SUBSCRIPTION_ATTACHMENT_UNAVAILABLE,
      classification: tooLarge
        ? SUBSCRIPTION_ATTACHMENT_INPUT_TOO_LARGE
        : SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
      providerError: {
        origin: "unknown",
        statusCode: 400,
        providerCode: tooLarge
          ? SUBSCRIPTION_ATTACHMENT_INPUT_TOO_LARGE
          : SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
        messagePreview: tooLarge
          ? "subscription attachment input too large"
          : "subscription attachment input rejected",
      },
    };
  }

  if (failure instanceof SubscriptionAttachmentInputRejectedError) {
    return {
      type: "error",
      error: SUBSCRIPTION_ATTACHMENT_UNAVAILABLE,
      classification: SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
      providerError: {
        origin: "unknown",
        statusCode: 400,
        providerCode: SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
        messagePreview: "subscription attachment input rejected",
      },
    };
  }

  // This is an already-computed host input boundary, not a remote transport
  // failure. Keep the renderer text generic, but let FallbackProvider stop
  // immediately instead of serializing the same oversized history five times.
  if (failure instanceof SubscriptionInputTooLargeError) {
    return {
      type: "error",
      error: SUBSCRIPTION_CHAT_UNAVAILABLE,
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: "unknown",
        statusCode: 400,
        providerCode: failure.code,
        isRetryable: false,
        messagePreview: "subscription input too large",
      },
    };
  }

  // A host-owned unavailable result is already a deterministic local state
  // (for example, an expired login or a runtime that failed verification).
  // It must reach the renderer through the same generic safe text, but must
  // not consume the transient network retry budget in FallbackProvider.
  if (
    failure instanceof SubscriptionRuntimeServiceError
    && failure.code === "subscription-chat-unavailable"
  ) {
    return {
      type: "error",
      error: SUBSCRIPTION_CHAT_UNAVAILABLE,
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: "unknown",
        providerCode: failure.code,
        isRetryable: false,
        messagePreview: "subscription runtime chat unavailable",
      },
    };
  }

  const event = isErrorStreamEvent(failure) ? failure : undefined;
  const raw = event?.providerError?.messagePreview ?? event?.error ?? failure;
  const extractedDiagnostics = extractProviderErrorDiagnostics(raw);
  const diagnostics = event?.providerError
    ? {
      ...extractedDiagnostics,
      ...event.providerError,
      ...(event.providerError.rateLimit === undefined && extractedDiagnostics.rateLimit !== undefined
        ? { rateLimit: extractedDiagnostics.rateLimit }
        : {}),
    }
    : extractedDiagnostics;
  const eventClassification = event?.classification;
  const classification = diagnostics.classification
    ?? (isErrorCategory(eventClassification) ? eventClassification : classifyProviderError(diagnostics.messagePreview).category);
  const knownToolNames = tools?.map((tool) => tool.name) ?? [];
  const rejectedTool = rejectedToolNameFromError(diagnostics, knownToolNames);

  if (rejectedTool) {
    return {
      type: "error",
      error: SUBSCRIPTION_CHAT_UNAVAILABLE,
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: diagnostics.origin,
        statusCode: 400,
        providerCode: "invalid_function_parameters",
        classification: "unknown",
        // The name was matched against an LVIS-declared tool, so it is safe
        // to retain for the query loop's bounded schema-drop recovery.
        messagePreview: `Invalid schema for function '${rejectedTool}'.`,
      },
    };
  }

  const tpmDiagnostics = classification === "rate-limit"
    ? safeTpmDiagnostics(diagnostics)
    : undefined;
  if (tpmDiagnostics) {
    return {
      type: "error",
      error: SUBSCRIPTION_CHAT_UNAVAILABLE,
      classification: "subscription-chat-unavailable",
      providerError: tpmDiagnostics,
    };
  }

  if (classification === "context-length") {
    return {
      type: "error",
      error: SUBSCRIPTION_CHAT_UNAVAILABLE,
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: diagnostics.origin,
        classification: "context-length",
        messagePreview: "context window exceeded",
      },
    };
  }

  return {
    type: "error",
    error: SUBSCRIPTION_CHAT_UNAVAILABLE,
    classification: "subscription-chat-unavailable",
  };
}

function serializedUserContent(
  content: Extract<GenericMessage, { role: "user" }>["content"],
  attachments: SubscriptionPromptAttachment[],
  includesCurrentTurnAttachments: boolean,
): string | ReadonlyArray<Record<string, unknown>> {
  if (typeof content === "string") return content;
  // The engine sends full history for every model round. Native image input is
  // scoped to the newest user message only, which keeps the current logical
  // turn (including tool-result continuations) visual while older images use
  // the canonical non-raw history marker and cannot exhaust prompt limits.
  if (!includesCurrentTurnAttachments) return userContentText(content);
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    // The ordinary renderer never produces a raw file part: FileAttachment is
    // represented in the text as a path marker and read through LVIS's normal
    // governed tool flow. Do not turn an unexpected current payload into a new
    // external binary transport.
    if (part.type !== "image") throw new SubscriptionAttachmentInputRejectedError();
    const attachment = normalizeSubscriptionImageAttachment(part.image, part.mimeType);
    if (!attachment) throw new SubscriptionAttachmentInputRejectedError();
    const attachmentIndex = attachments.length;
    attachments.push(attachment);
    // Keep the conversation envelope free of raw image bytes. The native
    // protocol receives the original bytes out-of-band in the same order.
    return { type: "image", mimeType: attachment.mimeType, attachmentIndex };
  });
}

function serializedMessage(
  message: GenericMessage,
  attachments: SubscriptionPromptAttachment[],
  includesCurrentTurnAttachments: boolean,
): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return {
        role: message.role,
        content: serializedUserContent(message.content, attachments, includesCurrentTurnAttachments),
      };
    case "assistant":
      return {
        role: message.role,
        content: message.content,
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      };
    case "tool_result":
      // API-key paths only replay tool-result image bytes for the Claude
      // mapper. Preserve the model-visible text placeholder on subscription
      // paths, but never silently turn a historic tool output into new raw
      // external image egress.
      return {
        role: message.role,
        toolUseId: message.toolUseId,
        ...(message.toolName ? { toolName: message.toolName } : {}),
        content: message.content,
        isError: message.isError === true,
      };
  }
}

export interface SerializedSubscriptionConversation {
  /** Text-only history envelope sent alongside the native image blocks. */
  readonly text: string;
  /** Strict image payloads in the same order as envelope attachment indexes. */
  readonly attachments: readonly SubscriptionPromptAttachment[];
}

/**
 * Subscription transport protocols accept one structured native prompt. Keep
 * normal LVIS history/tool-result/continuation state inside an explicit text
 * envelope, while original user images travel only through the verified native
 * image channel. This avoids base64 expansion inside the history JSONL frame.
 */
function buildSubscriptionConversationPayload(
  params: StreamTurnParams,
): SerializedSubscriptionConversation {
  const attachments: SubscriptionPromptAttachment[] = [];
  const latestUserMessageIndex = params.messages.reduce(
    (latest, message, index) => message.role === "user" ? index : latest,
    -1,
  );
  let requestJson: string;
  try {
    requestJson = JSON.stringify({
      systemPrompt: params.systemPrompt,
      messages: params.messages.map((message, index) => serializedMessage(
        message,
        attachments,
        index === latestUserMessageIndex,
      )),
      continuationPrefill: params.continuationPrefill === true,
      enableThinking: params.enableThinking === true,
      ...(params.thinkingBudgetTokens === undefined ? {} : { thinkingBudgetTokens: params.thinkingBudgetTokens }),
    });
  } catch (error) {
    if (error instanceof SubscriptionAttachmentInputRejectedError) throw error;
    throw new Error("subscription-input-serialization-failed");
  }
  const text = [
    "You are serving one LVIS model turn. Apply the system prompt and conversation in the JSON envelope below.",
    "Use only LVIS-declared host tools. Never attempt native shell, filesystem, browser, permission, or account operations.",
    "When a host tool is requested, LVIS executes it under its normal permission and audit policy, then starts the next model round with the tool result.",
    "<lvis-request-json>",
    requestJson,
    "</lvis-request-json>",
  ].join("\n\n");
  return Object.freeze({ text, attachments: Object.freeze(attachments) });
}

export function serializeSubscriptionConversationPayload(
  params: StreamTurnParams,
  maxBytes = MAX_SERIALIZED_INPUT_BYTES,
): SerializedSubscriptionConversation {
  const payload = buildSubscriptionConversationPayload(params);
  if (Buffer.byteLength(payload.text, "utf8") > maxBytes) {
    throw new SubscriptionInputTooLargeError();
  }
  return payload;
}

/** Backward-compatible text projection for callers that do not use images. */
export function serializeSubscriptionConversation(
  params: StreamTurnParams,
  maxBytes = MAX_SERIALIZED_INPUT_BYTES,
): string {
  return serializeSubscriptionConversationPayload(params, maxBytes).text;
}

/** Only the newest user images travel through the native subscription channel. */
function estimateCurrentNativeImageTokens(messages: GenericMessage[]): number {
  let latestUser: Extract<GenericMessage, { role: "user" }> | undefined;
  for (const message of messages) {
    if (message.role === "user") latestUser = message;
  }
  if (!latestUser || typeof latestUser.content === "string") return 0;
  const images: Array<{ type: "image"; width?: number; height?: number }> = [];
  for (const part of latestUser.content) {
    if (part.type === "image") {
      images.push({ type: "image", width: part.width, height: part.height });
    }
  }
  return estimateMultimodalTokenOverhead(images);
}

/**
 * Counts only the tool schema shape the active transport can make model-visible.
 * Codex receives bridge-normalized function definitions at thread/start; Kimi
 * receives the same normalized schema from LVIS's MCP discovery endpoint.
 */
function estimateSubscriptionToolSidecarTokens(
  selection: SubscriptionChatRuntimeSelection,
  tools: readonly ToolSchema[],
): number | undefined {
  // Grok remains unsupported until its native profile/tool input is attested;
  // preserve generic fallback rather than claim partial projection coverage.
  if (selection.provider === "grok-build") return undefined;
  if (tools.length === 0) return 0;
  const bridgedTools = new SubscriptionToolBridge(tools).tools;
  if (selection.provider === "codex") {
    const dynamicTools = bridgedTools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return estimateTokens(JSON.stringify({ dynamicTools }));
  }
  if (selection.provider === "kimi-code") {
    // ACP framing remains runtime-owned, but this is the exact LVIS bridge
    // payload exposed to its MCP tool-discovery path.
    return estimateTokens(JSON.stringify({ tools: bridgedTools }));
  }
  return undefined;
}

/**
 * A private main-process LLMProvider marker. `vendor` preserves the preexisting
 * interface only; engine routing must use `subscriptionRuntime`, never vendor,
 * for capability, fallback, pricing, or tool decisions.
 */
export class SubscriptionLlmProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly subscriptionRuntime: SubscriptionChatRuntimeSelection;
  private readonly fallbackSelection: SubscriptionChatRuntimeSelection | undefined;

  constructor(private readonly options: SubscriptionLlmProviderOptions) {
    this.subscriptionRuntime = immutableSelection(options.selection);
    this.fallbackSelection = options.fallbackSelection
      ? immutableSelection(options.fallbackSelection)
      : undefined;
  }

  /**
   * Reuses the exact text-envelope builder and bridge normalization used by
   * streamTurn. Codex provider reports calibrate the remaining tokenizer drift
   * after a completed round without entering API-key billing.
   */
  projectRequestInput(
    input: ProviderRequestInputProjectionParams,
  ): ProviderRequestInputProjection | undefined {
    try {
      const payload = buildSubscriptionConversationPayload({
        model: this.subscriptionRuntime.model ?? "default",
        systemPrompt: input.systemPrompt,
        messages: stubMarkedToolResults(input.messages),
        tools: input.toolSchemas.length > 0 ? input.toolSchemas : undefined,
        ...(input.continuationPrefill ? { continuationPrefill: true } : {}),
        ...(input.enableThinking ? { enableThinking: true } : {}),
        ...(input.thinkingBudgetTokens === undefined
          ? {}
          : { thinkingBudgetTokens: input.thinkingBudgetTokens }),
      });
      const toolSchemaTokens = estimateSubscriptionToolSidecarTokens(
        this.subscriptionRuntime,
        input.toolSchemas,
      );
      if (toolSchemaTokens === undefined) return undefined;
      const messageTokens =
        estimateTokens(payload.text) + estimateCurrentNativeImageTokens(input.messages);
      return {
        // Subscription transports embed the system prompt in their controlled
        // envelope, so this component intentionally represents the complete
        // envelope rather than pretending it was a separate provider field.
        systemPromptTokens: 0,
        messageTokens,
        toolSchemaTokens,
        totalTokens: messageTokens + toolSchemaTokens,
      };
    } catch {
      // Preserve the actual stream's fail-closed attachment/size errors. A
      // projection must never create a new preflight failure surface.
      return undefined;
    }
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    let session: SubscriptionTextSession | undefined;
    try {
      const serialized = serializeSubscriptionConversationPayload(
        params,
        this.subscriptionRuntime.provider === "codex" ? MAX_SERIALIZED_INPUT_BYTES : MAX_ACP_SERIALIZED_INPUT_BYTES,
      );
      // Native ACP image blocks share the same JSONL frame as this envelope.
      // Leave a conservative buffer so a valid 256KiB image cannot be
      // rejected only after a costly runtime startup/write attempt.
      if (
        this.subscriptionRuntime.provider !== "codex"
        && serialized.attachments.length > 0
        && Buffer.byteLength(serialized.text, "utf8") > MAX_ACP_SUBSCRIPTION_TEXT_WITH_IMAGES_BYTES
      ) {
        throw new SubscriptionAttachmentTransportError("subscription-attachment-too-large");
      }
      const openedSession = await this.runtimeService().then((service) => service.openTextSession(
        this.subscriptionRuntime,
        {
          tools: params.tools,
          ...(this.fallbackSelection ? { fallbackSelection: this.fallbackSelection } : {}),
        },
      ));
      session = openedSession;
      for await (const event of openedSession.streamTurn(
        serialized.text,
        params.abortSignal,
        serialized.attachments,
      )) {
        if (event.type === "error") {
          yield subscriptionFailure(event, params.tools);
          return;
        }
        if (event.type === "message_complete") {
          // Subscription transports never expose API-key billing `usage`.
          // The separate, validated telemetry retains token provenance without
          // allowing the API pricing path to observe it.
          const subscriptionUsage = event.subscriptionUsage
            ? normalizeSubscriptionUsageTelemetry(event.subscriptionUsage)
            : undefined;
          yield {
            type: "message_complete",
            stopReason: event.stopReason,
            ...(subscriptionUsage ? { subscriptionUsage } : {}),
          };
          continue;
        }
        yield event;
      }
    } catch (error) {
      yield subscriptionFailure(error, params.tools);
    } finally {
      if (session) await this.stopQuietly(session);
    }
  }

  private async runtimeService(): Promise<Pick<SubscriptionRuntimeService, "openTextSession">> {
    if (this.options.service) return this.options.service;
    if (!this.options.openExternal) throw new Error("subscription-runtime-opener-missing");
    return getSubscriptionRuntimeService(
      this.options.openExternal,
      this.options.runtimeServiceOptions,
    );
  }

  private async stopQuietly(session: SubscriptionTextSession): Promise<void> {
    try {
      await session.stop();
    } catch {
      // The service owns process cleanup; an already-failing text stream must
      // never expose a third-party runtime error or keep the turn alive.
    }
  }
}

export function createSubscriptionLlmProvider(
  options: SubscriptionLlmProviderOptions,
): SubscriptionLlmProvider {
  return new SubscriptionLlmProvider(options);
}
