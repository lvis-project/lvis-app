import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getLvisAppVersion } from "../shared/app-version.js";
import { MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH } from "../shared/subscription-runtime.js";
import {
  projectSubscriptionTransportErrorDiagnostics,
  type SubscriptionTransportDiagnosticError,
} from "./subscription-transport-error-diagnostics.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import {
  assertSubscriptionPromptAttachments,
  SubscriptionAttachmentTransportError,
  subscriptionImageExtension,
  type SubscriptionPromptAttachment,
} from "./subscription-attachment-input.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "../shared/safe-integer.js";

const require = createRequire(import.meta.url);

export const CODEX_RPC_REQUEST_TIMEOUT_MS = 15_000;
export const CODEX_MAX_RPC_LINE_BYTES = 1_000_000;
const MAX_INPUT_TEXT_BYTES = 750_000;
const MAX_STREAM_DELTA_BYTES = 256_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DYNAMIC_TOOL_NAME_LENGTH = 128;
const MAX_DYNAMIC_TOOL_NAMESPACE_LENGTH = 64;
const MAX_DYNAMIC_TOOL_DESCRIPTION_LENGTH = 1_024;
const MAX_DYNAMIC_TOOL_RESULT_BYTES = 750_000;
const STAGED_IMAGE_FILE_NAME = /^lvis-subscription-image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp|bmp)$/;
// A new app process may remove only files that predate this module. Paths
// registered by live runtimes are always excluded, even during an open/write
// race in a concurrently starting session.
const STAGED_IMAGE_ORPHAN_SWEEP_STARTED_AT_MS = Date.now();
const liveStagedImagePaths = new Set<string>();

const DYNAMIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_DYNAMIC_TOOL_NAMESPACES = new Set([
  "functions",
  "multi_tool_use",
  "file_search",
  "web",
  "browser",
  "image_gen",
  "computer",
  "container",
  "terminal",
  "python",
  "python_user_visible",
  "api_tool",
  "tool_search",
  "submodel_delegator",
]);

export type CodexJsonRecord = Record<string, unknown>;
export type CodexSpawnAppServer = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;
export type CodexAppServerRequestId = string | number;

export type CodexConversationRuntimeErrorCode =
  | "codex-runtime-unavailable"
  | "codex-runtime-start-failed"
  | "codex-operation-failed";

export class CodexConversationRuntimeError extends Error {
  constructor(
    readonly code: CodexConversationRuntimeErrorCode,
    readonly providerError?: SubscriptionTransportDiagnosticError["providerError"],
  ) {
    super(code);
    this.name = "CodexConversationRuntimeError";
  }
}

/** JSON-compatible values accepted by Codex App Server dynamic tool schemas. */
export type CodexConversationJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CodexConversationJsonValue>
  | { readonly [key: string]: CodexConversationJsonValue };

/** A single LVIS-owned function exposed to Codex App Server. */
export interface CodexConversationDynamicToolFunction {
  /** Omit for structural compatibility with LVIS ToolSchema. */
  readonly type?: "function";
  readonly name: string;
  readonly description: string;
  /** Validated to JSON before it is sent to App Server. */
  readonly inputSchema: unknown;
  readonly deferLoading?: boolean;
}

/** A namespace groups LVIS-owned functions without exposing native Codex tools. */
export interface CodexConversationDynamicToolNamespace {
  readonly type: "namespace";
  readonly name: string;
  readonly description: string;
  readonly tools: ReadonlyArray<CodexConversationDynamicToolFunction>;
}

export type CodexConversationDynamicToolDefinition =
  | CodexConversationDynamicToolFunction
  | CodexConversationDynamicToolNamespace;

/** A validated dynamic tool request scoped to the active LVIS conversation turn. */
export interface CodexConversationDynamicToolCall {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly namespace: string | null;
  readonly tool: string;
  readonly arguments: CodexConversationJsonValue;
}

/**
 * The host must route this through LVIS tool governance and return only a
 * model-visible result. Native Codex command/file/permission paths are never
 * delegated through this callback.
 */
export type CodexConversationDynamicToolHandler = (
  call: CodexConversationDynamicToolCall,
) => Promise<string>;

/**
 * Every thread runs in the host-created blank workspace with network access
 * disabled. Native Codex command, file, and permission paths remain denied;
 * only explicitly declared LVIS dynamic tools can cross this boundary.
 */
export interface CodexConversationRuntimeOptions {
  /** Existing isolated Codex home owned by the main process. */
  runtimeHome: string;
  /** Existing isolated Codex SQLite directory owned by the main process. */
  sqliteHome: string;
  /** Existing blank workspace with no user project files, rules, or plugins. */
  workspaceDir: string;
  /** Optional existing isolated temporary directory; defaults to runtimeHome. */
  runtimeTempDir?: string;
  /** Test seam for the packaged Codex executable resolver. */
  resolveExecutable?: () => string;
  /** Test seam; production uses managed-child-processes. */
  spawn?: CodexSpawnAppServer;
  clientVersion?: string;
  /** Optional, LVIS-governed tools advertised once when the thread starts. */
  dynamicTools?: ReadonlyArray<CodexConversationDynamicToolDefinition>;
}

export interface CodexConversationTurnInput {
  text: string;
  /** Strict original user images to stage as App Server localImage inputs. */
  attachments?: readonly SubscriptionPromptAttachment[];
  /** Optional subscription model id. It is never treated as an API-key model. */
  model?: string | null;
  /** Per-thread LVIS ToolSchema-compatible dynamic tools. */
  dynamicTools?: ReadonlyArray<CodexConversationDynamicToolDefinition>;
  /** Cancels before this runtime may create a remote turn. */
  abortSignal?: AbortSignal;
}

type CodexConversationTurnStatus = "completed" | "interrupted" | "failed";

interface PendingTurnCompletion {
  readonly status: CodexConversationTurnStatus;
  readonly providerError?: SubscriptionTransportDiagnosticError["providerError"];
}

/** Safe, per-turn projection of Codex App Server `tokenUsage.last`. */
export interface CodexConversationTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly modelContextWindow?: number;
}

export interface CodexConversationTurnResult {
  threadId: string;
  turnId: string;
  status: CodexConversationTurnStatus;
  /** Present only for a completed turn with an exact App Server `last` snapshot. */
  tokenUsage?: CodexConversationTokenUsage;
  providerError?: SubscriptionTransportDiagnosticError["providerError"];
}

export interface CodexConversationTextDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexConversationReasoningDelta extends CodexConversationTextDelta {
  summaryIndex: number;
}

type CodexConversationServerRequestKind =
  | "command-approval"
  | "file-change-approval"
  | "permissions-approval"
  | "user-input"
  | "dynamic-tool"
  | "unsupported";

/**
 * A deliberately redacted projection of an App Server reverse RPC request.
 * It allows the host to audit that a request was rejected without exposing
 * commands, paths, tool arguments, account values, or other raw server data.
 */
export interface CodexConversationServerRequest {
  kind: CodexConversationServerRequestKind;
  method: string;
  requestId: CodexAppServerRequestId;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
}

export interface CodexConversationCallbacks {
  onTextDelta?: (event: CodexConversationTextDelta) => void;
  onReasoningDelta?: (event: CodexConversationReasoningDelta) => void;
  onTurnCompleted?: (result: CodexConversationTurnResult) => void;
  onServerRequest?: (request: CodexConversationServerRequest) => void;
  /** Executes only a known LVIS dynamic tool for the active thread and turn. */
  onDynamicToolCall?: CodexConversationDynamicToolHandler;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly callbacks: CodexConversationCallbacks;
  readonly completion: Promise<CodexConversationTurnResult>;
  readonly resolveCompletion: (result: CodexConversationTurnResult) => void;
  readonly rejectCompletion: (error: Error) => void;
  readonly turnIdReady: Promise<string>;
  readonly resolveTurnId: (turnId: string) => void;
  readonly rejectTurnId: (error: Error) => void;
  turnId: string | null;
  /** ID from the authoritative turn/start response; only it may settle this turn. */
  authoritativeTurnId: string | null;
  /** Latest exact App Server `tokenUsage.last` for this active remote turn. */
  latestTokenUsage: CodexConversationTokenUsage | undefined;
  /** Bounded start-response race buffer keyed by the provider turn id. */
  readonly pendingTokenUsageByTurnId: Map<string, CodexConversationTokenUsage>;
  /** Bounded terminal-notification buffer until turn/start proves its exact id. */
  readonly pendingCompletionByTurnId: Map<string, PendingTurnCompletion>;
  settled: boolean;
  interruptPromise: Promise<void> | null;
  /** App-owned temporary localImage files, removed on every terminal path. */
  attachmentPaths: string[];
  readonly handledDynamicToolCallIds: Set<string>;
}

interface NormalizedDynamicTools {
  readonly definitions: ReadonlyArray<CodexConversationDynamicToolDefinition>;
  readonly keys: ReadonlySet<string>;
}

const PLATFORM_TARGETS: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, {
  packageName: string;
  targetTriple: string;
  executableName: string;
}>>>> = {
  darwin: {
    x64: {
      packageName: "@openai/codex-darwin-x64",
      targetTriple: "x86_64-apple-darwin",
      executableName: "codex",
    },
    arm64: {
      packageName: "@openai/codex-darwin-arm64",
      targetTriple: "aarch64-apple-darwin",
      executableName: "codex",
    },
  },
  linux: {
    x64: {
      packageName: "@openai/codex-linux-x64",
      targetTriple: "x86_64-unknown-linux-musl",
      executableName: "codex",
    },
    arm64: {
      packageName: "@openai/codex-linux-arm64",
      targetTriple: "aarch64-unknown-linux-musl",
      executableName: "codex",
    },
  },
  win32: {
    x64: {
      packageName: "@openai/codex-win32-x64",
      targetTriple: "x86_64-pc-windows-msvc",
      executableName: "codex.exe",
    },
    arm64: {
      packageName: "@openai/codex-win32-arm64",
      targetTriple: "aarch64-pc-windows-msvc",
      executableName: "codex.exe",
    },
  },
};

const SAFE_LOCALE_ENV_NAMES = ["LANG", "LC_ALL"] as const;
const SAFE_NATIVE_STREAM_ITEM_TYPES = new Set([
  "agentMessage",
  "reasoning",
]);

/**
 * Resolve the official package's native binary directly. We deliberately do
 * not execute a PATH-resolved `codex` shim or a shell command: the runtime is
 * pinned in package.json and every argv value below is host-owned.
 *
 * `unavailable` builds the caller's domain error so each Codex transport keeps
 * its own error union while sharing one resolution path.
 */
export function resolveBundledCodexExecutable(unavailable: () => Error): string {
  const target = PLATFORM_TARGETS[process.platform]?.[process.arch];
  if (!target) throw unavailable();

  let packageJson: string;
  try {
    packageJson = require.resolve(`${target.packageName}/package.json`);
  } catch {
    throw unavailable();
  }
  const packagedPath = join(
    dirname(packageJson),
    "vendor",
    target.targetTriple,
    "bin",
    target.executableName,
  );
  const executable = preferAsarUnpackedPath(packagedPath);
  if (!existsSync(executable)) throw unavailable();
  return executable;
}

function preferAsarUnpackedPath(candidate: string): string {
  const asarSegment = `${sep}app.asar${sep}`;
  if (!candidate.includes(asarSegment)) return candidate;
  const unpacked = candidate.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : candidate;
}

export function spawnPackagedCodex(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
  label: string,
): ChildProcess {
  return spawnManaged(command, args, options, { label });
}

function blocksInheritedEnvironment(key: string): boolean {
  return !SAFE_LOCALE_ENV_NAMES.some((allowed) => allowed === key);
}

function addSafeLocaleEnvironment(env: NodeJS.ProcessEnv, environment: NodeJS.ProcessEnv): void {
  for (const key of SAFE_LOCALE_ENV_NAMES) {
    const value = environment[key];
    if (
      blocksInheritedEnvironment(key)
      || typeof value !== "string"
      || value.length > 200
      || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      continue;
    }
    env[key] = value;
  }
}

function normalizeRuntimePathForPlatform(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.normalize(path) : path;
}

function trustedWindowsSystemRoot(): string {
  const candidate = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (
    typeof candidate === "string"
    && win32.isAbsolute(candidate)
    && !/[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return win32.normalize(candidate);
  }
  return "C:\\Windows";
}

/**
 * Construct the complete child environment from a fixed allowlist. No parent
 * PATH, proxy, credential, loader, Node, or Codex/OpenAI configuration leaks
 * into the subscription runtime.
 */
export function sanitizedCodexConversationEnvironment(
  runtimeHome: string,
  sqliteHome: string,
  runtimeTempDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const home = normalizeRuntimePathForPlatform(runtimeHome, platform);
  const sqlite = normalizeRuntimePathForPlatform(sqliteHome, platform);
  const temp = normalizeRuntimePathForPlatform(runtimeTempDir, platform);
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: sqlite,
    HOME: home,
    TMPDIR: temp,
    RUST_LOG: "error",
  };
  addSafeLocaleEnvironment(env, environment);

  if (platform === "win32") {
    const systemRoot = trustedWindowsSystemRoot();
    const homeRoot = win32.parse(home).root;
    const homeDrive = homeRoot.endsWith("\\") ? homeRoot.slice(0, -1) : homeRoot;
    const homePath = home.startsWith(homeDrive) ? home.slice(homeDrive.length) : "\\";
    return {
      ...env,
      SYSTEMROOT: systemRoot,
      WINDIR: systemRoot,
      SYSTEMDRIVE: win32.parse(systemRoot).root.slice(0, -1),
      COMSPEC: win32.join(systemRoot, "System32", "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: `${win32.join(systemRoot, "System32")};${systemRoot}`,
      USERPROFILE: home,
      HOMEDRIVE: homeDrive,
      HOMEPATH: homePath,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    };
  }

  return {
    ...env,
    PATH: platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin",
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_DATA_HOME: home,
  };
}

/**
 * Reject anything that is not an existing, absolute, non-symlink directory.
 * `invalid` builds the caller's domain error; the rejection rules are shared so
 * both Codex transports admit exactly the same set of runtime directories.
 */
export function validateCodexRuntimeDirectory(candidate: string, invalid: () => Error): string {
  const trimmed = candidate.trim();
  if (!trimmed || !isAbsolute(trimmed)) throw invalid();
  const directory = resolve(trimmed);
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe runtime directory");
  } catch {
    throw invalid();
  }
  return directory;
}

function validateRuntimeDirectory(candidate: string): string {
  return validateCodexRuntimeDirectory(
    candidate,
    () => new CodexConversationRuntimeError("codex-runtime-start-failed"),
  );
}

export function isCodexJsonRecord(value: unknown): value is CodexJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedIdentifier(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function boundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (!abortSignal?.aborted) return;
  const error = new Error("codex-conversation-aborted");
  error.name = "AbortError";
  throw error;
}

function boundedDynamicToolResult(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Buffer.byteLength(value, "utf8") <= MAX_DYNAMIC_TOOL_RESULT_BYTES ? value : null;
}

function boundedDynamicToolName(value: unknown, maxLength: number): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || !DYNAMIC_TOOL_NAME_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function boundedDynamicToolDescription(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length > MAX_DYNAMIC_TOOL_DESCRIPTION_LENGTH
    || value.includes("\u0000")
  ) {
    return null;
  }
  return value;
}

function projectJsonValue(value: unknown, depth = 0): CodexConversationJsonValue | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 64) return null;
  if (Array.isArray(value)) {
    const projected: CodexConversationJsonValue[] = [];
    for (const item of value) {
      const result = projectJsonValue(item, depth + 1);
      if (result === null && item !== null) return null;
      projected.push(result);
    }
    return projected;
  }
  if (!isCodexJsonRecord(value)) return null;
  const projected: Record<string, CodexConversationJsonValue> = Object.create(null) as Record<string, CodexConversationJsonValue>;
  for (const [key, item] of Object.entries(value)) {
    const result = projectJsonValue(item, depth + 1);
    if (result === null && item !== null) return null;
    projected[key] = result;
  }
  return projected;
}

function dynamicToolKey(namespace: string | null, tool: string): string {
  return `${namespace ?? ""}\u0000${tool}`;
}

function normalizeDynamicToolFunction(
  candidate: unknown,
  allowsDeferredLoading: boolean,
): CodexConversationDynamicToolFunction | null {
  if (!isCodexJsonRecord(candidate) || (candidate.type !== undefined && candidate.type !== "function")) return null;
  const name = boundedDynamicToolName(candidate.name, MAX_DYNAMIC_TOOL_NAME_LENGTH);
  const description = boundedDynamicToolDescription(candidate.description);
  const inputSchema = projectJsonValue(candidate.inputSchema);
  const deferLoading = candidate.deferLoading;
  if (
    !name
    || description === null
    || inputSchema === null
    || (deferLoading !== undefined && typeof deferLoading !== "boolean")
    || (deferLoading === true && !allowsDeferredLoading)
  ) {
    return null;
  }
  return {
    type: "function",
    name,
    description,
    inputSchema,
    ...(deferLoading === undefined ? {} : { deferLoading }),
  };
}

function normalizeDynamicTools(candidate: unknown): NormalizedDynamicTools {
  if (candidate === undefined) return { definitions: [], keys: new Set<string>() };
  if (!Array.isArray(candidate)) throw new CodexConversationRuntimeError("codex-operation-failed");

  const definitions: CodexConversationDynamicToolDefinition[] = [];
  const keys = new Set<string>();
  const namespaces = new Set<string>();
  for (const definition of candidate) {
    if (!isCodexJsonRecord(definition)) throw new CodexConversationRuntimeError("codex-operation-failed");
    if (definition.type === undefined || definition.type === "function") {
      const functionDefinition = normalizeDynamicToolFunction(definition, false);
      const key = functionDefinition && dynamicToolKey(null, functionDefinition.name);
      if (!functionDefinition || !key || keys.has(key)) {
        throw new CodexConversationRuntimeError("codex-operation-failed");
      }
      keys.add(key);
      definitions.push(functionDefinition);
      continue;
    }
    if (definition.type !== "namespace") {
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }
    const namespace = boundedDynamicToolName(definition.name, MAX_DYNAMIC_TOOL_NAMESPACE_LENGTH);
    const description = boundedDynamicToolDescription(definition.description);
    if (
      !namespace
      || description === null
      || RESERVED_DYNAMIC_TOOL_NAMESPACES.has(namespace)
      || namespaces.has(namespace)
      || !Array.isArray(definition.tools)
      || definition.tools.length === 0
    ) {
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }
    const tools: CodexConversationDynamicToolFunction[] = [];
    for (const tool of definition.tools) {
      const functionDefinition = normalizeDynamicToolFunction(tool, true);
      const key = functionDefinition && dynamicToolKey(namespace, functionDefinition.name);
      if (!functionDefinition || !key || keys.has(key)) {
        throw new CodexConversationRuntimeError("codex-operation-failed");
      }
      keys.add(key);
      tools.push(functionDefinition);
    }
    namespaces.add(namespace);
    definitions.push({ type: "namespace", name: namespace, description, tools });
  }
  return { definitions, keys };
}

function sameDynamicTools(left: NormalizedDynamicTools, right: NormalizedDynamicTools): boolean {
  return JSON.stringify(left.definitions) === JSON.stringify(right.definitions);
}

export function isCodexAppServerRequestId(value: unknown): value is CodexAppServerRequestId {
  return (typeof value === "number" && Number.isInteger(value))
    || (typeof value === "string" && value.length <= MAX_IDENTIFIER_LENGTH && !/[\u0000-\u001f\u007f]/.test(value));
}

function projectTurnStatus(value: unknown): CodexConversationTurnStatus {
  if (value === "completed" || value === "interrupted" || value === "failed") return value;
  return "failed";
}

/**
 * Project only `tokenUsage.last`: App Server's `total` is thread-cumulative
 * and must never become a per-turn audit or renderer value.
 */
function projectTurnTokenUsage(
  payload: CodexJsonRecord,
): { threadId: string; turnId: string; tokenUsage: CodexConversationTokenUsage } | null {
  const threadId = boundedIdentifier(payload.threadId);
  const turnId = boundedIdentifier(payload.turnId);
  const usage = isCodexJsonRecord(payload.tokenUsage) ? payload.tokenUsage : null;
  if (!usage) return null;
  const last = isCodexJsonRecord(usage.last) ? usage.last : null;
  if (
    !threadId
    || !turnId
    || !last
    || !isNonNegativeSafeInteger(last.inputTokens)
    || !isNonNegativeSafeInteger(last.outputTokens)
    || !isNonNegativeSafeInteger(last.totalTokens)
    || (last.cachedInputTokens !== undefined && !isNonNegativeSafeInteger(last.cachedInputTokens))
    || (last.cacheWriteInputTokens !== undefined && !isNonNegativeSafeInteger(last.cacheWriteInputTokens))
    || (last.reasoningOutputTokens !== undefined && !isNonNegativeSafeInteger(last.reasoningOutputTokens))
    || (usage.modelContextWindow !== undefined && !isPositiveSafeInteger(usage.modelContextWindow))
  ) {
    return null;
  }
  return {
    threadId,
    turnId,
    tokenUsage: {
      inputTokens: last.inputTokens,
      outputTokens: last.outputTokens,
      totalTokens: last.totalTokens,
      ...(last.cachedInputTokens !== undefined ? { cachedInputTokens: last.cachedInputTokens } : {}),
      ...(last.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: last.cacheWriteInputTokens }
        : {}),
      ...(last.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: last.reasoningOutputTokens }
        : {}),
      ...(usage.modelContextWindow !== undefined ? { modelContextWindow: usage.modelContextWindow } : {}),
    },
  };
}

/**
 * A reusable App Server conversation transport for subscription-backed Codex
 * chat. It intentionally exposes only LVIS-governed dynamic tools, never
 * project-native tools, approval grants, raw reverse-RPC payloads, or arbitrary
 * App Server methods.
 */
export class CodexConversationRuntime {
  private readonly resolveExecutable: () => string;
  private readonly spawn: CodexSpawnAppServer;
  private readonly clientVersion: string;
  private readonly runtimeHome: string;
  private readonly sqliteHome: string;
  private readonly workspaceDir: string;
  private readonly runtimeTempDir: string | null;
  private readonly defaultDynamicTools: NormalizedDynamicTools;
  private threadDynamicTools: NormalizedDynamicTools | null = null;
  private pendingThreadDynamicTools: NormalizedDynamicTools | null = null;
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private threadStartPromise: Promise<string> | null = null;
  private threadId: string | null = null;
  private activeTurn: ActiveTurn | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";

  constructor(options: CodexConversationRuntimeOptions) {
    this.resolveExecutable = options.resolveExecutable
      ?? (() => resolveBundledCodexExecutable(
        () => new CodexConversationRuntimeError("codex-runtime-unavailable"),
      ));
    this.spawn = options.spawn
      ?? ((command, args, options_) => spawnPackagedCodex(command, args, options_, "codex-conversation-runtime"));
    this.clientVersion = options.clientVersion ?? getLvisAppVersion();
    this.runtimeHome = options.runtimeHome;
    this.sqliteHome = options.sqliteHome;
    this.workspaceDir = options.workspaceDir;
    this.runtimeTempDir = options.runtimeTempDir ?? null;
    this.defaultDynamicTools = normalizeDynamicTools(options.dynamicTools);
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  isTurnActive(): boolean {
    return this.activeTurn !== null;
  }

  /**
   * Proves that the isolated App Server can initialize under this runtime's
   * fail-closed policy and sees a ChatGPT subscription account, without
   * creating a billable thread or turn. The live transport is retained so a
   * later startTurn can reuse the verified child.
   */
  async verifyIsolation(): Promise<void> {
    await this.ensureStarted();
    try {
      const result = await this.request("account/read", { refreshToken: false });
      const account = isCodexJsonRecord(result) && isCodexJsonRecord(result.account) ? result.account : null;
      if (account?.type !== "chatgpt") {
        throw new CodexConversationRuntimeError("codex-operation-failed");
      }
    } catch (error) {
      const normalized = this.asRuntimeError(error);
      this.abortTransport(normalized);
      throw normalized;
    }
  }

  async startTurn(
    input: CodexConversationTurnInput,
    callbacks: CodexConversationCallbacks = {},
  ): Promise<CodexConversationTurnResult> {
    throwIfAborted(input.abortSignal);
    const text = boundedText(input.text, MAX_INPUT_TEXT_BYTES);
    const requestedModel = input.model === undefined || input.model === null
      ? undefined
      : boundedIdentifier(input.model, MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH);
    if (!text || (input.model !== undefined && input.model !== null && !requestedModel)) {
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }
    const model = requestedModel ?? undefined;
    if (this.activeTurn) throw new CodexConversationRuntimeError("codex-operation-failed");
    const attachments = assertSubscriptionPromptAttachments(input.attachments);
    const dynamicTools = this.resolveTurnDynamicTools(input.dynamicTools);
    if (dynamicTools.definitions.length > 0 && !callbacks.onDynamicToolCall) {
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }

    await this.ensureStarted();
    throwIfAborted(input.abortSignal);
    const threadId = await this.ensureThread(model, dynamicTools);
    throwIfAborted(input.abortSignal);
    if (this.activeTurn) throw new CodexConversationRuntimeError("codex-operation-failed");

    const workspaceDir = this.currentWorkspaceDir();
    const active = this.createActiveTurn(threadId, callbacks);
    this.activeTurn = active;
    try {
      await this.stageInputImages(active, attachments);
      this.throwIfStagingTurnSettled(active);
      throwIfAborted(input.abortSignal);
      const promptInput = [
        { type: "text", text },
        ...active.attachmentPaths.map((path) => ({ type: "localImage", path })),
      ];
      const result = await this.request("turn/start", {
        threadId,
        input: promptInput,
        ...(model ? { model } : {}),
        cwd: workspaceDir,
        approvalPolicy: "untrusted",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspaceDir],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      const turnId = this.projectTurnId(result);
      if (!turnId) throw new CodexConversationRuntimeError("codex-operation-failed");
      this.setAuthoritativeTurnId(active, turnId);
    } catch (error) {
      const normalized = error instanceof SubscriptionAttachmentTransportError
        ? error
        : this.asRuntimeError(error);
      if (!active.settled) this.rejectActiveTurn(active, normalized);
      throw normalized;
    }
    return active.completion;
  }

  /** Requests normal protocol cancellation; completion remains signaled by turn/completed. */
  async interrupt(): Promise<void> {
    const active = this.activeTurn;
    if (!active || active.settled) return;
    if (!active.interruptPromise) {
      active.interruptPromise = this.interruptActiveTurn(active);
    }
    await active.interruptPromise;
  }

  /** Safely closes the isolated transport and force-kills its managed child if needed. */
  stop(): void {
    this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"));
  }

  async shutdown(): Promise<void> {
    this.stop();
  }

  private createActiveTurn(threadId: string, callbacks: CodexConversationCallbacks): ActiveTurn {
    let resolveCompletion: (result: CodexConversationTurnResult) => void = () => {};
    let rejectCompletion: (error: Error) => void = () => {};
    const completion = new Promise<CodexConversationTurnResult>((resolveTurn, rejectTurn) => {
      resolveCompletion = resolveTurn;
      rejectCompletion = rejectTurn;
    });
    let resolveTurnId: (turnId: string) => void = () => {};
    // A transport can close while turn/start is still awaiting its RPC reply.
    // Keep that intermediate completion promise observed until startTurn can
    // propagate the same error through its public return value.
    void completion.catch(() => undefined);
    let rejectTurnId: (error: Error) => void = () => {};
    const turnIdReady = new Promise<string>((resolve, reject) => {
      resolveTurnId = resolve;
      rejectTurnId = reject;
    });
    // startTurn normally resolves this promise before any caller needs it. The
    // catch prevents a transport-start race from becoming an unhandled rejection.
    void turnIdReady.catch(() => undefined);
    return {
      threadId,
      callbacks,
      completion,
      resolveCompletion,
      rejectCompletion,
      turnIdReady,
      resolveTurnId,
      rejectTurnId,
      turnId: null,
      authoritativeTurnId: null,
      latestTokenUsage: undefined,
      pendingTokenUsageByTurnId: new Map<string, CodexConversationTokenUsage>(),
      pendingCompletionByTurnId: new Map<string, PendingTurnCompletion>(),
      settled: false,
      interruptPromise: null,
      attachmentPaths: [],
      handledDynamicToolCallIds: new Set<string>(),
    };
  }

  /**
   * Codex App Server accepts localImage paths. Stage bytes only in the
   * app-owned isolated temporary directory, avoiding base64 expansion in the
   * JSONL turn/start frame. Names contain no user-derived path component.
   */
  private async stageInputImages(
    active: ActiveTurn,
    attachments: readonly SubscriptionPromptAttachment[],
  ): Promise<void> {
    if (attachments.length === 0) return;
    const directory = validateRuntimeDirectory(this.runtimeTempDir ?? this.runtimeHome);
    await this.discardOrphanedStagedImages(directory);
    this.throwIfStagingTurnSettled(active);
    try {
      for (const attachment of attachments) {
        const extension = subscriptionImageExtension(attachment.mimeType);
        if (!extension) throw new SubscriptionAttachmentTransportError("subscription-attachment-not-supported");
        const path = join(directory, "lvis-subscription-image-" + randomUUID() + "." + extension);
        const bytes = Buffer.from(attachment.data, "base64");
        let handle: fs.FileHandle | undefined;
        try {
          handle = await this.openStagedImage(active, path);
          this.throwIfStagingTurnSettled(active);
          await handle.writeFile(bytes);
        } finally {
          await handle?.close();
        }
        // If stop/child-exit raced fs.open, writeFile, or close, the terminal
        // path may already have attempted deletion before this handle existed.
        // Throwing here reaches the retry below only after the handle is closed.
        this.throwIfStagingTurnSettled(active);
      }
    } catch (error) {
      await this.discardStagedImages(active.attachmentPaths);
      if (error instanceof SubscriptionAttachmentTransportError) throw error;
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }
  }

  /**
   * Register before waiting for fs.open so a concurrent orphan sweep never
   * observes a newly-created file as abandoned. Append to the active turn
   * immediately after open resolves; no event can interleave those statements.
   */
  private async openStagedImage(active: ActiveTurn, path: string): Promise<fs.FileHandle> {
    liveStagedImagePaths.add(path);
    try {
      const handle = await fs.open(path, "wx", 0o600);
      active.attachmentPaths.push(path);
      return handle;
    } catch (error) {
      liveStagedImagePaths.delete(path);
      throw error;
    }
  }

  private throwIfStagingTurnSettled(active: ActiveTurn): void {
    if (active.settled || this.activeTurn !== active) {
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }
  }

  /**
   * An abrupt process death can leave image bytes in the persistent isolated
   * temp directory. Sweep only our exact UUID filename pattern, never recurse,
   * skip every live reservation, and refuse symlinks or files from this process.
   */
  private async discardOrphanedStagedImages(directory: string): Promise<void> {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !STAGED_IMAGE_FILE_NAME.test(entry.name)) return;
        const path = join(directory, entry.name);
        if (liveStagedImagePaths.has(path)) return;
        try {
          const details = await fs.lstat(path);
          if (
            !details.isFile()
            || details.mtimeMs >= STAGED_IMAGE_ORPHAN_SWEEP_STARTED_AT_MS
            || liveStagedImagePaths.has(path)
          ) {
            return;
          }
          await fs.rm(path, { force: true, maxRetries: 1 });
        } catch {
          // A concurrent cleanup, rename, or permission change must not alter a turn.
        }
      }));
    } catch {
      // An unavailable isolated temp directory must not change turn semantics.
    }
  }

  private async discardStagedImages(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map(async (path) => {
      try {
        await fs.rm(path, { force: true, maxRetries: 1 });
        liveStagedImagePaths.delete(path);
      } catch {
        // The directory is app-owned and files are random, but a cleanup race
        // must never change turn completion or expose a path to the renderer.
      }
    }));
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        const normalized = this.asRuntimeError(error, "codex-runtime-start-failed");
        this.startPromise = null;
        this.closeTransport(normalized);
        throw normalized;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    let executable: string;
    try {
      executable = this.resolveExecutable();
    } catch (error) {
      if (error instanceof CodexConversationRuntimeError) throw error;
      throw new CodexConversationRuntimeError("codex-runtime-unavailable");
    }

    const runtimeHome = validateRuntimeDirectory(this.runtimeHome);
    const sqliteHome = validateRuntimeDirectory(this.sqliteHome);
    const workspaceDir = validateRuntimeDirectory(this.workspaceDir);
    const runtimeTempDir = this.runtimeTempDir
      ? validateRuntimeDirectory(this.runtimeTempDir)
      : runtimeHome;
    let child: ChildProcess;
    try {
      child = this.spawn(
        executable,
        [
          "app-server",
          "-c",
          'cli_auth_credentials_store="keyring"',
          "--strict-config",
          "--disable",
          "plugins",
          "--disable",
          "remote_control",
          "--disable",
          "remote_plugin",
          "--disable",
          "hooks",
          "--listen",
          "stdio://",
        ],
        {
          cwd: workspaceDir,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          env: sanitizedCodexConversationEnvironment(runtimeHome, sqliteHome, runtimeTempDir),
        },
      );
    } catch {
      throw new CodexConversationRuntimeError("codex-runtime-start-failed");
    }
    if (!child.stdin || !child.stdout) {
      forceKillManagedChildProcess(child, "codex conversation missing transport streams");
      throw new CodexConversationRuntimeError("codex-runtime-start-failed");
    }

    this.child = child;
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    const abort = (code: CodexConversationRuntimeErrorCode): void => {
      this.abortTransport(new CodexConversationRuntimeError(code), child);
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (this.child === child) this.consumeStdout(chunk, child);
    });
    child.stdout.once("error", () => abort("codex-operation-failed"));
    child.stdin.once("error", () => abort("codex-operation-failed"));
    // Never log App Server stderr: auth and account context can be present there.
    child.stderr?.on("data", () => {});
    child.stderr?.once("error", () => abort("codex-operation-failed"));
    child.once("error", () => abort("codex-runtime-start-failed"));
    child.once("exit", () => abort("codex-operation-failed"));

    try {
      const initialized = this.request("initialize", {
        clientInfo: {
          name: "lvis",
          title: "LVIS",
          version: this.clientVersion,
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.notify("initialized", {});
      await initialized;
      if (process.platform === "win32") {
        const readiness = await this.request("windowsSandbox/readiness");
        if (!isCodexJsonRecord(readiness) || readiness.status !== "ready") {
          throw new CodexConversationRuntimeError("codex-runtime-start-failed");
        }
      }
    } catch {
      const error = new CodexConversationRuntimeError("codex-runtime-start-failed");
      this.abortTransport(error, child);
      throw error;
    }
  }

  private resolveTurnDynamicTools(
    dynamicTools: CodexConversationTurnInput["dynamicTools"],
  ): NormalizedDynamicTools {
    if (dynamicTools === undefined) return this.threadDynamicTools ?? this.defaultDynamicTools;
    return normalizeDynamicTools(dynamicTools);
  }

  private async ensureThread(
    model: string | undefined,
    dynamicTools: NormalizedDynamicTools,
  ): Promise<string> {
    if (this.threadId) {
      if (!this.threadDynamicTools || !sameDynamicTools(this.threadDynamicTools, dynamicTools)) {
        throw new CodexConversationRuntimeError("codex-operation-failed");
      }
      return this.threadId;
    }
    if (!this.threadStartPromise) {
      this.pendingThreadDynamicTools = dynamicTools;
      this.threadStartPromise = this.request("thread/start", {
        ...(model ? { model } : {}),
        ...(dynamicTools.definitions.length > 0 ? { dynamicTools: dynamicTools.definitions } : {}),
        cwd: this.currentWorkspaceDir(),
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        ephemeral: true,
      }).then((result) => {
        const root = isCodexJsonRecord(result) ? result : null;
        const thread = root && isCodexJsonRecord(root.thread) ? root.thread : null;
        const threadId = boundedIdentifier(thread?.id);
        if (!threadId) throw new CodexConversationRuntimeError("codex-operation-failed");
        this.threadId = threadId;
        this.threadDynamicTools = dynamicTools;
        return threadId;
      }).finally(() => {
        this.threadStartPromise = null;
        this.pendingThreadDynamicTools = null;
      });
    } else if (
      !this.pendingThreadDynamicTools
      || !sameDynamicTools(this.pendingThreadDynamicTools, dynamicTools)
    ) {
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }
    return this.threadStartPromise;
  }

  private currentWorkspaceDir(): string {
    return validateRuntimeDirectory(this.workspaceDir);
  }

  private projectTurnId(result: unknown): string | null {
    const root = isCodexJsonRecord(result) ? result : null;
    const turn = root && isCodexJsonRecord(root.turn) ? root.turn : null;
    return boundedIdentifier(turn?.id);
  }

  private setActiveTurnId(active: ActiveTurn, turnId: string): void {
    if (active.authoritativeTurnId !== null && active.authoritativeTurnId !== turnId) return;
    if (active.turnId === turnId) return;
    // Notification IDs remain provisional until the matching turn/start RPC
    // reply arrives; they must not unlock cancellation or usage attribution.
    active.turnId = turnId;
  }

  private setAuthoritativeTurnId(active: ActiveTurn, turnId: string): void {
    if (active.authoritativeTurnId && active.authoritativeTurnId !== turnId) {
      throw new CodexConversationRuntimeError("codex-operation-failed");
    }
    active.authoritativeTurnId = turnId;
    active.turnId = turnId;
    // Consume only the exact pre-response `last` snapshot. Any provisional or
    // historic notification is discarded once the RPC proves this turn ID.
    active.latestTokenUsage = active.pendingTokenUsageByTurnId.get(turnId);
    active.pendingTokenUsageByTurnId.clear();
    active.resolveTurnId(turnId);

    const completion = active.pendingCompletionByTurnId.get(turnId);
    active.pendingCompletionByTurnId.clear();
    if (completion) {
      this.resolveTurnCompletion(active, turnId, completion.status, completion.providerError);
    }
  }

  private async interruptActiveTurn(active: ActiveTurn): Promise<void> {
    let turnId: string;
    try {
      turnId = active.authoritativeTurnId ?? await active.turnIdReady;
    } catch {
      return;
    }
    if (active.settled || this.activeTurn !== active) return;
    await this.request("turn/interrupt", { threadId: active.threadId, turnId });
  }

  private request(method: string, params?: CodexJsonRecord): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) {
      return Promise.reject(new CodexConversationRuntimeError("codex-operation-failed"));
    }
    const id = this.nextRequestId++;
    const payload = { id, method, ...(params === undefined ? {} : { params }) };
    if (!this.isWithinRpcLimit(payload)) {
      return Promise.reject(new CodexConversationRuntimeError("codex-operation-failed"));
    }
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (!this.pendingRequests.has(id)) return;
        this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"), child);
      }, CODEX_RPC_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pendingRequests.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });
      this.writeMessage(payload, child);
    });
  }

  private notify(method: string, params?: CodexJsonRecord): void {
    const child = this.child;
    if (!child) return;
    this.writeMessage({ method, ...(params === undefined ? {} : { params }) }, child);
  }

  private writeMessage(message: CodexJsonRecord, child: ChildProcess): void {
    if (this.child !== child || !child.stdin || !child.stdin.writable || !this.isWithinRpcLimit(message)) {
      if (this.child === child) {
        this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"), child);
      }
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"), child);
    }
  }

  private isWithinRpcLimit(message: CodexJsonRecord): boolean {
    try {
      return Buffer.byteLength(JSON.stringify(message), "utf8") <= CODEX_MAX_RPC_LINE_BYTES;
    } catch {
      return false;
    }
  }

  private consumeStdout(chunk: Buffer | string, child: ChildProcess): void {
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.stdoutBuffer += text;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > CODEX_MAX_RPC_LINE_BYTES) {
      this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"), child);
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
        message = JSON.parse(line);
      } catch {
        this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"), child);
        return;
      }
      this.handleMessage(message, child);
    }
  }

  private handleMessage(message: unknown, child: ChildProcess): void {
    if (!isCodexJsonRecord(message)) {
      this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"), child);
      return;
    }
    if (isCodexAppServerRequestId(message.id) && typeof message.method === "string") {
      this.handleServerRequest(message.id, message.method, message.params, child);
      return;
    }
    if (typeof message.id === "number" && Number.isInteger(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new CodexConversationRuntimeError(
          "codex-operation-failed",
          pending.method === "turn/start" ? projectSubscriptionTransportErrorDiagnostics(message.error) : undefined,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") this.handleNotification(message.method, message.params);
  }

  private handleServerRequest(
    id: CodexAppServerRequestId,
    method: string,
    params: unknown,
    child: ChildProcess,
  ): void {
    const request = this.projectServerRequest(id, method, params);
    this.invokeCallback(this.activeTurn?.callbacks.onServerRequest, request);

    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      this.writeMessage({ id, result: { decision: "decline" } }, child);
      return;
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      this.writeMessage({ id, result: { decision: "decline" } }, child);
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.writeMessage({ id, result: { permissions: [], scope: "turn" } }, child);
      return;
    }
    if (method === "item/tool/call") {
      void this.handleDynamicToolCall(id, params, child);
      return;
    }
    // User-input, auth-refresh, attestation, and any future reverse RPC remain
    // unsupported unless a separately governed bridge is explicitly added.
    this.writeMessage({
      id,
      error: { code: -32601, message: "Unsupported request" },
    }, child);
  }

  private async handleDynamicToolCall(
    id: CodexAppServerRequestId,
    params: unknown,
    child: ChildProcess,
  ): Promise<void> {
    const call = this.projectDynamicToolCall(params);
    const active = this.activeTurn;
    if (
      !call
      || !active
      || active.settled
      || this.activeTurn !== active
      || this.child !== child
      || active.threadId !== call.threadId
    ) {
      this.writeServerRequestError(id, -32602, "Invalid dynamic tool request", child);
      return;
    }
    // The response may be queued behind this reverse RPC on the same event
    // turn. Wait for it, then revalidate the exact ID before executing LVIS.
    if (active.authoritativeTurnId === null) {
      try {
        await active.turnIdReady;
      } catch {
        this.writeServerRequestError(id, -32602, "Invalid dynamic tool request", child);
        return;
      }
    }
    if (!this.isActiveDynamicToolCall(active, call, child)) {
      this.writeServerRequestError(id, -32602, "Invalid dynamic tool request", child);
      return;
    }
    if (!this.threadDynamicTools?.keys.has(dynamicToolKey(call.namespace, call.tool))) {
      this.writeServerRequestError(id, -32601, "Unsupported request", child);
      return;
    }
    const handler = active.callbacks.onDynamicToolCall;
    if (!handler || active.handledDynamicToolCallIds.has(call.callId)) {
      this.writeServerRequestError(id, -32601, "Unsupported request", child);
      return;
    }

    active.handledDynamicToolCallIds.add(call.callId);
    this.setActiveTurnId(active, call.turnId);
    let resultText: string;
    let success = true;
    try {
      resultText = await handler(call);
    } catch {
      resultText = "The LVIS tool could not complete.";
      success = false;
    }
    const text = boundedDynamicToolResult(resultText);
    if (text === null) {
      resultText = "The LVIS tool returned an invalid result.";
      success = false;
    }
    if (!this.isActiveDynamicToolCall(active, call, child)) return;
    this.writeMessage({
      id,
      result: {
        contentItems: [{ type: "inputText", text: resultText }],
        success,
      },
    }, child);
  }

  private projectDynamicToolCall(params: unknown): CodexConversationDynamicToolCall | null {
    const payload = isCodexJsonRecord(params) ? params : null;
    if (!payload || payload.namespace === undefined) return null;
    const threadId = boundedIdentifier(payload.threadId);
    const turnId = boundedIdentifier(payload.turnId);
    const callId = boundedIdentifier(payload.callId);
    const namespace = payload.namespace === null
      ? null
      : boundedDynamicToolName(payload.namespace, MAX_DYNAMIC_TOOL_NAMESPACE_LENGTH);
    const tool = boundedDynamicToolName(payload.tool, MAX_DYNAMIC_TOOL_NAME_LENGTH);
    const argumentsValue = projectJsonValue(payload.arguments);
    if (
      !threadId
      || !turnId
      || !callId
      || !tool
      || (payload.namespace !== null && !namespace)
      || (argumentsValue === null && payload.arguments !== null)
    ) {
      return null;
    }
    return {
      threadId,
      turnId,
      callId,
      namespace,
      tool,
      arguments: argumentsValue,
    };
  }

  private isActiveDynamicToolCall(
    active: ActiveTurn | null,
    call: CodexConversationDynamicToolCall,
    child: ChildProcess,
  ): active is ActiveTurn {
    return this.child === child
      && active !== null
      && !active.settled
      && this.activeTurn === active
      && active.threadId === call.threadId
      // Only the turn/start response proves that a reverse RPC belongs to
      // this turn. A resumed thread can replay a same-thread dynamic call
      // before that response, and it must never reach the LVIS tool bridge.
      && active.authoritativeTurnId === call.turnId;
  }

  private writeServerRequestError(
    id: CodexAppServerRequestId,
    code: -32601 | -32602,
    message: string,
    child: ChildProcess,
  ): void {
    this.writeMessage({ id, error: { code, message } }, child);
  }

  private projectServerRequest(
    requestId: CodexAppServerRequestId,
    method: string,
    params: unknown,
  ): CodexConversationServerRequest {
    const payload = isCodexJsonRecord(params) ? params : null;
    const kind: CodexConversationServerRequestKind = method === "item/commandExecution/requestApproval"
      || method === "execCommandApproval"
      ? "command-approval"
      : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
        ? "file-change-approval"
        : method === "item/permissions/requestApproval"
          ? "permissions-approval"
          : method === "item/tool/requestUserInput"
            ? "user-input"
            : method === "item/tool/call"
              ? "dynamic-tool"
              : "unsupported";
    return {
      kind,
      method,
      requestId,
      threadId: boundedIdentifier(payload?.threadId),
      turnId: boundedIdentifier(payload?.turnId),
      itemId: boundedIdentifier(payload?.itemId),
    };
  }

  private handleNotification(method: string, params: unknown): void {
    const payload = isCodexJsonRecord(params) ? params : null;
    if (!payload) return;
    if (method === "item/started") {
      this.rejectUnsafeNativeItemStart(payload);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const event = this.projectTextDelta(payload);
      if (event) this.invokeCallback(this.activeTurn?.callbacks.onTextDelta, event);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const event = this.projectReasoningDelta(payload);
      if (event) this.invokeCallback(this.activeTurn?.callbacks.onReasoningDelta, event);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.recordTokenUsageNotification(payload);
      return;
    }
    if (method === "turn/completed") this.completeTurnFromNotification(payload);
  }

  private rejectUnsafeNativeItemStart(payload: CodexJsonRecord): void {
    const item = isCodexJsonRecord(payload.item) ? payload.item : null;
    const itemType = boundedIdentifier(item?.type, 80);
    if (itemType && SAFE_NATIVE_STREAM_ITEM_TYPES.has(itemType)) return;
    if (itemType === "dynamicToolCall" && item && this.acceptsKnownDynamicToolItemStart(payload, item)) {
      return;
    }

    const active = this.activeTurn;
    const threadId = boundedIdentifier(payload.threadId);
    const turnId = boundedIdentifier(payload.turnId);
    if (!active || !threadId || !turnId || active.threadId !== threadId) return;
    if (active.turnId && active.turnId !== turnId) return;

    this.setActiveTurnId(active, turnId);
    this.sendBestEffortInterrupt(active, turnId);
    this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"));
  }

  private acceptsKnownDynamicToolItemStart(payload: CodexJsonRecord, item: CodexJsonRecord): boolean {
    const active = this.activeTurn;
    const threadId = boundedIdentifier(payload.threadId);
    const turnId = boundedIdentifier(payload.turnId);
    const namespace = item.namespace === undefined || item.namespace === null
      ? null
      : boundedDynamicToolName(item.namespace, MAX_DYNAMIC_TOOL_NAMESPACE_LENGTH);
    const tool = boundedDynamicToolName(item.tool, MAX_DYNAMIC_TOOL_NAME_LENGTH);
    if (
      !active
      || !threadId
      || !turnId
      || !tool
      || (item.namespace !== undefined && item.namespace !== null && !namespace)
      || active.threadId !== threadId
      || (active.authoritativeTurnId !== null && active.authoritativeTurnId !== turnId)
      || !this.threadDynamicTools?.keys.has(dynamicToolKey(namespace, tool))
    ) {
      return false;
    }
    // item/started is descriptive only: it neither binds a provisional ID nor
    // executes a tool. The reverse RPC above waits for authoritative identity.
    return true;
  }

  private sendBestEffortInterrupt(active: ActiveTurn, turnId: string): void {
    const child = this.child;
    if (!child) return;
    this.writeMessage({
      id: this.nextRequestId++,
      method: "turn/interrupt",
      params: { threadId: active.threadId, turnId },
    }, child);
  }

  private projectTextDelta(payload: CodexJsonRecord): CodexConversationTextDelta | null {
    const threadId = boundedIdentifier(payload.threadId);
    const turnId = boundedIdentifier(payload.turnId);
    const itemId = boundedIdentifier(payload.itemId);
    const delta = boundedText(payload.delta, MAX_STREAM_DELTA_BYTES);
    const active = this.activeTurn;
    if (!active || !threadId || !turnId || !itemId || delta === null) return null;
    if (active.threadId !== threadId || (active.turnId && active.turnId !== turnId)) return null;
    this.setActiveTurnId(active, turnId);
    return { threadId, turnId, itemId, delta };
  }

  private projectReasoningDelta(payload: CodexJsonRecord): CodexConversationReasoningDelta | null {
    const event = this.projectTextDelta(payload);
    const summaryIndex = payload.summaryIndex;
    if (!event || typeof summaryIndex !== "number" || !Number.isSafeInteger(summaryIndex) || summaryIndex < 0) {
      return null;
    }
    return { ...event, summaryIndex };
  }

  private recordTokenUsageNotification(payload: CodexJsonRecord): void {
    const event = projectTurnTokenUsage(payload);
    const active = this.activeTurn;
    if (
      !event
      || !active
      || active.settled
      || this.activeTurn !== active
      || active.threadId !== event.threadId
    ) {
      return;
    }
    // A usage notification is never allowed to bind the active turn. App
    // Server can re-send historic thread usage after a resume/fork, so retain
    // snapshots by ID until turn/start proves the exact active turn.
    if (active.authoritativeTurnId === event.turnId) {
      active.latestTokenUsage = event.tokenUsage;
      return;
    }
    if (active.authoritativeTurnId !== null) return;
    if (
      !active.pendingTokenUsageByTurnId.has(event.turnId)
      && active.pendingTokenUsageByTurnId.size >= 2
    ) {
      return;
    }
    // A newer notification replaces the earlier `last` snapshot; it is not a
    // delta and must never be summed.
    active.pendingTokenUsageByTurnId.set(event.turnId, event.tokenUsage);
  }

  private completeTurnFromNotification(payload: CodexJsonRecord): void {
    const active = this.activeTurn;
    const threadId = boundedIdentifier(payload.threadId);
    const turn = isCodexJsonRecord(payload.turn) ? payload.turn : null;
    const turnId = boundedIdentifier(turn?.id);
    if (!active || active.settled || !threadId || !turnId || active.threadId !== threadId) return;

    const status = projectTurnStatus(turn?.status);
    const providerError = status === "failed" ? projectSubscriptionTransportErrorDiagnostics(turn) : undefined;
    // A terminal notification cannot establish identity: resumed/forked threads
    // may replay historic completions before this request's turn/start reply.
    if (active.authoritativeTurnId === null) {
      // The first terminal status wins, matching immediate post-response
      // semantics and preventing a replayed duplicate from changing it.
      if (active.pendingCompletionByTurnId.has(turnId)) return;
      if (active.pendingCompletionByTurnId.size >= 2) {
        // A third distinct terminal notification before turn/start identifies
        // the active turn is ambiguous. Dropping it can lose the real terminal
        // signal and leave the caller waiting forever, so close fail-closed.
        this.abortTransport(new CodexConversationRuntimeError("codex-operation-failed"));
        return;
      }
      active.pendingCompletionByTurnId.set(turnId, { status, ...(providerError ? { providerError } : {}) });
      return;
    }
    if (active.authoritativeTurnId !== turnId) return;
    this.resolveTurnCompletion(active, turnId, status, providerError);
  }

  private resolveTurnCompletion(
    active: ActiveTurn,
    turnId: string,
    status: CodexConversationTurnStatus,
    providerError: SubscriptionTransportDiagnosticError["providerError"] | undefined,
  ): void {
    const result: CodexConversationTurnResult = {
      threadId: active.threadId,
      turnId,
      status,
      ...(status === "completed" && active.latestTokenUsage
        ? { tokenUsage: active.latestTokenUsage }
        : {}),
      ...(providerError ? { providerError } : {}),
    };
    this.resolveActiveTurn(active, result);
  }

  private resolveActiveTurn(active: ActiveTurn, result: CodexConversationTurnResult): void {
    if (active.settled) return;
    active.settled = true;
    active.pendingTokenUsageByTurnId.clear();
    active.pendingCompletionByTurnId.clear();
    void this.discardStagedImages(active.attachmentPaths);
    if (this.activeTurn === active) this.activeTurn = null;
    active.resolveCompletion(result);
    this.invokeCallback(active.callbacks.onTurnCompleted, result);
  }

  private rejectActiveTurn(active: ActiveTurn, error: Error): void {
    if (active.settled) return;
    active.settled = true;
    active.pendingTokenUsageByTurnId.clear();
    active.pendingCompletionByTurnId.clear();
    void this.discardStagedImages(active.attachmentPaths);
    if (this.activeTurn === active) this.activeTurn = null;
    active.rejectTurnId(error);
    active.rejectCompletion(error);
  }

  private invokeCallback<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try {
      callback?.(value);
    } catch {
      // UI/audit observers must never destabilize the transport.
    }
  }

  private abortTransport(error: CodexConversationRuntimeError, expectedChild?: ChildProcess): void {
    const child = this.child;
    if (expectedChild && child !== expectedChild) return;
    this.closeTransport(error, child);
    if (child) forceKillManagedChildProcess(child, "codex conversation transport closed");
  }

  private closeTransport(error: CodexConversationRuntimeError, expectedChild?: ChildProcess | null): void {
    if (expectedChild && this.child !== expectedChild) return;
    this.child = null;
    this.startPromise = null;
    this.threadStartPromise = null;
    this.threadId = null;
    this.threadDynamicTools = null;
    this.pendingThreadDynamicTools = null;
    this.stdoutBuffer = "";
    const active = this.activeTurn;
    if (active) this.rejectActiveTurn(active, error);
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private asRuntimeError(
    error: unknown,
    fallback: CodexConversationRuntimeErrorCode = "codex-operation-failed",
  ): CodexConversationRuntimeError {
    return error instanceof CodexConversationRuntimeError
      ? error
      : new CodexConversationRuntimeError(fallback);
  }
}
