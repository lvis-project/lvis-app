/**
 * Long-lived, main-process ACP JSONL client for one authenticated subscription
 * conversation. It is intentionally separate from the short-lived auth probe:
 * this transport keeps one ACP session alive only while an LVIS conversation is
 * using it.
 *
 * The caller must supply app-owned, isolated runtime directories and a
 * previously picker-approved executable. No filesystem, terminal, or MCP host
 * capabilities are advertised here except one caller-supplied LVIS MCP server.
 * If an ACP runtime nevertheless asks the host to execute a native tool or
 * grant permission, this client records only a safe observation, replies with
 * JSON-RPC method-not-found, and tears down the transport. The separately
 * supplied LVIS MCP bridge remains the only controlled tool path.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { StreamEvent } from "../engine/llm/types.js";
import {
  acpSubscriptionPromptCapabilitiesFromInitialize,
  DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES,
  type AcpSubscriptionPromptCapabilities,
  type AcpSubscriptionProviderId,
} from "../shared/acp-subscription.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import { MAX_COMPOSER_ATTACHMENT_COUNT } from "../shared/composer-image-input.js";
import type { SubscriptionImageAttachmentLimits } from "../shared/subscription-runtime.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  ACP_SUBSCRIPTION_RUNTIME_MANIFESTS,
  resolveAcpSubscriptionExecutable,
  sanitizedAcpSubscriptionEnvironment,
  type AcpSubscriptionRuntimeManifest,
} from "./acp-subscription-runtime-client.js";
import {
  validateAcpSubscriptionMcpServerConfigs,
  GROK_BUILD_GOVERNED_AGENT_PROFILE,
  type AcpSubscriptionMcpServerConfig,
} from "./acp-subscription-runtime-config.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import {
  projectSubscriptionTransportErrorDiagnostics,
  type SubscriptionTransportDiagnosticError,
} from "./subscription-transport-error-diagnostics.js";
import {
  assertSubscriptionPromptAttachments,
  SubscriptionAttachmentTransportError,
  type SubscriptionPromptAttachment,
} from "./subscription-attachment-input.js";
import { isRecord } from "../shared/is-record.js";
import type { PendingJsonRpcRequest } from "../lib/json-rpc-pending-request.js";

const MAX_RPC_LINE_BYTES = 1_000_000;
/** Native image cap that always fits the ACP JSONL transport with room for text. */
export const MAX_ACP_SUBSCRIPTION_IMAGE_ATTACHMENTS = MAX_COMPOSER_ATTACHMENT_COUNT;
export const MAX_ACP_SUBSCRIPTION_IMAGE_BYTES = 256 * 1024;
export const MAX_ACP_SUBSCRIPTION_IMAGE_TOTAL_BYTES = MAX_ACP_SUBSCRIPTION_IMAGE_BYTES;
/** Conservative serialized LVIS history budget when a native ACP image is present. */
export const MAX_ACP_SUBSCRIPTION_TEXT_WITH_IMAGES_BYTES = 256 * 1024;
export const ACP_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS: SubscriptionImageAttachmentLimits = Object.freeze({
  maxCount: MAX_ACP_SUBSCRIPTION_IMAGE_ATTACHMENTS,
  maxBytesPerImage: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES,
  maxTotalBytes: MAX_ACP_SUBSCRIPTION_IMAGE_TOTAL_BYTES,
});
const MAX_PROMPT_TEXT_BYTES = 512 * 1024;
const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_QUEUED_STREAM_EVENTS = 256;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_RPC_METHOD_LENGTH = 256;
const MAX_RPC_ID_LENGTH = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs;
const DEFAULT_PROMPT_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs;
const DEFAULT_ABORT_GRACE_MS = TOOL_TIMEOUT_POLICY.processTreeKillMs;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type RpcId = string | number;

type AcpSubscriptionSessionMcpServerParams = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

type AcpSubscriptionSessionNewParams = Readonly<{
  cwd: string;
  mcpServers: readonly AcpSubscriptionSessionMcpServerParams[];
  _meta?: Readonly<{
    agentProfile: typeof GROK_BUILD_GOVERNED_AGENT_PROFILE;
  }>;
}>;

/** Re-export the single Grok agent-policy source used by native and ACP paths. */
export { GROK_BUILD_GOVERNED_AGENT_PROFILE };


const GROK_BUILD_GOVERNED_AGENT_PROFILE_META = Object.freeze({
  agentProfile: GROK_BUILD_GOVERNED_AGENT_PROFILE,
});

/**
 * Reconstruct a narrow `session/new` object rather than forwarding an object
 * that can carry runtime-owned profile or MCP configuration. Kimi receives
 * the legacy shape exactly; the stock Grok Build client receives only LVIS's
 * governed profile and no model-selection override.
 */
export function buildAcpSubscriptionSessionNewParams(
  provider: AcpSubscriptionProviderId,
  workspaceDir: string,
  mcpServers: readonly AcpSubscriptionMcpServerConfig[],
): AcpSubscriptionSessionNewParams {
  const params = {
    cwd: workspaceDir,
    // Only the validated LVIS-owned stdio descriptor can cross this boundary;
    // native host RPC/tool requests remain fail-closed below.
    mcpServers: mcpServers.map((server) => ({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
    })),
  };
  return provider === "grok-build"
    ? { ...params, _meta: GROK_BUILD_GOVERNED_AGENT_PROFILE_META }
    : params;
}

type SpawnAcpRuntime = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export type AcpSubscriptionSessionErrorCode =
  | "acp-session-aborted"
  | "acp-session-authentication-required"
  | "acp-session-host-request-rejected"
  | "acp-session-invalid-prompt"
  | "acp-session-invalid-response"
  | "acp-session-operation-failed"
  | "acp-session-prompt-in-progress"
  | "acp-session-prompt-timeout"
  | "acp-session-request-timeout"
  | "acp-session-runtime-args-not-allowed"
  | "acp-session-native-tool-rejected"
  | "acp-session-start-failed"
  | "acp-session-stopped"
  | "acp-session-transport-closed";

/** Error surface intentionally contains a stable code only, never runtime output. */
export class AcpSubscriptionSessionError extends Error {
  constructor(
    readonly code: AcpSubscriptionSessionErrorCode,
    readonly providerError?: SubscriptionTransportDiagnosticError["providerError"],
  ) {
    super(code);
    this.name = "AcpSubscriptionSessionError";
  }
}

/**
 * Safe, main-process-only observation of an unsupported ACP server request.
 * Params are deliberately omitted: third-party runtimes can include paths,
 * credentials, or user content in a request payload.
 */
export interface AcpSubscriptionHostRequestObservation {
  readonly provider: AcpSubscriptionProviderId;
  readonly sessionId: string | null;
  readonly requestId: RpcId;
  readonly method: string;
  readonly kind: "permission" | "tool" | "other";
}

export interface AcpSubscriptionSessionClientOptions {
  provider: AcpSubscriptionProviderId;
  /** Previously picker-approved canonical executable; it is revalidated before spawn. */
  executablePath: string;
  /** Existing app-owned, isolated provider data directory. */
  runtimeHome: string;
  /** Existing app-owned isolated workspace. Never pass a user project directly. */
  workspaceDir: string;
  /** Existing app-owned temporary directory. Defaults to <runtimeHome>/tmp. */
  runtimeTempDir?: string;
  /**
   * Optional exact copy of the shared provider transport argv. Any difference
   * from `ACP_SUBSCRIPTION_RUNTIME_MANIFESTS[provider].acpArgs` is rejected.
   */
  runtimeArgs?: readonly string[];
  /**
   * The main-process-created LVIS MCP bridge for this one session. Zero or one
   * descriptors are validated and copied before `session/new`; renderer and
   * ACP runtime input cannot supply it or add another server.
   */
  mcpServers?: readonly AcpSubscriptionMcpServerConfig[];
  /** Main-only callback for a rejected reverse RPC request. It never receives params. */
  onHostRequest?: (request: AcpSubscriptionHostRequestObservation) => void | Promise<void>;
  /** Test seam; production uses the managed-child registry. */
  spawn?: SpawnAcpRuntime;
  /** Test seam; production reuses the executable validator from the auth client. */
  resolveExecutable?: (candidate: string) => Promise<string>;
  /** Test seam for launch options and environment construction. */
  platform?: NodeJS.Platform;
  clientVersion?: string;
  /** Bounded request timeout. Defaults to the shared MCP request policy. */
  requestTimeoutMs?: number;
  /** Bounded prompt timeout. Defaults to the shared sub-agent ceiling. */
  promptTimeoutMs?: number;
  /** Grace period after session/cancel before the managed process tree is killed. */
  abortGraceMs?: number;
}

export interface AcpSubscriptionSessionInfo {
  readonly provider: AcpSubscriptionProviderId;
  /** Opaque runtime value. Keep it in the main process; do not project through IPC. */
  readonly sessionId: string;
}

export interface AcpSubscriptionPromptInput {
  text: string;
  /** Original image bytes permitted only after ACP initialize negotiation. */
  attachments?: readonly SubscriptionPromptAttachment[];
  abortSignal?: AbortSignal;
}

type AcpSubscriptionPromptStopReason =
  | "cancelled"
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal";

interface AcpSubscriptionPromptResult {
  readonly stopReason: AcpSubscriptionPromptStopReason;
}

/**
 * One ACP prompt. `events` is single-consumer and already uses LVIS's generic
 * stream contract, while `completion` retains ACP's complete stop reason.
 */
export interface AcpSubscriptionPromptHandle {
  readonly events: AsyncIterable<StreamEvent>;
  readonly completion: Promise<AcpSubscriptionPromptResult>;
  cancel(): Promise<void>;
}

interface PendingRequest extends PendingJsonRpcRequest {
  readonly method: string;
}

interface StartedPrompt {
  requestId: number;
  readonly queue: AsyncEventQueue<StreamEvent>;
  readonly resolve: (result: AcpSubscriptionPromptResult) => void;
  readonly reject: (error: Error) => void;
  readonly abortSignal?: AbortSignal;
  abortListener?: () => void;
  cancelTimer?: NodeJS.Timeout;
  cancelling: boolean;
}

class AcpRemoteRpcError extends Error {
  constructor(readonly authenticationRequired: boolean) {
    super("acp-remote-rpc-error");
    this.name = "AcpRemoteRpcError";
  }
}

/** Minimal bounded async queue used by the one active ACP prompt. */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason: Error) => void;
  } | null = null;
  private failure: Error | null = null;
  private done = false;

  push(value: T): boolean {
    if (this.done || this.failure) return true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value, done: false });
      return true;
    }
    if (this.values.length >= MAX_QUEUED_STREAM_EVENTS) return false;
    this.values.push(value);
    return true;
  }

  finish(): void {
    if (this.done || this.failure) return;
    this.done = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: Error): void {
    if (this.failure || this.done) return;
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
      next: () => this.next(),
    };
  }

  private async next(): Promise<IteratorResult<T>> {
    if (this.failure) throw this.failure;
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.done) return { value: undefined as never, done: true };
    return new Promise<IteratorResult<T>>((resolveWaiter, rejectWaiter) => {
      this.waiter = { resolve: resolveWaiter, reject: rejectWaiter };
    });
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  if (!value || value.length > maxLength || CONTROL_CHARACTERS.test(value)) return null;
  return value;
}

function isRpcId(value: unknown): value is RpcId {
  return (typeof value === "number" && Number.isInteger(value))
    || (typeof value === "string" && boundedString(value, MAX_RPC_ID_LENGTH) !== null);
}

function authenticationRequired(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === -32_000 || error.code === -32_001) return true;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return /auth(?:entication)?|login|credential|token/.test(message);
}

function promptStopReason(value: unknown): AcpSubscriptionPromptStopReason | null {
  switch (value) {
    case "cancelled":
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return value;
    default:
      return null;
  }
}

function timeoutWithin(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs);
}

function approvedRuntimeArgs(
  provider: AcpSubscriptionProviderId,
  supplied: readonly string[] | undefined,
): readonly string[] {
  const expected = ACP_SUBSCRIPTION_RUNTIME_MANIFESTS[provider].acpArgs;
  if (
    supplied
    && (supplied.length !== expected.length || supplied.some((value, index) => value !== expected[index]))
  ) {
    throw new AcpSubscriptionSessionError("acp-session-runtime-args-not-allowed");
  }
  return [...expected];
}

function createAbortError(): Error {
  const error = new AcpSubscriptionSessionError("acp-session-aborted");
  error.name = "AbortError";
  return error;
}

function hostRequestKind(method: string): AcpSubscriptionHostRequestObservation["kind"] {
  const normalized = method.toLowerCase();
  if (normalized.includes("permission")) return "permission";
  if (
    normalized.includes("tool")
    || normalized.includes("terminal")
    || normalized.includes("filesystem")
    || normalized.includes("file_system")
  ) {
    return "tool";
  }
  return "other";
}

function spawnAcpSessionRuntime(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
): ChildProcess {
  return spawnManaged(command, args, options, { label: "acp-subscription-session" });
}

/**
 * ACP session lifecycle: `start()` is idempotent until `stop()` is called;
 * one client owns one ACP process and exactly one active prompt at a time.
 */
export class AcpSubscriptionSessionClient {
  private readonly manifest: AcpSubscriptionRuntimeManifest;
  private readonly spawn: SpawnAcpRuntime;
  private readonly resolveExecutable: (candidate: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly clientVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly runtimeArgs: readonly string[];
  private readonly mcpServers: readonly AcpSubscriptionMcpServerConfig[];
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private sessionId: string | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private promptCapabilities: AcpSubscriptionPromptCapabilities = DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES;
  private activePrompt: StartedPrompt | null = null;
  private stopped = false;

  constructor(private readonly options: AcpSubscriptionSessionClientOptions) {
    this.manifest = ACP_SUBSCRIPTION_RUNTIME_MANIFESTS[options.provider];
    this.spawn = options.spawn ?? spawnAcpSessionRuntime;
    this.platform = options.platform ?? process.platform;
    this.resolveExecutable = options.resolveExecutable
      ?? ((candidate) => resolveAcpSubscriptionExecutable(candidate, this.platform));
    this.clientVersion = options.clientVersion ?? getLvisAppVersion();
    this.requestTimeoutMs = timeoutWithin(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.promptTimeoutMs = timeoutWithin(options.promptTimeoutMs, DEFAULT_PROMPT_TIMEOUT_MS);
    this.abortGraceMs = timeoutWithin(options.abortGraceMs, DEFAULT_ABORT_GRACE_MS);
    this.runtimeArgs = approvedRuntimeArgs(options.provider, options.runtimeArgs);
    this.mcpServers = validateAcpSubscriptionMcpServerConfigs(options.mcpServers);
  }

  async start(): Promise<AcpSubscriptionSessionInfo> {
    await this.ensureStarted();
    const sessionId = this.sessionId;
    if (!sessionId) throw new AcpSubscriptionSessionError("acp-session-start-failed");
    return { provider: this.options.provider, sessionId };
  }

  /** Main-process-only opaque session ID; never project it over renderer IPC. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  async startPrompt(input: AcpSubscriptionPromptInput): Promise<AcpSubscriptionPromptHandle> {
    if (input.abortSignal?.aborted) throw createAbortError();
    const text = boundedString(input.text, MAX_PROMPT_TEXT_BYTES);
    if (!text) throw new AcpSubscriptionSessionError("acp-session-invalid-prompt");
    await this.ensureStarted();
    if (input.abortSignal?.aborted) throw createAbortError();
    const sessionId = this.sessionId;
    if (!sessionId) throw new AcpSubscriptionSessionError("acp-session-start-failed");
    if (this.activePrompt) throw new AcpSubscriptionSessionError("acp-session-prompt-in-progress");
    const prompt = this.promptBlocks(text, input.attachments);
    this.assertPromptFitsRpcLimit(sessionId, prompt, prompt.length > 1);

    const queue = new AsyncEventQueue<StreamEvent>();
    let resolveCompletion: (result: AcpSubscriptionPromptResult) => void = () => {};
    let rejectCompletion: (error: Error) => void = () => {};
    const completion = new Promise<AcpSubscriptionPromptResult>((resolvePrompt, rejectPrompt) => {
      resolveCompletion = resolvePrompt;
      rejectCompletion = rejectPrompt;
    });
    // `events` is commonly consumed without inspecting `completion`; retaining
    // this no-op handler prevents an intentional cancellation from becoming an
    // unhandled rejection while preserving the rejecting promise for callers.
    void completion.catch(() => undefined);

    const active: StartedPrompt = {
      requestId: 0,
      queue,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      cancelling: false,
    };
    if (input.abortSignal) {
      const listener = () => {
        void this.cancelPrompt(active, createAbortError());
      };
      active.abortListener = listener;
      input.abortSignal.addEventListener("abort", listener, { once: true });
    }
    this.activePrompt = active;

    const request = this.sendRequest(
      "session/prompt",
      { sessionId, prompt },
      this.promptTimeoutMs,
      () => {
        void this.cancelPrompt(active, new AcpSubscriptionSessionError("acp-session-prompt-timeout"));
      },
    );
    active.requestId = request.id;
    void request.promise.then(
      (result) => this.completePrompt(active, result),
      (error: Error) => this.rejectPrompt(active, error),
    );

    return {
      events: this.createPromptEvents(active),
      completion,
      cancel: () => this.cancelPrompt(active, createAbortError()),
    };
  }

  async cancelActivePrompt(): Promise<void> {
    const active = this.activePrompt;
    if (!active) return;
    await this.cancelPrompt(active, createAbortError());
  }

  /** Permanently closes this client and force-kills its managed process tree. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const active = this.activePrompt;
    if (active) await this.cancelPrompt(active, new AcpSubscriptionSessionError("acp-session-stopped"));
    this.abortTransport(new AcpSubscriptionSessionError("acp-session-stopped"));
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopped) throw new AcpSubscriptionSessionError("acp-session-stopped");
    if (this.child && this.sessionId) return;
    if (!this.startPromise) {
      this.startPromise = this.startTransport().catch((error: unknown) => {
        const normalized = this.normalizeStartError(error);
        this.abortTransport(normalized);
        throw normalized;
      });
    }
    await this.startPromise;
  }

  private async startTransport(): Promise<void> {
    let executable: string;
    try {
      executable = await this.resolveExecutable(this.options.executablePath);
      await this.requireRuntimeDirectories();
    } catch (error) {
      if (error instanceof AcpSubscriptionSessionError) throw error;
      throw new AcpSubscriptionSessionError("acp-session-start-failed");
    }
    if (this.stopped) throw new AcpSubscriptionSessionError("acp-session-stopped");

    let child: ChildProcess;
    try {
      child = this.spawn(executable, this.runtimeArgs, {
        cwd: this.options.workspaceDir,
        env: sanitizedAcpSubscriptionEnvironment(
          this.options.provider,
          this.options.runtimeHome,
          process.env,
          this.platform,
          this.options.runtimeTempDir ?? join(this.options.runtimeHome, "tmp"),
        ),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
      });
    } catch {
      throw new AcpSubscriptionSessionError("acp-session-start-failed");
    }
    if (!child.stdin || !child.stdout) {
      forceKillManagedChildProcess(child, "acp subscription session missing stdio pipes");
      throw new AcpSubscriptionSessionError("acp-session-start-failed");
    }
    if (this.stopped) {
      forceKillManagedChildProcess(child, "acp subscription session stopped during startup");
      throw new AcpSubscriptionSessionError("acp-session-stopped");
    }

    this.child = child;
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    this.attachTransport(child);

    const initialize = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "lvis", version: this.clientVersion },
    });
    this.promptCapabilities = acpSubscriptionPromptCapabilitiesFromInitialize(initialize);
    this.assertAuthenticationMethod(initialize);
    try {
      await this.request("authenticate", this.manifest.authenticateParams);
    } catch (error) {
      if (error instanceof AcpRemoteRpcError && error.authenticationRequired) {
        throw new AcpSubscriptionSessionError("acp-session-authentication-required");
      }
      throw error;
    }
    const created = await this.request("session/new", buildAcpSubscriptionSessionNewParams(
      this.options.provider,
      this.options.workspaceDir,
      this.mcpServers,
    ));
    const sessionId = isRecord(created) ? boundedString(created.sessionId, MAX_SESSION_ID_LENGTH) : null;
    if (!sessionId) throw new AcpSubscriptionSessionError("acp-session-invalid-response");
    this.sessionId = sessionId;
  }

  /** Build only standard ACP blocks after runtime-owned capability negotiation. */
  private promptBlocks(
    text: string,
    attachments: readonly SubscriptionPromptAttachment[] | undefined,
  ): Record<string, unknown>[] {
    const validated = assertSubscriptionPromptAttachments(attachments, ACP_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS);
    const prompt: Record<string, unknown>[] = [{ type: "text", text }];
    for (const attachment of validated) {
      if (!this.promptCapabilities.image) {
        throw new SubscriptionAttachmentTransportError("subscription-attachment-not-supported");
      }
      prompt.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
      });
    }
    return prompt;
  }

  /**
   * ACP is JSONL. Test the exact outbound session/prompt envelope before it is
   * registered as pending or written, so no image is truncated or half-sent.
   */
  private assertPromptFitsRpcLimit(
    sessionId: string,
    prompt: readonly Record<string, unknown>[],
    hasAttachments: boolean,
  ): void {
    let serialized: string;
    try {
      serialized = JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextRequestId,
        method: "session/prompt",
        params: { sessionId, prompt },
      });
    } catch {
      throw new AcpSubscriptionSessionError("acp-session-invalid-prompt");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_RPC_LINE_BYTES) {
      if (hasAttachments) {
        throw new SubscriptionAttachmentTransportError("subscription-attachment-too-large");
      }
      throw new AcpSubscriptionSessionError("acp-session-invalid-prompt");
    }
  }

  private async requireRuntimeDirectories(): Promise<void> {
    for (const candidate of [
      this.options.runtimeHome,
      this.options.workspaceDir,
      this.options.runtimeTempDir ?? join(this.options.runtimeHome, "tmp"),
    ]) {
      if (!isAbsolute(candidate)) throw new AcpSubscriptionSessionError("acp-session-start-failed");
      try {
        const stat = await fs.lstat(resolve(candidate));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe runtime directory");
      } catch {
        throw new AcpSubscriptionSessionError("acp-session-start-failed");
      }
    }
  }

  private attachTransport(child: ChildProcess): void {
    const abort = (code: AcpSubscriptionSessionErrorCode): void => {
      this.abortTransport(new AcpSubscriptionSessionError(code), child);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (this.child === child) this.consumeStdout(chunk);
    });
    child.stdout?.once("error", () => abort("acp-session-transport-closed"));
    child.stdin?.once("error", () => abort("acp-session-transport-closed"));
    // Drain but never retain or log third-party stderr: it can contain OAuth
    // URLs, device codes, account names, and provider diagnostics.
    child.stderr?.on("data", () => undefined);
    child.stderr?.once("error", () => abort("acp-session-transport-closed"));
    child.once("error", () => abort("acp-session-transport-closed"));
    child.once("exit", () => abort("acp-session-transport-closed"));
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest(method, params, this.requestTimeoutMs).promise;
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    onTimeout?: () => void,
  ): { id: number; promise: Promise<unknown> } {
    const id = this.nextRequestId++;
    let resolveRequest: (value: unknown) => void = () => {};
    let rejectRequest: (error: Error) => void = () => {};
    const promise = new Promise<unknown>((resolvePending, rejectPending) => {
      resolveRequest = resolvePending;
      rejectRequest = rejectPending;
    });
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(new AcpSubscriptionSessionError(
        method === "session/prompt" ? "acp-session-prompt-timeout" : "acp-session-request-timeout",
      ));
      onTimeout?.();
      if (method !== "session/prompt") {
        this.abortTransport(new AcpSubscriptionSessionError("acp-session-request-timeout"));
      }
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });
    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const normalized = error instanceof AcpSubscriptionSessionError
        ? error
        : new AcpSubscriptionSessionError("acp-session-transport-closed");
      this.abortTransport(normalized);
    }
    return { id, promise };
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private replyError(id: RpcId): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Host capabilities are unavailable" },
    });
  }

  private write(payload: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin?.writable) {
      throw new AcpSubscriptionSessionError("acp-session-transport-closed");
    }
    let line: string;
    try {
      line = JSON.stringify(payload);
    } catch {
      throw new AcpSubscriptionSessionError("acp-session-operation-failed");
    }
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
      throw new AcpSubscriptionSessionError("acp-session-operation-failed");
    }
    child.stdin.write(`${line}\n`);
  }

  private consumeStdout(chunk: Buffer | string): void {
    if (!this.child) return;
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_RPC_LINE_BYTES) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
        return;
      }
      this.handleMessage(message);
      if (!this.child) return;
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    const method = boundedString(message.method, MAX_RPC_METHOD_LENGTH);
    if (method && message.id !== undefined) {
      if (!isRpcId(message.id)) {
        this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
        return;
      }
      this.handleHostRequest(message.id, method);
      return;
    }
    if (method) {
      this.handleNotification(method, message.params);
      return;
    }
    if (typeof message.id === "number" && Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const providerError = pending.method === "session/prompt"
          ? projectSubscriptionTransportErrorDiagnostics(message.error)
          : undefined;
        pending.reject(providerError
          ? new AcpSubscriptionSessionError("acp-session-operation-failed", providerError)
          : new AcpRemoteRpcError(authenticationRequired(message.error)));
      } else if (Object.prototype.hasOwnProperty.call(message, "result")) {
        pending.resolve(message.result);
      } else {
        pending.reject(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      }
      return;
    }
    this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    const root = isRecord(params) ? params : null;
    if (!root || root.sessionId !== this.sessionId) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    const update = isRecord(root.update) ? root.update : null;
    if (!update) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    const updateType = boundedString(update.sessionUpdate, MAX_RPC_METHOD_LENGTH);
    if (!updateType) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    // ACP agents report MCP progress through standard tool updates. The update
    // itself is never an execution authority: it can carry untrusted raw input
    // or output and has no portable server provenance. The sole permitted tool
    // path is the session-scoped, tokenized LVIS MCP bridge handed to
    // `session/new`; that bridge separately validates a schema and emits the
    // normal LVIS `tool_call` event. Drop every raw tool update so it cannot
    // leak into the renderer/audit stream or trigger host execution.
    if (updateType === "tool_call" || updateType === "tool_call_update") {
      return;
    }
    let eventType: "text_delta" | "reasoning_delta" | null = null;
    if (updateType === "agent_message_chunk") eventType = "text_delta";
    if (updateType === "agent_thought_chunk" || updateType === "agent_reasoning_chunk") {
      eventType = "reasoning_delta";
    }
    if (!eventType) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-native-tool-rejected"));
      return;
    }
    const content = isRecord(update.content) ? update.content : null;
    const text = content?.type === "text" ? boundedString(content.text, MAX_STREAM_CHUNK_BYTES) : null;
    if (!text) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    const active = this.activePrompt;
    // Notifications outside the active prompt can be history replay or stale
    // output. They must never leak into the current LVIS conversation.
    if (!active || active.cancelling) return;
    const accepted = active.queue.push(
      eventType === "text_delta" ? { type: "text_delta", text } : { type: "reasoning_delta", text },
    );
    if (!accepted) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-operation-failed"));
    }
  }

  private handleHostRequest(id: RpcId, method: string): void {
    const observation: AcpSubscriptionHostRequestObservation = Object.freeze({
      provider: this.options.provider,
      sessionId: this.sessionId,
      requestId: id,
      method,
      kind: hostRequestKind(method),
    });
    try {
      const observed = this.options.onHostRequest?.(observation);
      void Promise.resolve(observed).catch(() => undefined);
    } catch {
      // Observation cannot change a deny decision.
    }
    try {
      this.replyError(id);
    } catch {
      // The transport is torn down below whether or not the reply was delivered.
    }
    this.abortTransport(new AcpSubscriptionSessionError("acp-session-host-request-rejected"));
  }

  private completePrompt(active: StartedPrompt, result: unknown): void {
    if (this.activePrompt !== active) return;
    const root = isRecord(result) ? result : null;
    const stopReason = promptStopReason(root?.stopReason);
    if (!stopReason) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-invalid-response"));
      return;
    }
    if (active.cancelling || stopReason === "cancelled") {
      this.activePrompt = null;
      this.clearPromptListeners(active);
      const aborted = createAbortError();
      active.queue.fail(aborted);
      active.reject(aborted);
      return;
    }
    const terminalEvent: StreamEvent = {
      type: "message_complete",
      stopReason: stopReason === "max_tokens" ? "max_tokens" : "end_turn",
    };
    // Never finish a full queue without its required terminal event. Failing
    // closed clears partial output and retains a single unambiguous outcome.
    if (!active.queue.push(terminalEvent)) {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-operation-failed"));
      return;
    }
    this.activePrompt = null;
    this.clearPromptListeners(active);
    active.queue.finish();
    active.resolve({ stopReason });
  }

  private rejectPrompt(active: StartedPrompt, error: Error): void {
    if (this.activePrompt !== active) return;
    if (active.cancelling) return;
    this.activePrompt = null;
    this.clearPromptListeners(active);
    active.queue.fail(error);
    active.reject(error);
  }

  private async cancelPrompt(active: StartedPrompt, error: Error): Promise<void> {
    if (this.activePrompt !== active || active.cancelling) return;
    active.cancelling = true;
    active.queue.fail(error);
    active.reject(error);
    try {
      const sessionId = this.sessionId;
      if (sessionId) this.notify("session/cancel", { sessionId });
    } catch {
      this.abortTransport(new AcpSubscriptionSessionError("acp-session-transport-closed"));
      return;
    }
    active.cancelTimer = setTimeout(() => {
      if (this.activePrompt === active) this.abortTransport(error);
    }, this.abortGraceMs);
    active.cancelTimer.unref?.();
  }

  private createPromptEvents(active: StartedPrompt): AsyncIterable<StreamEvent> {
    let consumed = false;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => {
        if (consumed) {
          throw new AcpSubscriptionSessionError("acp-session-operation-failed");
        }
        consumed = true;
        const iterator = active.queue[Symbol.asyncIterator]();
        return {
          next: () => iterator.next(),
          return: async () => {
            await this.cancelPrompt(active, createAbortError());
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  private assertAuthenticationMethod(initialize: unknown): void {
    const root = isRecord(initialize) ? initialize : null;
    const methods = Array.isArray(root?.authMethods) ? root.authMethods : [];
    const requiredMethod = this.manifest.requiresAuthenticationMethod;
    if (!requiredMethod) throw new AcpSubscriptionSessionError("acp-session-authentication-required");
    const supported = methods.some((method) => {
      if (!isRecord(method)) return false;
      return method.id === requiredMethod || method.methodId === requiredMethod;
    });
    if (!supported) throw new AcpSubscriptionSessionError("acp-session-authentication-required");
  }

  private normalizeStartError(error: unknown): AcpSubscriptionSessionError {
    if (error instanceof AcpSubscriptionSessionError) return error;
    if (error instanceof AcpRemoteRpcError && error.authenticationRequired) {
      return new AcpSubscriptionSessionError("acp-session-authentication-required");
    }
    return new AcpSubscriptionSessionError("acp-session-start-failed");
  }

  private clearPromptListeners(active: StartedPrompt): void {
    if (active.cancelTimer) clearTimeout(active.cancelTimer);
    if (active.abortSignal && active.abortListener) {
      active.abortSignal.removeEventListener("abort", active.abortListener);
    }
  }

  private abortTransport(error: Error, expectedChild?: ChildProcess): void {
    const child = this.child;
    if (expectedChild && child !== expectedChild) return;
    this.child = null;
    this.sessionId = null;
    this.startPromise = null;
    this.stdoutBuffer = "";
    this.promptCapabilities = DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES;
    const active = this.activePrompt;
    this.activePrompt = null;
    if (active) {
      this.clearPromptListeners(active);
      active.queue.fail(error);
      active.reject(error);
    }
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (child) forceKillManagedChildProcess(child, "acp subscription session transport closed");
  }
}
