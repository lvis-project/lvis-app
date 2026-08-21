/**
 * Common lifecycle owner for subscription-backed runtimes.
 *
 * Subscription credentials and process transports are intentionally kept out
 * of the API-key provider path.  This service owns their safe status
 * projection, isolated text sessions, and shutdown as one main-process-only
 * boundary.
 */
import { join } from "node:path";
import type { StreamEvent, ToolSchema } from "../engine/llm/types.js";
import {
  ACP_SUBSCRIPTION_PROVIDER_IDS,
  type AcpSubscriptionProviderId,
  type AcpSubscriptionStatus,
  isAcpSubscriptionProviderId,
} from "../shared/acp-subscription.js";
import type { CodexSubscriptionStatus } from "../shared/codex-subscription.js";
import {
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  isSubscriptionRuntimeId,
  normalizeSubscriptionUsageTelemetry,
  subscriptionRuntimeDescriptor,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionConnectionState,
  type SubscriptionLoginMethod,
  type SubscriptionRuntimeErrorCode,
  type SubscriptionRuntimeId,
  type SubscriptionRuntimeModel,
  type SubscriptionRuntimeState,
  type SubscriptionRuntimeStatus,
  type SubscriptionRuntimeCapabilities,
  type SubscriptionImageAttachmentLimits,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import {
  CodexAppServerClient,
  CodexAppServerError,
} from "./codex-app-server-client.js";
import {
  CodexConversationRuntime,
  CodexConversationRuntimeError,
  type CodexConversationRuntimeOptions,
  type CodexConversationTokenUsage,
} from "./codex-conversation-runtime.js";
import { SubscriptionToolBridge } from "./subscription-tool-bridge.js";
import {
  AcpSubscriptionRuntimeClient,
  AcpSubscriptionRuntimeError,
} from "./acp-subscription-runtime-client.js";
import {
  acpSubscriptionRuntimeDirectoryNames,
  ensureAcpSubscriptionNativePolicy,
  AcpSubscriptionRuntimeConfigStore,
  type AcpSubscriptionMcpServerConfig,
  validateAcpSubscriptionMcpServerConfigs,
} from "./acp-subscription-runtime-config.js";
import {
  AcpSubscriptionSessionClient,
  AcpSubscriptionSessionError,
  MAX_ACP_SUBSCRIPTION_IMAGE_ATTACHMENTS,
  MAX_ACP_SUBSCRIPTION_IMAGE_BYTES,
  MAX_ACP_SUBSCRIPTION_IMAGE_TOTAL_BYTES,
  type AcpSubscriptionHostRequestObservation,
  type AcpSubscriptionPromptHandle,
  type AcpSubscriptionSessionClientOptions,
} from "./acp-subscription-session-client.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";
import { projectedSubscriptionTransportDiagnosticsFromError } from "./subscription-transport-error-diagnostics.js";
import {
  DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
  SubscriptionAttachmentTransportError,
  type SubscriptionPromptAttachment,
} from "./subscription-attachment-input.js";

// ─── ACP subscription runtime registry ────────────────────────────────────────
//
// Main-owned registry for the small, static set of supported ACP subscription
// runtimes. Renderer input selects only an allowlisted id; it never controls a
// command, arguments, environment, runtime home, or working directory.

type ClientMap = Record<AcpSubscriptionProviderId, AcpSubscriptionRuntimeClient>;

export interface AcpSubscriptionTextSession {
  readonly provider: AcpSubscriptionProviderId;
  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent>;
  cancelActiveTurn(): Promise<void>;
  stop(): Promise<void>;
}

export interface AcpSubscriptionTextSessionOptions {
  readonly onHostRequest?: (
    request: AcpSubscriptionHostRequestObservation,
  ) => void | Promise<void>;
  /**
   * The one main-process-created LVIS MCP bridge for this session. It is
   * runtime-validated and copied before the session factory receives it.
   */
  readonly mcpServers?: readonly AcpSubscriptionMcpServerConfig[];
}

export interface AcpSubscriptionSessionTransport {
  start(): Promise<unknown>;
  startPrompt(input: {
    readonly text: string;
    readonly abortSignal?: AbortSignal;
    readonly attachments?: readonly SubscriptionPromptAttachment[];
  }): Promise<AcpSubscriptionPromptHandle>;
  cancelActivePrompt(): Promise<void>;
  stop(): Promise<void>;
}

export type AcpSubscriptionSessionClientFactory = (
  options: AcpSubscriptionSessionClientOptions,
) => AcpSubscriptionSessionTransport;

interface ResolvedAcpSubscriptionRuntimeRegistryOptions {
  readonly namespace: FeatureNamespaceHandle;
  readonly configStore: AcpSubscriptionRuntimeConfigStore;
  readonly clients: ClientMap;
  readonly sessionClientFactory: AcpSubscriptionSessionClientFactory;
}

export interface AcpSubscriptionRuntimeRegistryOptions {
  namespace?: FeatureNamespaceHandle;
  configStore?: AcpSubscriptionRuntimeConfigStore;
  clients?: ClientMap;
  sessionClientFactory?: AcpSubscriptionSessionClientFactory;
}

export class AcpSubscriptionRuntimeRegistry {
  private readonly namespace: FeatureNamespaceHandle;
  private readonly configStore: AcpSubscriptionRuntimeConfigStore;
  private readonly clients: ClientMap;
  private readonly sessionClientFactory: AcpSubscriptionSessionClientFactory;
  private readonly textSessions = new Set<AcpSubscriptionSessionTransport>();

  private constructor(options: ResolvedAcpSubscriptionRuntimeRegistryOptions) {
    this.namespace = options.namespace;
    this.configStore = options.configStore;
    this.clients = options.clients;
    this.sessionClientFactory = options.sessionClientFactory;
  }

  static async create(
    options: AcpSubscriptionRuntimeRegistryOptions = {},
  ): Promise<AcpSubscriptionRuntimeRegistry> {
    const namespace = options.namespace ?? openFeatureNamespace("subscription-runtimes");
    const configStore = options.configStore ?? new AcpSubscriptionRuntimeConfigStore(namespace);
    const sessionClientFactory: AcpSubscriptionSessionClientFactory = options.sessionClientFactory
      ?? ((sessionOptions) => new AcpSubscriptionSessionClient(sessionOptions));
    if (options.clients) {
      return new AcpSubscriptionRuntimeRegistry({
        namespace,
        configStore,
        clients: options.clients,
        sessionClientFactory,
      });
    }
    const executablePaths = await Promise.all(
      ACP_SUBSCRIPTION_PROVIDER_IDS.map((provider) => configStore.getExecutable(provider)),
    );
    const clients = {} as ClientMap;
    for (const [index, provider] of ACP_SUBSCRIPTION_PROVIDER_IDS.entries()) {
      const directories = acpSubscriptionRuntimeDirectoryNames(provider);
      clients[provider] = new AcpSubscriptionRuntimeClient({
        provider,
        runtimeHome: join(namespace.dir, directories.runtimeHome),
        workspaceDir: join(namespace.dir, directories.workspaceDir),
        runtimeTempDir: join(namespace.dir, directories.runtimeTempDir),
        executablePath: executablePaths[index] ?? null,
      });
    }
    return new AcpSubscriptionRuntimeRegistry({
      namespace,
      configStore,
      clients,
      sessionClientFactory,
    });
  }

  async getStatus(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].getStatus();
  }

  async setExecutable(provider: AcpSubscriptionProviderId, pickerPath: string): Promise<AcpSubscriptionStatus> {
    const client = this.clients[provider];
    const previous = client.getConfiguredExecutable();
    const status = await client.setExecutable(pickerPath);
    const canonicalPath = client.getConfiguredExecutable();
    if (!canonicalPath) throw new Error("acp-subscription-missing-canonical-executable");
    try {
      await this.configStore.setExecutable(provider, canonicalPath);
    } catch (error) {
      if (previous) {
        await client.setExecutable(previous);
      } else {
        await client.clearExecutable();
      }
      throw error;
    }
    return status;
  }

  async forgetExecutable(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    const client = this.clients[provider];
    const previous = client.getConfiguredExecutable();
    const status = await client.clearExecutable();
    try {
      await this.configStore.clearExecutable(provider);
    } catch (error) {
      if (previous) await client.setExecutable(previous);
      throw error;
    }
    return status;
  }

  /**
   * Start one authenticated ACP conversation with at most the one supplied
   * LVIS-owned MCP server. The returned object
   * remains main-process-only: opaque session identifiers, raw protocol data,
   * and runtime capabilities never cross this registry boundary.
   */
  async openTextSession(
    provider: AcpSubscriptionProviderId,
    options: AcpSubscriptionTextSessionOptions = {},
  ): Promise<AcpSubscriptionTextSession> {
    const mcpServers = validateAcpSubscriptionMcpServerConfigs(options.mcpServers);
    const directories = await this.prepareRuntime(provider);
    const executablePath = this.clients[provider].getConfiguredExecutable();
    if (!executablePath) throw new AcpSubscriptionRuntimeError("acp-runtime-not-configured");

    const session = this.sessionClientFactory({
      provider,
      executablePath,
      runtimeHome: directories.runtimeHome,
      workspaceDir: directories.workspaceDir,
      runtimeTempDir: directories.runtimeTempDir,
      onHostRequest: options.onHostRequest,
      mcpServers,
    });
    this.textSessions.add(session);
    try {
      await session.start();
    } catch (error) {
      this.textSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Preserve the stable session start failure rather than a cleanup error.
      }
      throw error;
    }

    let stopped = false;
    return Object.freeze({
      provider,
      async *streamTurn(
        text: string,
        abortSignal?: AbortSignal,
        attachments?: readonly SubscriptionPromptAttachment[],
      ): AsyncIterable<StreamEvent> {
        const prompt = await session.startPrompt({ text, abortSignal, attachments });
        for await (const event of prompt.events) yield event;
        await prompt.completion;
      },
      cancelActiveTurn: () => session.cancelActivePrompt(),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.textSessions.delete(session);
        await session.stop();
      },
    });
  }

  async verify(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].verify();
  }

  async startDeviceCodeLogin(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].startDeviceCodeLogin();
  }

  async openPendingVerificationUrl(
    provider: AcpSubscriptionProviderId,
    openExternal: (url: string) => Promise<void>,
  ): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].openPendingVerificationUrl(openExternal);
  }

  async cancelLogin(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].cancelLogin();
  }

  async logout(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].logout();
  }

  async stopAll(): Promise<void> {
    const textSessions = [...this.textSessions];
    this.textSessions.clear();
    await Promise.all([
      ...textSessions.map((session) => session.stop()),
      ...ACP_SUBSCRIPTION_PROVIDER_IDS.map((provider) => this.clients[provider].stop()),
    ]);
  }

  private async prepareRuntime(provider: AcpSubscriptionProviderId): Promise<{
    readonly runtimeHome: string;
    readonly workspaceDir: string;
    readonly runtimeTempDir: string;
  }> {
    const directoryNames = acpSubscriptionRuntimeDirectoryNames(provider);
    const [runtimeHome, workspaceDir, runtimeTempDir] = await Promise.all([
      this.namespace.childDir(directoryNames.runtimeHome),
      this.namespace.childDir(directoryNames.workspaceDir),
      this.namespace.childDir(directoryNames.runtimeTempDir),
    ]);
    await ensureAcpSubscriptionNativePolicy(provider, runtimeHome);
    return Object.freeze({ runtimeHome, workspaceDir, runtimeTempDir });
  }
}

// ─── Subscription runtime service ─────────────────────────────────────────────

const ACP_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS: SubscriptionImageAttachmentLimits = Object.freeze({
  maxCount: MAX_ACP_SUBSCRIPTION_IMAGE_ATTACHMENTS,
  maxBytesPerImage: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES,
  maxTotalBytes: MAX_ACP_SUBSCRIPTION_IMAGE_TOTAL_BYTES,
});

const MAX_QUEUED_EVENTS = 256;
const HOST_TOOL_ACCEPTED = "LVIS accepted the host tool request and will provide its result in the next model round.";

export type SubscriptionOpenExternal = (url: string) => Promise<void> | void;

/** A redacted audit observation: never include prompt, path, command, or RPC params. */
export interface SubscriptionRuntimeAuditEvent {
  readonly provider: SubscriptionRuntimeId;
  readonly outcome: "host-request-rejected" | "model-fallback" | "session-failed";
  readonly requestKind?: string;
}

export type SubscriptionRuntimeAuditSink = (
  event: SubscriptionRuntimeAuditEvent,
) => void | Promise<void>;

export class SubscriptionRuntimeServiceError extends Error {
  constructor(readonly code: SubscriptionRuntimeErrorCode) {
    super(code);
    this.name = "SubscriptionRuntimeServiceError";
  }
}

export interface SubscriptionTextSession {
  readonly provider: SubscriptionRuntimeId;
  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent>;
  cancelActiveTurn(): Promise<void>;
  stop(): Promise<void>;
}

/** Main-only schemas for one model round; never sourced from renderer IPC. */
export interface SubscriptionTextSessionOptions {
  readonly tools?: readonly ToolSchema[];
  /**
   * Settings-normalized parent selection for a transient sub-agent Codex
   * candidate. It is considered only after the current live catalog rejects
   * that candidate; catalog lookup failures remain fail-closed.
   */
  readonly fallbackSelection?: SubscriptionChatRuntimeSelection;
}

interface CodexTextRuntimePaths {
  readonly runtimeHome: string;
  readonly sqliteHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
}

export interface SubscriptionRuntimeServiceCreateOptions {
  readonly namespace?: FeatureNamespaceHandle;
  /** Test seam; production always constructs the packaged account client. */
  readonly createCodexAppServerClient?: (
    options: ConstructorParameters<typeof CodexAppServerClient>[0],
  ) => CodexAppServerClient;
  readonly codexClient?: CodexAppServerClient;
  readonly acpRegistry?: AcpSubscriptionRuntimeRegistry;
  readonly createCodexConversationRuntime?: (
    options: CodexConversationRuntimeOptions,
  ) => CodexConversationRuntime;
  readonly audit?: SubscriptionRuntimeAuditSink;
}

export interface GetSubscriptionRuntimeServiceOptions {
  readonly audit?: SubscriptionRuntimeAuditSink;
}

function isConnectedAndReady(status: {
  readonly runtime: SubscriptionRuntimeState;
  readonly connection: SubscriptionConnectionState;
}): boolean {
  return status.runtime === "ready" && status.connection === "connected";
}

/** Every non-credential capability is exposed only after the host transport proof. */
function verifiedRuntimeCapabilities(
  runtimeId: SubscriptionRuntimeId,
  verified: boolean,
  supportsImages = false,
): SubscriptionRuntimeCapabilities {
  if (!verified) {
    return DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES;
  }
  const imageAttachmentLimits = runtimeId === "codex"
    ? DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS
    // ACP runtimes use the standard image content block only after the
    // provider negotiated that capability during initialize. Keep the shared
    // ACP transport limits independent of the individual provider name.
    : supportsImages
      ? ACP_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS
      : null;
  return Object.freeze({
    chat: true,
    // Codex has a documented localImage turn input. ACP runtimes must instead
    // prove the standard image content block in their initialize response.
    images: imageAttachmentLimits !== null,
    imageAttachmentLimits,
    // This is deliberately not raw file-upload parity. The renderer's normal
    // FileAttachment marker remains paired with the governed LVIS read tool.
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
}

function codexStatus(
  status: CodexSubscriptionStatus,
  safelyVerified: boolean,
): SubscriptionRuntimeStatus {
  return {
    provider: "codex",
    runtime: status.runtime,
    connection: status.connection,
    planType: status.planType,
    pendingLogin: status.pendingLogin,
    pendingDeviceCode: status.pendingDeviceCode,
    // Codex opens only allowlisted URLs as part of the managed login request;
    // the URL is intentionally never retained for a renderer re-open action.
    canOpenVerificationUrl: false,
    version: null,
    capabilities: verifiedRuntimeCapabilities("codex", safelyVerified && isConnectedAndReady(status)),
  };
}

function acpRuntimeState(status: AcpSubscriptionStatus): SubscriptionRuntimeState {
  return status.runtime;
}

function acpConnectionState(status: AcpSubscriptionStatus): SubscriptionConnectionState {
  return status.connection;
}

function acpStatus(
  status: AcpSubscriptionStatus,
  safelyVerified: boolean,
): SubscriptionRuntimeStatus {
  return {
    provider: status.provider,
    runtime: acpRuntimeState(status),
    connection: acpConnectionState(status),
    planType: null,
    pendingLogin: status.pendingLogin,
    pendingDeviceCode: status.pendingDeviceCode,
    canOpenVerificationUrl: status.canOpenVerificationUrl,
    version: status.version,
    capabilities: verifiedRuntimeCapabilities(
      status.provider,
      safelyVerified && isConnectedAndReady(status),
      status.promptCapabilities.image,
    ),
  };
}

function isAcpRuntime(runtimeId: SubscriptionRuntimeId): runtimeId is AcpSubscriptionProviderId {
  return isAcpSubscriptionProviderId(runtimeId);
}

function validSelection(
  selection: SubscriptionChatRuntimeSelection,
): SubscriptionChatRuntimeSelection | null {
  if (selection.kind !== "subscription" || !isSubscriptionRuntimeId(selection.provider)) return null;
  if (selection.model === undefined) {
    return Object.freeze({ kind: "subscription", provider: selection.provider });
  }
  if (!subscriptionRuntimeDescriptor(selection.provider).supportsModelSelection) return null;
  const model = selection.model.trim();
  if (
    !model
    || model.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(model)
  ) {
    return null;
  }
  return Object.freeze({ kind: "subscription", provider: selection.provider, model });
}

function abortError(): Error {
  const error = new Error("subscription-runtime-aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Maps every provider-specific failure to the stable renderer-safe union. */
export function subscriptionRuntimeErrorCode(error: unknown): SubscriptionRuntimeErrorCode {
  if (error instanceof SubscriptionRuntimeServiceError) return error.code;
  if (error instanceof CodexAppServerError) {
    switch (error.code) {
      case "codex-runtime-unavailable":
      case "codex-runtime-start-failed":
        return "subscription-runtime-unavailable";
      case "codex-login-in-progress":
        return "subscription-login-in-progress";
      case "codex-login-failed":
        return "subscription-login-failed";
      default:
        return "subscription-operation-failed";
    }
  }
  if (error instanceof CodexConversationRuntimeError) {
    return error.code === "codex-runtime-unavailable" || error.code === "codex-runtime-start-failed"
      ? "subscription-runtime-unavailable"
      : "subscription-operation-failed";
  }
  if (error instanceof AcpSubscriptionRuntimeError) {
    switch (error.code) {
      case "acp-runtime-not-configured":
        return "subscription-runtime-not-configured";
      case "acp-runtime-unavailable":
      case "acp-runtime-invalid-executable":
        return "subscription-runtime-unavailable";
      case "acp-login-in-progress":
        return "subscription-login-in-progress";
      case "acp-login-failed":
        return "subscription-login-failed";
      case "acp-verification-url-unavailable":
        return "subscription-verification-url-unavailable";
      case "acp-logout-not-supported":
        return "subscription-logout-not-supported";
      default:
        return "subscription-operation-failed";
    }
  }
  if (error instanceof AcpSubscriptionSessionError) {
    return error.code === "acp-session-authentication-required"
      ? "subscription-chat-unavailable"
      : "subscription-operation-failed";
  }
  return "subscription-operation-failed";
}

function stableError(error: unknown): Error {
  // Attachment transport failures are already fixed, local boundary codes.
  // Preserve them to SubscriptionLlmProvider so size/capability feedback stays
  // actionable without exposing runtime output or protocol detail.
  if (
    error instanceof SubscriptionRuntimeServiceError
    || error instanceof SubscriptionAttachmentTransportError
  ) {
    return error;
  }
  return new SubscriptionRuntimeServiceError(subscriptionRuntimeErrorCode(error));
}

/**
 * Preserve only the transport's already-sanitized recovery facts. The string
 * is intentionally generic because SubscriptionLlmProvider owns the final
 * renderer-safe error projection.
 */
function transportDiagnosticFailure(error: unknown): Extract<StreamEvent, { type: "error" }> | undefined {
  const providerError = projectedSubscriptionTransportDiagnosticsFromError(error);
  return providerError
    ? {
      type: "error",
      error: "Subscription runtime operation failed.",
      providerError,
    }
    : undefined;
}

/** Convert the already-sanitized Codex `last` snapshot into non-billable SOT. */
function codexReportedSubscriptionUsage(
  selection: SubscriptionChatRuntimeSelection,
  usage: CodexConversationTokenUsage,
): SubscriptionUsageTelemetry | undefined {
  return normalizeSubscriptionUsageTelemetry({
    provider: "codex",
    model: selection.model ?? "default",
    source: "provider-reported",
    billable: false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedInputTokens !== undefined ? { cacheReadTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {}),
    ...(usage.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: usage.reasoningOutputTokens }
      : {}),
    ...(usage.modelContextWindow !== undefined ? { contextWindow: usage.modelContextWindow } : {}),
  });
}

/** Bounded single-consumer bridge from callback-style Codex events. */
class SubscriptionEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason: Error) => void;
  } | null = null;
  private completed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.completed || this.failure) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
    if (this.values.length > MAX_QUEUED_EVENTS) {
      this.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
    }
  }

  finish(): void {
    if (this.completed || this.failure) return;
    this.completed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: Error): void {
    if (this.failure) return;
    // A late native-host rejection or transport failure must invalidate a
    // scheduled tool boundary rather than letting already-buffered events run.
    this.completed = false;
    this.values.length = 0;
    this.failure = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.completed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

class CodexSubscriptionTextSession implements SubscriptionTextSession {
  readonly provider = "codex" as const;
  private stopped = false;

  constructor(
    private readonly runtime: CodexConversationRuntime,
    private readonly selection: SubscriptionChatRuntimeSelection,
    private readonly onUnsafeRequest: (kind: string) => void,
    private readonly bridge: SubscriptionToolBridge,
  ) {}

  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    return this.stream(text, abortSignal, attachments);
  }

  async cancelActiveTurn(): Promise<void> {
    if (this.stopped || !this.runtime.isTurnActive()) return;
    try {
      await this.runtime.interrupt();
    } catch {
      this.runtime.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.runtime.stop();
    await this.bridge.stop();
  }

  private async *stream(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    if (this.stopped) throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
    if (abortSignal?.aborted) throw abortError();

    const queue = new SubscriptionEventQueue<StreamEvent>();
    let completed = false;
    let toolBoundary = false;
    let aborted = false;
    let unsafeRequest = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      // Cancellation is terminal at the host boundary. Do not wait for a
      // provider to acknowledge it before rejecting buffered or late output.
      queue.fail(abortError());
      void this.cancelActiveTurn().catch(() => undefined);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    this.bridge.setHandler((call) => {
      if (toolBoundary || aborted || unsafeRequest || this.stopped) {
        throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
      }
      toolBoundary = true;
      // Return the protocol response first, then end this remote turn. The
      // engine executes the emitted call through its normal ToolExecutor and
      // starts a fresh remote turn containing the LVIS tool_result.
      setImmediate(() => {
        if (unsafeRequest) {
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
          return;
        }
        if (aborted || this.stopped) return;
        queue.push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        queue.push({ type: "message_complete", stopReason: "tool_use" });
        queue.finish();
        void this.cancelActiveTurn().catch(() => undefined);
      });
      return HOST_TOOL_ACCEPTED;
    });

    const turn = this.runtime.startTurn(
      {
        text,
        ...(attachments?.length ? { attachments } : {}),
        ...(this.selection.model ? { model: this.selection.model } : {}),
        ...(abortSignal ? { abortSignal } : {}),
        dynamicTools: this.bridge.tools,
      },
      {
        onTextDelta: (event) => {
          if (!toolBoundary && !aborted) queue.push({ type: "text_delta", text: event.delta });
        },
        onReasoningDelta: (event) => {
          if (!toolBoundary && !aborted) queue.push({ type: "reasoning_delta", text: event.delta });
        },
        onServerRequest: (request) => {
          // App Server invokes onServerRequest before its dedicated dynamic
          // callback. Native and future reverse RPC remain deny-only.
          if (request.kind === "dynamic-tool") return;
          unsafeRequest = true;
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
          this.onUnsafeRequest(request.kind);
          this.runtime.stop();
        },
        onDynamicToolCall: (call) => this.bridge.invoke(call.tool, call.arguments),
      },
    );
    void turn.then(
      (result) => {
        if (aborted) {
          queue.fail(abortError());
          return;
        }
        if (toolBoundary) {
          if (unsafeRequest) {
            queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
            return;
          }
          completed = true;
          return;
        }
        if (result.status === "completed") {
          completed = true;
          const subscriptionUsage = result.tokenUsage
            ? codexReportedSubscriptionUsage(this.selection, result.tokenUsage)
            : undefined;
          queue.push({
            type: "message_complete",
            stopReason: "end_turn",
            ...(subscriptionUsage ? { subscriptionUsage } : {}),
          });
          queue.finish();
          return;
        }
        const diagnosticFailure = transportDiagnosticFailure(result);
        if (diagnosticFailure) {
          completed = true;
          queue.push(diagnosticFailure);
          queue.finish();
          return;
        }
        queue.fail(result.status === "interrupted"
          ? abortError()
          : new SubscriptionRuntimeServiceError("subscription-operation-failed"));
      },
      (error: unknown) => {
        if (aborted) {
          queue.fail(abortError());
          return;
        }
        if (!toolBoundary || unsafeRequest) {
          const diagnosticFailure = aborted ? undefined : transportDiagnosticFailure(error);
          if (diagnosticFailure) {
            completed = true;
            queue.push(diagnosticFailure);
            queue.finish();
            return;
          }
          queue.fail(aborted || isAbortError(error) ? abortError() : stableError(error));
        }
      },
    );

    try {
      for await (const event of queue) yield event;
    } finally {
      this.bridge.setHandler(null);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!completed && (!toolBoundary || unsafeRequest)) await this.cancelActiveTurn();
    }
  }
}

/** Wrap an ACP session so only the LVIS-owned MCP bridge can emit tool calls. */
class BridgedAcpSubscriptionTextSession implements SubscriptionTextSession {
  readonly provider: AcpSubscriptionTextSession["provider"];
  private stopped = false;

  constructor(
    private readonly session: AcpSubscriptionTextSession,
    private readonly bridge: SubscriptionToolBridge,
    private readonly isUnsafeHostRequest: () => boolean,
  ) {
    this.provider = session.provider;
  }

  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    return this.stream(text, abortSignal, attachments);
  }

  async cancelActiveTurn(): Promise<void> {
    if (this.stopped) return;
    await this.session.cancelActiveTurn();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.session.stop();
    } finally {
      await this.bridge.stop();
    }
  }

  private async *stream(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    if (this.stopped) throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
    if (abortSignal?.aborted) throw abortError();

    const queue = new SubscriptionEventQueue<StreamEvent>();
    let completed = false;
    let toolBoundary = false;
    let aborted = false;
    let transportFailed = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      // Cancellation is terminal at the host boundary. Do not wait for a
      // provider to acknowledge it before rejecting buffered or late output.
      queue.fail(abortError());
      void this.cancelActiveTurn().catch(() => undefined);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    this.bridge.setHandler((call) => {
      if (toolBoundary || aborted || transportFailed || this.isUnsafeHostRequest() || this.stopped) {
        throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
      }
      toolBoundary = true;
      setImmediate(() => {
        if (transportFailed || this.isUnsafeHostRequest()) {
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
          return;
        }
        if (aborted || this.stopped) return;
        queue.push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        queue.push({ type: "message_complete", stopReason: "tool_use" });
        queue.finish();
        void this.cancelActiveTurn().catch(() => undefined);
      });
      return HOST_TOOL_ACCEPTED;
    });

    void (async () => {
      try {
        for await (const event of this.session.streamTurn(text, abortSignal, attachments)) {
          if (!toolBoundary && !aborted) queue.push(event);
        }
        if (!aborted && !toolBoundary && !transportFailed && !this.isUnsafeHostRequest()) {
          completed = true;
          queue.finish();
        } else if (!aborted && this.isUnsafeHostRequest()) {
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
        }
      } catch (error) {
        if (aborted) {
          queue.fail(abortError());
          return;
        }
        transportFailed = true;
        const diagnosticFailure = transportDiagnosticFailure(error);
        if (diagnosticFailure) {
          completed = true;
          queue.push(diagnosticFailure);
          queue.finish();
          return;
        }
        queue.fail(stableError(error));
      }
    })();

    try {
      for await (const event of queue) yield event;
    } finally {
      this.bridge.setHandler(null);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!completed && (!toolBoundary || transportFailed || this.isUnsafeHostRequest())) await this.cancelActiveTurn();
    }
  }
}

/**
 * Main-process-only facade. It is the only owner of authenticated runtime
 * state and live governed model sessions. Chat availability is intentionally
 * stricter than authentication: it becomes true only after safety verification.
 */
export class SubscriptionRuntimeService {
  private readonly safelyVerified = new Set<SubscriptionRuntimeId>();
  private readonly safetyEpochByProvider = new Map<SubscriptionRuntimeId, number>();
  private readonly activeSessions = new Set<SubscriptionTextSession>();
  /** Terminal per-instance guard for callers that retained a service reference during shutdown. */
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  private constructor(
    private readonly codexClient: CodexAppServerClient,
    private readonly acpRegistry: AcpSubscriptionRuntimeRegistry,
    private readonly codexTextRuntimePaths: CodexTextRuntimePaths,
    private readonly createCodexConversationRuntime: (
      options: CodexConversationRuntimeOptions,
    ) => CodexConversationRuntime,
    private readonly audit?: SubscriptionRuntimeAuditSink,
  ) {}

  static async create(
    openExternal: SubscriptionOpenExternal,
    options: SubscriptionRuntimeServiceCreateOptions = {},
  ): Promise<SubscriptionRuntimeService> {
    const namespace = options.namespace ?? openFeatureNamespace("subscription-runtimes");
    const [
      codexHome,
      codexSqlite,
      loginWorkspace,
      loginTemp,
      textWorkspace,
      textTemp,
      registry,
    ] = await Promise.all([
      namespace.childDir("codex-v3-home"),
      namespace.childDir("codex-v3-sqlite"),
      namespace.childDir("codex-login-v2-workspace"),
      namespace.childDir("codex-login-v2-tmp"),
      namespace.childDir("codex-text-v2-workspace"),
      namespace.childDir("codex-text-v2-tmp"),
      options.acpRegistry ? Promise.resolve(options.acpRegistry) : AcpSubscriptionRuntimeRegistry.create({ namespace }),
    ]);
    const createCodexAppServerClient = options.createCodexAppServerClient
      ?? ((clientOptions: ConstructorParameters<typeof CodexAppServerClient>[0]) => new CodexAppServerClient(clientOptions));
    const codexClient = options.codexClient ?? createCodexAppServerClient({
      runtimeHome: codexHome,
      sqliteHome: codexSqlite,
      workspaceDir: loginWorkspace,
      runtimeTempDir: loginTemp,
      openExternal,
    });
    return new SubscriptionRuntimeService(
      codexClient,
      registry,
      Object.freeze({
        runtimeHome: codexHome,
        sqliteHome: codexSqlite,
        workspaceDir: textWorkspace,
        runtimeTempDir: textTemp,
      }),
      options.createCodexConversationRuntime ?? ((runtimeOptions) => new CodexConversationRuntime(runtimeOptions)),
      options.audit,
    );
  }

  /** Read-only status. A connected account remains unavailable until verify() proves isolation. */
  async getStatus(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    return this.withStableErrors(async () => {
      if (runtimeId === "codex") return this.projectCodexStatus(await this.codexClient.getStatus());
      return this.projectAcpStatus(await this.acpRegistry.getStatus(runtimeId));
    });
  }

  /** Error projection without forcing a new runtime start or credential refresh. */
  getCachedStatus(runtimeId: SubscriptionRuntimeId): SubscriptionRuntimeStatus | undefined {
    if (this.stopped) return undefined;
    if (runtimeId !== "codex") return undefined;
    return this.projectCodexStatus(this.codexClient.getCachedStatus());
  }

  async chooseExecutable(
    runtimeId: SubscriptionRuntimeId,
    pickerPath: string,
  ): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (!isAcpRuntime(runtimeId)) throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
    this.invalidateSafety(runtimeId);
    await this.stopSessionsFor(runtimeId);
    return this.withStableErrors(async () => this.projectAcpStatus(
      await this.acpRegistry.setExecutable(runtimeId, pickerPath),
    ));
  }

  async forgetExecutable(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (!isAcpRuntime(runtimeId)) throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
    this.invalidateSafety(runtimeId);
    await this.stopSessionsFor(runtimeId);
    return this.withStableErrors(async () => this.projectAcpStatus(
      await this.acpRegistry.forgetExecutable(runtimeId),
    ));
  }

  /** Authenticate, then prove the provider's isolated governed transport is safe to use. */
  async verify(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    const verificationEpoch = this.invalidateSafety(runtimeId);
    await this.stopSessionsFor(runtimeId);
    return this.withStableErrors(async () => {
      if (runtimeId === "codex") {
        const status = await this.codexClient.getStatus();
        this.assertRunning();
        if (!this.safetyEpochIsCurrent(runtimeId, verificationEpoch)) {
          return this.getStatus(runtimeId);
        }
        if (!isConnectedAndReady(status)) return this.projectCodexStatus(status);
        const runtime = this.createCodexConversationRuntime(this.codexTextRuntimePaths);
        try {
          await runtime.verifyIsolation();
          this.assertRunning();
        } finally {
          runtime.stop();
        }
        if (!this.safetyEpochIsCurrent(runtimeId, verificationEpoch)) {
          return this.getStatus(runtimeId);
        }
        this.safelyVerified.add("codex");
        return this.projectCodexStatus(status);
      }
      const status = await this.acpRegistry.verify(runtimeId);
      this.assertRunning();
      if (!this.safetyEpochIsCurrent(runtimeId, verificationEpoch)) {
        return this.getStatus(runtimeId);
      }
      if (isConnectedAndReady(status)) {
        this.safelyVerified.add(runtimeId);
      }
      return this.projectAcpStatus(status);
    });
  }

  async startLogin(
    runtimeId: SubscriptionRuntimeId,
    method: SubscriptionLoginMethod,
  ): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    this.invalidateSafety(runtimeId);
    await this.stopSessionsFor(runtimeId);
    return this.withStableErrors(async () => {
      if (runtimeId === "codex") {
        if (method === "browser") return this.projectCodexStatus(await this.codexClient.startBrowserLogin());
        const result = await this.codexClient.startDeviceCodeLogin();
        return this.projectCodexStatus(result.status);
      }
      if (method !== "device-code") {
        throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
      }
      return this.projectAcpStatus(await this.acpRegistry.startDeviceCodeLogin(runtimeId));
    });
  }

  async openPendingVerificationUrl(
    runtimeId: SubscriptionRuntimeId,
    openExternal: SubscriptionOpenExternal,
  ): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (!isAcpRuntime(runtimeId)) {
      throw new SubscriptionRuntimeServiceError("subscription-verification-url-unavailable");
    }
    return this.withStableErrors(async () => this.projectAcpStatus(
      await this.acpRegistry.openPendingVerificationUrl(runtimeId, async (url) => {
        await openExternal(url);
      }),
    ));
  }

  async cancelLogin(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    this.invalidateSafety(runtimeId);
    await this.stopSessionsFor(runtimeId);
    return this.withStableErrors(async () => runtimeId === "codex"
      ? this.projectCodexStatus(await this.codexClient.cancelLogin())
      : this.projectAcpStatus(await this.acpRegistry.cancelLogin(runtimeId)));
  }

  async logout(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    this.invalidateSafety(runtimeId);
    await this.stopSessionsFor(runtimeId);
    return this.withStableErrors(async () => {
      if (runtimeId === "codex") return this.projectCodexStatus(await this.codexClient.logout());
      if (runtimeId !== "grok-build") {
        throw new SubscriptionRuntimeServiceError("subscription-logout-not-supported");
      }
      return this.projectAcpStatus(await this.acpRegistry.logout(runtimeId));
    });
  }

  async listModels(runtimeId: SubscriptionRuntimeId): Promise<{
    status: SubscriptionRuntimeStatus;
    models: SubscriptionRuntimeModel[];
  }> {
    this.assertRunning();
    return this.withStableErrors(async () => {
      if (runtimeId !== "codex") return { status: await this.getStatus(runtimeId), models: [] };
      const result = await this.codexClient.listModels();
      return {
        status: this.projectCodexStatus(result.status),
        models: result.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          isDefault: model.isDefault,
        })),
      };
    });
  }

  /** Opens one main-owned, LVIS-governed session after rechecking availability. */
  async openTextSession(
    selection: SubscriptionChatRuntimeSelection,
    options: SubscriptionTextSessionOptions = {},
  ): Promise<SubscriptionTextSession> {
    this.assertRunning();
    const safeSelection = validSelection(selection);
    if (!safeSelection) throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    const safeFallbackSelection = options.fallbackSelection === undefined
      ? undefined
      : validSelection(options.fallbackSelection);
    if (
      options.fallbackSelection !== undefined
      && (
        !safeFallbackSelection
        || safeFallbackSelection.provider !== safeSelection.provider
        || safeSelection.provider !== "codex"
      )
    ) {
      throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    }
    let safetyEpoch = this.safetyEpoch(safeSelection.provider);
    let status = await this.getStatus(safeSelection.provider);
    this.assertSafetyEpochCurrent(safeSelection.provider, safetyEpoch);
    // A persisted selection survives app restart, while the in-memory safety
    // proof intentionally does not. Re-prove only for an explicit model turn.
    if (!status.capabilities.chat && isConnectedAndReady(status)) {
      status = await this.verify(safeSelection.provider);
      this.assertRunning();
      safetyEpoch = this.safetyEpoch(safeSelection.provider);
    }
    if (!status.capabilities.chat) throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");

    let effectiveSelection = safeSelection;
    if (
      safeSelection.provider === "codex"
      && (safeSelection.model !== undefined || safeFallbackSelection !== undefined)
    ) {
      // Persisted selections and transient sub-agent overrides bypass the
      // renderer IPC. Re-enumerate against the current subscription-scoped
      // catalog before forwarding either model ID.
      const catalog = await this.listModels("codex");
      this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
      if (!catalog.status.capabilities.chat) {
        throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
      }
      const selectable = (candidate: SubscriptionChatRuntimeSelection): boolean =>
        candidate.model === undefined || catalog.models.some((model) => model.id === candidate.model);
      if (!selectable(safeSelection)) {
        if (!safeFallbackSelection || !selectable(safeFallbackSelection)) {
          throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
        }
        this.emitAudit({ provider: "codex", outcome: "model-fallback" });
        effectiveSelection = safeFallbackSelection;
      }
    }

    this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
    return this.withStableErrors(async () => {
      this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
      const bridge = new SubscriptionToolBridge(options.tools);
      try {
        if (effectiveSelection.provider === "codex") {
          const runtime = this.createCodexConversationRuntime(this.codexTextRuntimePaths);
          return await this.trackVerifiedSession(new CodexSubscriptionTextSession(
            runtime,
            effectiveSelection,
            (kind) => this.rejectUnsafeRequest("codex", kind),
            bridge,
          ), safetyEpoch);
        }
        const mcpServers = bridge.tools.length === 0
          ? []
          : [await bridge.startMcpServer()];
        this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
        let unsafeHostRequest = false;
        const session = await this.acpRegistry.openTextSession(effectiveSelection.provider, {
          onHostRequest: (request) => {
            unsafeHostRequest = true;
            this.rejectUnsafeRequest(effectiveSelection.provider, request.kind);
          },
          mcpServers,
        });
        return await this.trackVerifiedSession(new BridgedAcpSubscriptionTextSession(
          session,
          bridge,
          () => unsafeHostRequest,
        ), safetyEpoch);
      } catch (error) {
        try {
          await bridge.stop();
        } catch {
          // Preserve the stable open failure rather than cleanup detail.
        }
        throw error;
      }
    });
  }

  /** Stops all login and conversation children. Terminal and idempotent per service instance. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // Set synchronously before snapshotting so an already-held reference cannot
    // add a late session while the active set is being drained.
    this.stopped = true;
    this.stopPromise = (async () => {
      const sessions = [...this.activeSessions];
      this.activeSessions.clear();
      await Promise.allSettled(sessions.map((session) => session.stop()));
      this.safelyVerified.clear();
      this.codexClient.stop();
      await this.acpRegistry.stopAll();
    })();
    return this.stopPromise;
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
    }
  }

  private projectCodexStatus(status: CodexSubscriptionStatus): SubscriptionRuntimeStatus {
    this.reconcileSafety("codex", status);
    return codexStatus(status, this.safelyVerified.has("codex"));
  }

  private projectAcpStatus(status: AcpSubscriptionStatus): SubscriptionRuntimeStatus {
    this.reconcileSafety(status.provider, status);
    return acpStatus(status, this.safelyVerified.has(status.provider));
  }

  private reconcileSafety(
    provider: SubscriptionRuntimeId,
    status: { readonly runtime: SubscriptionRuntimeState; readonly connection: SubscriptionConnectionState },
  ): void {
    if (!isConnectedAndReady(status)) this.invalidateSafety(provider);
  }

  private async stopSessionsFor(provider: SubscriptionRuntimeId): Promise<void> {
    const sessions = [...this.activeSessions].filter((session) => session.provider === provider);
    // Session cleanup is best effort here: an auth/logout mutation must not be
    // blocked by a third-party runtime that is already being force-stopped.
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }

  /**
   * Synchronously revoke every proof tied to this provider and advance its
   * epoch. Any in-flight verify/open operation that captured an earlier epoch
   * must fail closed rather than re-authorizing a newly selected runtime.
   */
  private invalidateSafety(provider: SubscriptionRuntimeId): number {
    this.safelyVerified.delete(provider);
    const nextEpoch = this.safetyEpoch(provider) + 1;
    this.safetyEpochByProvider.set(provider, nextEpoch);
    return nextEpoch;
  }

  private safetyEpoch(provider: SubscriptionRuntimeId): number {
    return this.safetyEpochByProvider.get(provider) ?? 0;
  }

  private safetyEpochIsCurrent(provider: SubscriptionRuntimeId, epoch: number): boolean {
    return this.safetyEpoch(provider) === epoch;
  }

  private assertSafetyEpoch(provider: SubscriptionRuntimeId, epoch: number): void {
    this.assertSafetyEpochCurrent(provider, epoch);
    if (!this.safelyVerified.has(provider)) {
      throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    }
  }

  private assertSafetyEpochCurrent(provider: SubscriptionRuntimeId, epoch: number): void {
    this.assertRunning();
    if (!this.safetyEpochIsCurrent(provider, epoch)) {
      throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    }
  }


  private rejectUnsafeRequest(provider: SubscriptionRuntimeId, requestKind: string): void {
    this.invalidateSafety(provider);
    this.emitAudit({ provider, outcome: "host-request-rejected", requestKind });
  }

  private sessionFailed(provider: SubscriptionRuntimeId): void {
    this.invalidateSafety(provider);
    this.emitAudit({ provider, outcome: "session-failed" });
  }

  private emitAudit(event: SubscriptionRuntimeAuditEvent): void {
    try {
      const pending = this.audit?.(Object.freeze({ ...event }));
      void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Auditing cannot turn a deny/cleanup decision into a permissive one.
    }
  }

  private async trackSession(
    session: AcpSubscriptionTextSession | SubscriptionTextSession,
    safetyEpoch: number,
  ): Promise<SubscriptionTextSession> {
    if (this.stopped || !this.safetyEpochIsCurrent(session.provider, safetyEpoch) || !this.safelyVerified.has(session.provider)) {
      try {
        await session.stop();
      } catch {
        // Preserve the terminal service error rather than cleanup detail.
      }
      throw new SubscriptionRuntimeServiceError(
        this.stopped ? "subscription-operation-failed" : "subscription-chat-unavailable",
      );
    }
    let stopped = false;
    const tracked: SubscriptionTextSession = {
      provider: session.provider,
      streamTurn: (text, abortSignal, attachments) => this.streamTrackedSession(
        session,
        text,
        safetyEpoch,
        abortSignal,
        attachments,
      ),
      cancelActiveTurn: async () => {
        this.assertSafetyEpoch(session.provider, safetyEpoch);
        try {
          await session.cancelActiveTurn();
        } catch (error) {
          if (this.safetyEpochIsCurrent(session.provider, safetyEpoch)) {
            this.sessionFailed(session.provider);
          }
          throw stableError(error);
        }
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.activeSessions.delete(tracked);
        try {
          await session.stop();
        } catch (error) {
          if (this.safetyEpochIsCurrent(session.provider, safetyEpoch)) {
            this.sessionFailed(session.provider);
          }
          throw stableError(error);
        }
      },
    };
    this.activeSessions.add(tracked);
    return Object.freeze(tracked);
  }

  private async trackVerifiedSession(
    session: AcpSubscriptionTextSession | SubscriptionTextSession,
    safetyEpoch: number,
  ): Promise<SubscriptionTextSession> {
    const tracked = await this.trackSession(session, safetyEpoch);
    try {
      this.assertSafetyEpoch(session.provider, safetyEpoch);
      return tracked;
    } catch (error) {
      try {
        await tracked.stop();
      } catch {
        // The outer session-open cleanup remains best effort.
      }
      throw error;
    }
  }


  private async *streamTrackedSession(
    session: AcpSubscriptionTextSession | SubscriptionTextSession,
    text: string,
    safetyEpoch: number,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    this.assertSafetyEpoch(session.provider, safetyEpoch);
    try {
      for await (const event of session.streamTurn(text, abortSignal, attachments)) {
        this.assertSafetyEpoch(session.provider, safetyEpoch);
        yield event;
      }
    } catch (error) {
      // User cancellation is an expected lifecycle event, not evidence that a
      // previously verified subscription runtime became unsafe or unavailable.
      if (!isAbortError(error) && this.safetyEpochIsCurrent(session.provider, safetyEpoch)) {
        this.sessionFailed(session.provider);
      }
      throw stableError(error);
    }
  }

  private async withStableErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertRunning();
      const result = await operation();
      this.assertRunning();
      return result;
    } catch (error) {
      throw stableError(error);
    }
  }
}

let service: SubscriptionRuntimeService | null = null;
let createPromise: Promise<SubscriptionRuntimeService> | null = null;
let stopPromise: Promise<void> | null = null;
let stopped = false;

/** Lazily create the one main-owned service. The opener must be main-validated. */
export async function getSubscriptionRuntimeService(
  openExternal: SubscriptionOpenExternal,
  options: GetSubscriptionRuntimeServiceOptions = {},
): Promise<SubscriptionRuntimeService> {
  if (stopped) throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
  if (service) return service;
  if (!createPromise) {
    createPromise = SubscriptionRuntimeService.create(openExternal, options)
      .then(async (created) => {
        if (stopped) {
          await created.stop();
          throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
        }
        service = created;
        return created;
      })
      .finally(() => {
        createPromise = null;
      });
  }
  return createPromise;
}

/** Idempotently stop login and execution-capable subscription runtimes. */
export function stopSubscriptionRuntimes(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopped = true;
  stopPromise = (async () => {
    const active = service;
    service = null;
    if (active) await active.stop();
    const pending = createPromise;
    if (pending) {
      const late = await pending.catch(() => null);
      if (late && late !== active) await late.stop();
    }
  })().finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}
