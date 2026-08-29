/**
 * Browser-safe common contract for subscription-backed chat runtimes.
 *
 * API-key vendors deliberately remain in `llm-vendor-defaults.ts`.  A
 * subscription runtime owns its own credential store and stateful transport,
 * so treating one as an API vendor would leak the wrong settings, fallback,
 * pricing, and tool-execution assumptions into the application.
 */
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "./safe-integer.js";

const SUBSCRIPTION_RUNTIME_IDS = ["codex", "kimi-code", "grok-build"] as const;

export type SubscriptionRuntimeId = (typeof SUBSCRIPTION_RUNTIME_IDS)[number];
/** Shared cap for model ids carried by subscription runtime contracts. */
export const MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH = 200;

/**
 * Wire contract of the loopback tool bridge between the main process and the
 * stdio MCP shim it spawns for ACP runtimes. Both ends validate the same
 * payloads — the bridge bounds the tool set it publishes, the shim bounds the
 * `tools/list` and `tools/call` bodies it reads back — so the bounds and the
 * environment handoff keys are declared once and imported by both, and one
 * side cannot accept what the other refuses.
 */
export const SUBSCRIPTION_TOOL_BRIDGE_CONTRACT = Object.freeze({
  urlEnv: "LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL",
  tokenEnv: "LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN",
  maxToolCount: 256,
  maxSchemaBytes: 64 * 1024,
  maxJsonDepth: 16,
  maxJsonKeys: 1_024,
  maxJsonArrayItems: 1_024,
  maxJsonStringLength: 64 * 1024,
} as const);

/**
 * Provenance of a subscription-runtime token segment.
 *
 * This is deliberately separate from `TokenUsage`: API-key usage is a
 * billable pricing contract, whereas these values describe consumption under
 * an already-authenticated subscription. A local estimate must never be
 * presented as provider-reported usage.
 */
export type SubscriptionUsageSource = "provider-reported" | "local-estimate";

/**
 * Renderer-safe per-round subscription usage.
 *
 * `totalTokens` is the provider's exact per-turn total where available, or
 * the sum of the locally-estimated input/output values. It is never an API
 * price input. `billable: false` makes the non-pricing boundary explicit at
 * every persistence and IPC hop.
 */
export interface SubscriptionUsageTelemetry {
  readonly provider: SubscriptionRuntimeId;
  readonly model: string;
  readonly source: SubscriptionUsageSource;
  readonly billable: false;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningOutputTokens?: number;
  /** Provider metadata only; it is not used to re-enable the context ring. */
  readonly contextWindow?: number;
}

const SUBSCRIPTION_USAGE_TELEMETRY_KEYS = new Set([
  "provider",
  "model",
  "source",
  "billable",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningOutputTokens",
  "contextWindow",
]);

/**
 * Validates and copies telemetry arriving from transport, persisted history,
 * or IPC. Unknown fields are rejected so raw provider payloads cannot leak
 * across the main/renderer boundary by being carried incidentally.
 */
export function normalizeSubscriptionUsageTelemetry(
  value: unknown,
): SubscriptionUsageTelemetry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const payload = value as Record<string, unknown>;
    if (Object.keys(payload).some((key) => !SUBSCRIPTION_USAGE_TELEMETRY_KEYS.has(key))) {
      return undefined;
    }
    const provider = payload.provider;
    const model = payload.model;
    const source = payload.source;
    if (
      !isSubscriptionRuntimeId(provider)
      || typeof model !== "string"
      || model.length === 0
      || model.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
      || (source !== "provider-reported" && source !== "local-estimate")
      || payload.billable !== false
      || !isNonNegativeSafeInteger(payload.inputTokens)
      || !isNonNegativeSafeInteger(payload.outputTokens)
      || !isNonNegativeSafeInteger(payload.totalTokens)
      || (payload.cacheReadTokens !== undefined && !isNonNegativeSafeInteger(payload.cacheReadTokens))
      || (payload.cacheWriteTokens !== undefined && !isNonNegativeSafeInteger(payload.cacheWriteTokens))
      || (payload.reasoningOutputTokens !== undefined && !isNonNegativeSafeInteger(payload.reasoningOutputTokens))
      || (payload.contextWindow !== undefined && !isPositiveSafeInteger(payload.contextWindow))
    ) {
      return undefined;
    }
    return {
      provider,
      model,
      source,
      billable: false,
      inputTokens: payload.inputTokens,
      outputTokens: payload.outputTokens,
      totalTokens: payload.totalTokens,
      ...(payload.cacheReadTokens !== undefined ? { cacheReadTokens: payload.cacheReadTokens } : {}),
      ...(payload.cacheWriteTokens !== undefined ? { cacheWriteTokens: payload.cacheWriteTokens } : {}),
      ...(payload.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: payload.reasoningOutputTokens }
        : {}),
      ...(payload.contextWindow !== undefined ? { contextWindow: payload.contextWindow } : {}),
    };
  } catch {
    return undefined;
  }
}

export function isSubscriptionRuntimeId(value: unknown): value is SubscriptionRuntimeId {
  return typeof value === "string"
    && (SUBSCRIPTION_RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * Main-to-renderer invalidation event for a subscription runtime status.
 *
 * This intentionally carries no runtime status, verification URL, executable
 * path, credential, or raw provider output. Consumers re-read the existing
 * safe status projection after observing a newer revision.
 */
export interface SubscriptionRuntimeStatusUpdatedEvent {
  readonly provider: SubscriptionRuntimeId;
  readonly revision: number;
}

/** Reject malformed or expanded event payloads at the preload boundary. */
export function isSubscriptionRuntimeStatusUpdatedEvent(
  value: unknown,
): value is SubscriptionRuntimeStatusUpdatedEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  return keys.length === 2
    && Object.prototype.hasOwnProperty.call(payload, "provider")
    && Object.prototype.hasOwnProperty.call(payload, "revision")
    && isSubscriptionRuntimeId(payload.provider)
    && typeof payload.revision === "number"
    && Number.isSafeInteger(payload.revision)
    && payload.revision > 0;
}

type SubscriptionRuntimeTransport = "codex-app-server" | "acp";

export type SubscriptionLoginMethod = "browser" | "device-code";

export type SubscriptionRuntimeState =
  | "not-configured"
  | "unverified"
  | "ready"
  | "unavailable";

export type SubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out"
  | "unknown";

/**
 * Selection persisted under `llm.activeChatRuntime`.
 *
 * `model` is intentionally optional: ACP providers may expose only their
 * own default model, while Codex may enumerate subscription-scoped models.
 */
export interface SubscriptionChatRuntimeSelection {
  kind: "subscription";
  provider: SubscriptionRuntimeId;
  model?: string;
}

interface ApiChatRuntimeSelection {
  kind: "api";
}

export type ActiveChatRuntime = ApiChatRuntimeSelection | SubscriptionChatRuntimeSelection;

export interface SubscriptionRuntimeDescriptor {
  id: SubscriptionRuntimeId;
  label: string;
  transport: SubscriptionRuntimeTransport;
  requiresExecutable: boolean;
  loginMethods: readonly SubscriptionLoginMethod[];
  supportsManagedLogout: boolean;
  /** Only surface a picker when the runtime supplies a trustworthy model list. */
  supportsModelSelection: boolean;
}

/**
 * Main-verified feature availability for a subscription runtime.
 *
 * These are deliberately booleans rather than promises about a provider's
 * native client. A value may be `true` only after the LVIS-owned runtime has
 * confirmed that the feature is available through the same host permission,
 * audit, project, and lifecycle paths as an API-key provider. A missing
 * status projection is treated as unknown by the renderer, never as enabled.
 */
export interface SubscriptionImageAttachmentLimits {
  /** Maximum original images accepted for one subscription prompt. */
  readonly maxCount: number;
  /** Maximum decoded bytes for any one original image. */
  readonly maxBytesPerImage: number;
  /** Maximum decoded bytes across all original images in one prompt. */
  readonly maxTotalBytes: number;
}

export interface SubscriptionRuntimeCapabilities {
  readonly chat: boolean;
  /** The runtime accepts original image bytes through its negotiated transport. */
  readonly images: boolean;
  /**
   * Main-verified native image budget, or null when images are unavailable.
   * This is distinct from the normal file-marker/read-tool flow.
   */
  readonly imageAttachmentLimits: SubscriptionImageAttachmentLimits | null;
  /** The normal LVIS file marker + governed read-tool flow is available. */
  readonly files: boolean;
  readonly tools: boolean;
  readonly projectAccess: boolean;
  readonly plugins: boolean;
  readonly mcp: boolean;
  readonly generateText: boolean;
  readonly compaction: boolean;
  readonly routine: boolean;
  readonly subagent: boolean;
}

/**
 * The API-key vendor that reaches the same provider as a subscription runtime.
 *
 * A user recognises OpenAI, xAI, and Moonshot as one company each — the two
 * ways in are an API key or signing in to that company's runtime, not two
 * providers with similar names. Settings lists the provider once and offers
 * the authentication methods, and this is the join that makes that possible.
 *
 * Values are the ids the LLM vendor settings already use: a built-in vendor id
 * for OpenAI, an OpenAI-compatible preset id for the other two. A runtime with
 * no key-based route simply has no entry.
 */
export const SUBSCRIPTION_RUNTIME_API_COUNTERPART: Readonly<
  Partial<Record<SubscriptionRuntimeId, string>>
> = Object.freeze({
  codex: "openai",
  "grok-build": "xai",
  "kimi-code": "moonshot",
});

/** Safe capability projection when a runtime has not verified a feature. */
export const DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES: SubscriptionRuntimeCapabilities = Object.freeze({
  chat: false,
  images: false,
  imageAttachmentLimits: null,
  files: false,
  tools: false,
  projectAccess: false,
  plugins: false,
  mcp: false,
  generateText: false,
  compaction: false,
  routine: false,
  subagent: false,
});

/**
 * The API-key path's capability projection, in the same shape the subscription
 * runtimes report so one checklist can describe every connection.
 *
 * These are not vendor claims. On the API path LVIS runs its own engine, so
 * tools, MCP, routines, subagents, compaction, plugins, and project access are
 * host features that hold for any vendor; attachment ingress is likewise
 * unconditional there (see `SubscriptionRuntimeUiPolicy`: "API-key providers
 * keep their established policy"). `imageAttachmentLimits` stays null because
 * the native-image budget is a subscription-transport concept — the API path
 * sends attachments through the normal composer pipeline instead.
 */
export const API_PATH_RUNTIME_CAPABILITIES: SubscriptionRuntimeCapabilities = Object.freeze({
  chat: true,
  images: true,
  imageAttachmentLimits: null,
  files: true,
  tools: true,
  projectAccess: true,
  plugins: true,
  mcp: true,
  generateText: true,
  compaction: true,
  routine: true,
  subagent: true,
});

export const SUBSCRIPTION_RUNTIME_DESCRIPTORS: readonly SubscriptionRuntimeDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    transport: "codex-app-server",
    requiresExecutable: false,
    loginMethods: ["browser", "device-code"],
    supportsManagedLogout: true,
    supportsModelSelection: true,
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    transport: "acp",
    requiresExecutable: true,
    loginMethods: ["device-code"],
    supportsManagedLogout: false,
    supportsModelSelection: false,
  },
  {
    id: "grok-build",
    label: "Grok Build",
    transport: "acp",
    requiresExecutable: true,
    loginMethods: ["device-code"],
    supportsManagedLogout: true,
    supportsModelSelection: false,
  },
] as const;

export function subscriptionRuntimeDescriptor(
  runtimeId: SubscriptionRuntimeId,
): SubscriptionRuntimeDescriptor {
  return SUBSCRIPTION_RUNTIME_DESCRIPTORS.find((descriptor) => descriptor.id === runtimeId)
    ?? SUBSCRIPTION_RUNTIME_DESCRIPTORS[0]!;
}

/**
 * Safe status projection used by renderer IPC. Dynamic verification URLs,
 * access tokens, raw CLI output, and executable paths never appear here.
 */
export interface SubscriptionRuntimeStatus {
  provider: SubscriptionRuntimeId;
  runtime: SubscriptionRuntimeState;
  connection: SubscriptionConnectionState;
  planType: string | null;
  pendingLogin: SubscriptionLoginMethod | null;
  pendingDeviceCode: string | null;
  canOpenVerificationUrl: boolean;
  version: string | null;
  /**
   * Host-verified feature availability. The renderer must treat an omitted or
   * false value as unavailable; provider-native capability claims are not
   * sufficient on their own.
   */
  capabilities: SubscriptionRuntimeCapabilities;
}

export interface SubscriptionRuntimeModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export type SubscriptionRuntimeErrorCode =
  | "subscription-provider-not-supported"
  | "subscription-runtime-not-configured"
  | "subscription-runtime-unavailable"
  | "subscription-login-in-progress"
  | "subscription-login-failed"
  | "subscription-verification-url-unavailable"
  | "subscription-logout-not-supported"
  | "subscription-chat-unavailable"
  | "subscription-operation-failed";

export type SubscriptionRuntimeActionResult =
  | { ok: true; status: SubscriptionRuntimeStatus }
  | {
      ok: false;
      error: SubscriptionRuntimeErrorCode;
      status?: SubscriptionRuntimeStatus;
    };

export type SubscriptionRuntimeModelsResult =
  | {
      ok: true;
      status: SubscriptionRuntimeStatus;
      models: SubscriptionRuntimeModel[];
    }
  | {
      ok: false;
      error: SubscriptionRuntimeErrorCode;
      status?: SubscriptionRuntimeStatus;
    };
