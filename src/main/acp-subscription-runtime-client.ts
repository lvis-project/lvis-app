/**
 * Main-process connection manager for explicitly approved ACP subscription
 * runtimes. It deliberately owns only setup and authentication verification;
 * it is not an LLM provider and never exposes ACP tools to the application.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  acpSubscriptionPromptCapabilitiesFromInitialize,
  acpSubscriptionStatus,
  DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES,
  type AcpSubscriptionConnectionState,
  type AcpSubscriptionErrorCode,
  type AcpSubscriptionPromptCapabilities,
  type AcpSubscriptionProviderId,
  type AcpSubscriptionStatus,
} from "../shared/acp-subscription.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import {
  GROK_BUILD_REQUIRED_MINIMUM_VERSION,
  grokBuildGovernedAgentDefinitionPath,
} from "./acp-subscription-runtime-config.js";
import { isRecord } from "../shared/is-record.js";

const PROBE_TIMEOUT_MS = 10_000;
const ACP_REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const MAX_LOGIN_OUTPUT_BYTES = 64 * 1024;
const MAX_LOGIN_LINE_BYTES = 2_048;
const MAX_RPC_LINE_BYTES = 256 * 1024;
const MAX_VERSION_LENGTH = 80;
const MAX_DEVICE_CODE_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ANSI_ESCAPE = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g;

type JsonRecord = Record<string, unknown>;
type SpawnAcpRuntime = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

/**
 * Main-process-only provider metadata shared by the short-lived auth probe and
 * the long-lived ACP session transport. `acpArgs` identify the documented
 * stdio transport only; they are deliberately not a general CLI-flag surface.
 *
 * If a provider documents a safe native-tool disable setting, put it in the
 * isolated provider-home configuration managed by the registry, then retain
 * the session client's fail-closed tool detection as a backstop.
 */
export interface AcpSubscriptionRuntimeManifest {
  readonly provider: AcpSubscriptionProviderId;
  readonly homeEnv: "KIMI_CODE_HOME" | "GROK_HOME";
  readonly probeArgs: readonly string[];
  readonly acpArgs: readonly string[];
  readonly loginArgs: readonly string[];
  readonly logoutArgs?: readonly string[];
  readonly authenticateParams: Readonly<Record<string, unknown>>;
  readonly requiresAuthenticationMethod?: string;
}

export const ACP_SUBSCRIPTION_RUNTIME_MANIFESTS: Readonly<
  Record<AcpSubscriptionProviderId, AcpSubscriptionRuntimeManifest>
> = Object.freeze({
  "kimi-code": Object.freeze({
    provider: "kimi-code",
    homeEnv: "KIMI_CODE_HOME",
    probeArgs: Object.freeze(["--version"]),
    acpArgs: Object.freeze(["acp"]),
    loginArgs: Object.freeze(["login"]),
    // Kimi's ACP implementation uses snake_case for this field.
    authenticateParams: Object.freeze({ method_id: "login" }),
    requiresAuthenticationMethod: "login",
  }),
  "grok-build": Object.freeze({
    provider: "grok-build",
    homeEnv: "GROK_HOME",
    probeArgs: Object.freeze(["--version"]),
    acpArgs: Object.freeze(["--no-auto-update", "agent", "stdio"]),
    loginArgs: Object.freeze(["login", "--device-auth"]),
    logoutArgs: Object.freeze(["logout"]),
    authenticateParams: Object.freeze({
      methodId: "cached_token",
      _meta: Object.freeze({ headless: true }),
    }),
    requiresAuthenticationMethod: "cached_token",
  }),
});

const DEVICE_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+){0,3}$/;
const VERIFICATION_HOSTS: Record<AcpSubscriptionProviderId, readonly string[]> = {
  "kimi-code": ["auth.kimi.com"],
  "grok-build": ["auth.x.ai", "accounts.x.ai"],
};

export class AcpSubscriptionRuntimeError extends Error {
  constructor(readonly code: AcpSubscriptionErrorCode) {
    super(code);
    this.name = "AcpSubscriptionRuntimeError";
  }
}

export interface AcpSubscriptionRuntimeClientOptions {
  provider: AcpSubscriptionProviderId;
  /** Existing, app-owned isolated data root for exactly one provider. */
  runtimeHome: string;
  /** Existing, blank app-owned workspace. Never bind a real project here. */
  workspaceDir: string;
  /** Existing, app-owned temporary directory for exactly one provider. */
  runtimeTempDir?: string;
  /** A previously main-approved absolute executable path, if one exists. */
  executablePath?: string | null;
  /** Test seam; production uses the managed-child registry. */
  spawn?: SpawnAcpRuntime;
  /** Test seam for filesystem-based executable validation. */
  resolveExecutable?: (candidate: string) => Promise<string>;
  /** Test seam for platform-sensitive validation and environment creation. */
  platform?: NodeJS.Platform;
  clientVersion?: string;
}

interface PendingLogin {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  outputBytes: number;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  stdoutBuffer: string;
  stderrBuffer: string;
  verificationUrl: string | null;
  deviceCode: string | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface AcpAuthenticationProbeResult {
  readonly connection: AcpSubscriptionConnectionState;
  readonly promptCapabilities: AcpSubscriptionPromptCapabilities;
}

class AcpRpcError extends Error {
  constructor(readonly authenticationRequired: boolean) {
    super("acp-rpc-error");
    this.name = "AcpRpcError";
  }
}

function isAuthenticationError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.code === -32_000) return true;
  const message = typeof value.message === "string" ? value.message.toLocaleLowerCase() : "";
  return /auth|login|credential|token/.test(message);
}

function safeVersion(value: string): string | null {
  const match = value.match(/\bv?\d+(?:\.\d+){1,4}(?:[-+][0-9a-z.-]+)?\b/i);
  if (!match) return null;
  const version = match[0];
  return version.length <= MAX_VERSION_LENGTH && !CONTROL_CHARACTERS.test(version)
    ? version
    : null;
}

function numericVersionParts(value: string): readonly number[] | null {
  const core = value.replace(/^v/i, "").split(/[+-]/u, 1)[0] ?? "";
  const rawParts = core.split(".");
  if (rawParts.length < 2 || rawParts.length > 5) return null;
  const parts: number[] = [];
  for (const part of rawParts) {
    if (!/^\d{1,9}$/u.test(part)) return null;
    const numeric = Number(part);
    if (!Number.isSafeInteger(numeric)) return null;
    parts.push(numeric);
  }
  return parts;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  // A prerelease may share the numeric tuple but not the tool-profile contract.
  // This guard is deliberately used only for the pinned Grok runtime boundary.
  if (actual.replace(/^v/i, "").includes("-")) return false;
  const actualParts = numericVersionParts(actual);
  const minimumParts = numericVersionParts(minimum);
  if (!actualParts || !minimumParts) return false;
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function configuredStatus(provider: AcpSubscriptionProviderId): AcpSubscriptionStatus {
  return acpSubscriptionStatus(provider, "not-configured", "unknown");
}

function unverifiedStatus(provider: AcpSubscriptionProviderId): AcpSubscriptionStatus {
  return acpSubscriptionStatus(provider, "unverified", "unknown");
}

function unavailableStatus(provider: AcpSubscriptionProviderId): AcpSubscriptionStatus {
  return acpSubscriptionStatus(provider, "unavailable", "unknown");
}

function blocksInheritedEnvironment(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.startsWith("KIMI_")
    || normalized.startsWith("GROK_")
    || normalized.startsWith("XAI_")
    || normalized.startsWith("OPENAI_")
    || normalized.startsWith("ANTHROPIC_")
    || normalized.startsWith("COPILOT_")
    || normalized.startsWith("CODEX_")
    || normalized.startsWith("OTEL_")
    || normalized.startsWith("GH_")
    || normalized.startsWith("GITHUB_")
    || normalized.startsWith("NODE_")
    || normalized.startsWith("NPM_")
    || normalized.startsWith("BUN_")
    || normalized === "HTTP_PROXY"
    || normalized === "HTTPS_PROXY"
    || normalized === "ALL_PROXY"
    || normalized === "NO_PROXY"
    || normalized === "SSL_CERT_FILE"
    || normalized === "SSL_CERT_DIR"
    || normalized === "SSLKEYLOGFILE"
    || normalized === "RUST_LOG"
    || normalized === "RUST_BACKTRACE"
    || normalized.startsWith("LD_")
    || normalized.startsWith("DYLD_");
}

const SAFE_INHERITED_ENV_NAMES = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
]);

const GROK_DISABLED_FEATURE_ENV_NAMES = Object.freeze([
  "GROK_MANAGED_CONFIG",
  "GROK_MANAGED_MCPS_ENABLED",
  "GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED",
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CLAUDE_SESSIONS_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CURSOR_SESSIONS_ENABLED",
  "GROK_CODEX_SESSIONS_ENABLED",
] as const);

/**
 * Start from an allowlist rather than a copy of process.env. The only runtime
 * credential source is the provider's isolated home; API keys, existing CLI
 * homes, proxies, loader injection, and custom auth-provider commands are not
 * inherited. Executable search and temporary files receive fixed safe values.
 */
export function sanitizedAcpSubscriptionEnvironment(
  provider: AcpSubscriptionProviderId,
  runtimeHome: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runtimeTempDir = join(runtimeHome, "tmp"),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (!value || blocksInheritedEnvironment(key)) continue;
    if (SAFE_INHERITED_ENV_NAMES.has(key.toUpperCase())) env[key] = value;
  }
  const isolatedHome = normalizedRuntimeDirectory(runtimeHome, platform);
  const isolatedTemp = normalizedRuntimeDirectory(runtimeTempDir, platform);
  if (platform === "win32") {
    const systemRoot = safeWindowsSystemRoot(parentEnv);
    if (systemRoot) {
      env.SYSTEMROOT = systemRoot;
      env.WINDIR = systemRoot;
      env.COMSPEC = win32.join(systemRoot, "System32", "cmd.exe");
      env.PATH = `${win32.join(systemRoot, "System32")};${systemRoot}`;
      env.PATHEXT = ".EXE";
    }
    env.USERPROFILE = isolatedHome;
    env.APPDATA = win32.join(isolatedHome, "appdata");
    env.LOCALAPPDATA = win32.join(isolatedHome, "localappdata");
  } else {
    env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    env.HOME = isolatedHome;
    env.XDG_CONFIG_HOME = join(isolatedHome, "config");
    env.XDG_DATA_HOME = join(isolatedHome, "data");
    env.XDG_CACHE_HOME = join(isolatedHome, "cache");
  }
  env.TEMP = isolatedTemp;
  env.TMP = isolatedTemp;
  env.TMPDIR = isolatedTemp;
  env[ACP_SUBSCRIPTION_RUNTIME_MANIFESTS[provider].homeEnv] = isolatedHome;
  if (provider === "grok-build") {
    for (const key of GROK_DISABLED_FEATURE_ENV_NAMES) env[key] = "false";
    env.GROK_AGENT = grokBuildGovernedAgentDefinitionPath(isolatedHome, platform);
    env.GROK_REQUIRED_MINIMUM_VERSION = GROK_BUILD_REQUIRED_MINIMUM_VERSION;
  }
  // Avoid vendor debug output that can include login context. stderr is parsed
  // only for a strictly allowlisted, short-lived device-code flow.
  env.RUST_LOG = "error";
  return env;
}

function unsafeWindowsPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("\\\\?\\") || path.startsWith("\\\\.\\");
}

function normalizedRuntimeDirectory(candidate: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.normalize(candidate) : resolve(candidate);
}

function safeWindowsSystemRoot(parentEnv: NodeJS.ProcessEnv): string | null {
  for (const candidate of [
    parentEnv.SystemRoot,
    parentEnv.SYSTEMROOT,
    parentEnv.WINDIR,
    parentEnv.windir,
  ]) {
    if (!candidate || candidate.length > 512 || CONTROL_CHARACTERS.test(candidate)) continue;
    if (!win32.isAbsolute(candidate) || unsafeWindowsPath(candidate)) continue;
    const normalized = win32.normalize(candidate);
    if (/^[A-Za-z]:$/.test(normalized.slice(0, 2))) return normalized;
  }
  return null;
}

/**
 * Canonicalize a picker-approved executable before persisting or spawning it.
 * The caller must repeat this immediately before every execution because the
 * persisted config is not a trusted input and the filesystem can change.
 */
export async function resolveAcpSubscriptionExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const absolute = platform === "win32" ? win32.isAbsolute(candidate) : isAbsolute(candidate);
  if (
    !candidate ||
    candidate.length > 4_096 ||
    CONTROL_CHARACTERS.test(candidate) ||
    !absolute ||
    (platform === "win32" && unsafeWindowsPath(candidate))
  ) {
    throw new AcpSubscriptionRuntimeError("acp-runtime-invalid-executable");
  }
  let executable: string;
  try {
    executable = await fs.realpath(candidate);
    const stat = await fs.stat(executable);
    if (!stat.isFile()) throw new Error("not-a-file");
    if (platform === "win32") {
      if (unsafeWindowsPath(executable) || !executable.toLocaleLowerCase().endsWith(".exe")) {
        throw new Error("not-a-native-windows-executable");
      }
    } else {
      await fs.access(executable, fsConstants.X_OK);
    }
  } catch {
    throw new AcpSubscriptionRuntimeError("acp-runtime-invalid-executable");
  }
  return executable;
}

function spawnAcpSubscriptionRuntime(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
): ChildProcess {
  return spawnManaged(command, args, options, { label: "acp-subscription-runtime" });
}

class AcpAuthProbe {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;

  constructor(private readonly child: ChildProcess) {
    if (!child.stdin || !child.stdout) {
      throw new AcpSubscriptionRuntimeError("acp-operation-failed");
    }
    child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk));
    child.stdout.once("error", () => this.close(new AcpSubscriptionRuntimeError("acp-operation-failed")));
    child.stdin.once("error", () => this.close(new AcpSubscriptionRuntimeError("acp-operation-failed")));
    // Drain but never retain or log diagnostic output. Provider CLIs can print
    // device codes, URLs, account emails, and network details here.
    child.stderr?.on("data", () => {});
    child.stderr?.once("error", () => this.close(new AcpSubscriptionRuntimeError("acp-operation-failed")));
    child.once("error", () => this.close(new AcpSubscriptionRuntimeError("acp-operation-failed")));
    child.once("exit", () => this.close(new AcpSubscriptionRuntimeError("acp-operation-failed")));
  }

  async authenticate(
    manifest: AcpSubscriptionRuntimeManifest,
    clientVersion: string,
  ): Promise<AcpAuthenticationProbeResult> {
    const initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "lvis", version: clientVersion },
    });
    const promptCapabilities = acpSubscriptionPromptCapabilitiesFromInitialize(initialized);
    if (manifest.requiresAuthenticationMethod) {
      const result = isRecord(initialized) ? initialized : null;
      const methods = Array.isArray(result?.authMethods) ? result.authMethods : [];
      const hasRequiredMethod = methods.some((method) => {
        if (!isRecord(method)) return false;
        return method.id === manifest.requiresAuthenticationMethod
          || method.methodId === manifest.requiresAuthenticationMethod;
      });
      if (!hasRequiredMethod) {
        return {
          connection: "signed-out",
          promptCapabilities: DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES,
        };
      }
    }
    try {
      await this.request("authenticate", manifest.authenticateParams);
      return { connection: "connected", promptCapabilities };
    } catch (error) {
      if (error instanceof AcpRpcError && error.authenticationRequired) {
        return {
          connection: "signed-out",
          promptCapabilities: DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES,
        };
      }
      throw error;
    }
  }

  dispose(): void {
    this.close(new AcpSubscriptionRuntimeError("acp-operation-failed"));
    forceKillManagedChildProcess(this.child, "acp subscription authentication probe");
  }

  private request(method: string, params: JsonRecord): Promise<unknown> {
    if (this.closed || !this.child.stdin?.writable) {
      return Promise.reject(new AcpSubscriptionRuntimeError("acp-operation-failed"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_LINE_BYTES) {
      return Promise.reject(new AcpSubscriptionRuntimeError("acp-operation-failed"));
    }
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.close(new AcpSubscriptionRuntimeError("acp-operation-failed"));
      }, ACP_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.child.stdin?.write(`${payload}\n`);
      } catch {
        this.close(new AcpSubscriptionRuntimeError("acp-operation-failed"));
      }
    });
  }

  private consume(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_LINE_BYTES) {
      this.close(new AcpSubscriptionRuntimeError("acp-operation-failed"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.close(new AcpSubscriptionRuntimeError("acp-operation-failed"));
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.close(new AcpSubscriptionRuntimeError("acp-operation-failed"));
      return;
    }
    if (typeof message.id === "number" && Number.isInteger(message.id)) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error !== undefined) {
        request.reject(new AcpRpcError(isAuthenticationError(message.error)));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    // An ACP runtime must not call arbitrary host capabilities during an auth
    // probe. Decline a request and fail closed rather than inventing a tool
    // bridge before the approval/audit integration exists.
    if (message.id !== undefined && typeof message.method === "string") {
      try {
        this.child.stdin?.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported request" },
        })}\n`);
      } catch {
        // The generic failure below remains the only observable result.
      }
      this.close(new AcpSubscriptionRuntimeError("acp-operation-failed"));
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}

export class AcpSubscriptionRuntimeClient {
  private readonly manifest: AcpSubscriptionRuntimeManifest;
  private readonly spawn: SpawnAcpRuntime;
  private readonly resolveExecutable: (candidate: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly clientVersion: string;
  private executablePath: string | null;
  private verifiedExecutable: string | null = null;
  private status: AcpSubscriptionStatus;
  private pendingLogin: PendingLogin | null = null;
  private completedLoginError: AcpSubscriptionErrorCode | null = null;
  private operationLock: Promise<void> = Promise.resolve();

  constructor(private readonly options: AcpSubscriptionRuntimeClientOptions) {
    this.manifest = ACP_SUBSCRIPTION_RUNTIME_MANIFESTS[options.provider];
    this.spawn = options.spawn ?? spawnAcpSubscriptionRuntime;
    this.platform = options.platform ?? process.platform;
    this.resolveExecutable = options.resolveExecutable
      ?? ((candidate) => resolveAcpSubscriptionExecutable(candidate, this.platform));
    this.clientVersion = options.clientVersion ?? getLvisAppVersion();
    this.executablePath = options.executablePath ?? null;
    this.status = this.executablePath
      ? unverifiedStatus(options.provider)
      : configuredStatus(options.provider);
  }

  /** Read-only status: this method never executes a user-selected program. */
  async getStatus(): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      const status = await this.getStatusUnsafe();
      const completedLoginError = this.completedLoginError;
      this.completedLoginError = null;
      if (completedLoginError) throw new AcpSubscriptionRuntimeError(completedLoginError);
      return status;
    });
  }

  private async getStatusUnsafe(): Promise<AcpSubscriptionStatus> {
    if (this.pendingLogin) return this.currentStatus();
    if (!this.executablePath) {
      this.status = configuredStatus(this.options.provider);
      return this.currentStatus();
    }
    try {
      const executable = await this.resolveExecutable(this.executablePath);
      if (this.verifiedExecutable === executable && this.status.runtime === "ready") {
        return this.currentStatus();
      }
      this.verifiedExecutable = null;
      this.status = unverifiedStatus(this.options.provider);
    } catch {
      this.verifiedExecutable = null;
      this.status = unavailableStatus(this.options.provider);
    }
    return this.currentStatus();
  }

  getCachedStatus(): AcpSubscriptionStatus {
    return this.currentStatus();
  }

  /** Main-only canonical path for the config store; never crosses IPC. */
  getConfiguredExecutable(): string | null {
    return this.executablePath;
  }

  /** Store only a canonical, non-executed picker-approved path. */
  async setExecutable(candidate: string): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      const executable = await this.resolveExecutable(candidate);
      this.stopUnsafe();
      this.completedLoginError = null;
      this.executablePath = executable;
      this.verifiedExecutable = null;
      this.status = unverifiedStatus(this.options.provider);
      return this.currentStatus();
    });
  }

  async clearExecutable(): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      this.stopUnsafe();
      this.completedLoginError = null;
      this.executablePath = null;
      this.verifiedExecutable = null;
      this.status = configuredStatus(this.options.provider);
      return this.currentStatus();
    });
  }

  /** Explicit verification is the only path that executes the selected binary. */
  async verify(): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      if (this.pendingLogin) throw new AcpSubscriptionRuntimeError("acp-login-in-progress");
      const executable = await this.requireExecutable();
      try {
        const version = await this.runCommand(executable, this.manifest.probeArgs, true);
        const reportedVersion = safeVersion(version);
        if (
          this.options.provider === "grok-build"
          && (!reportedVersion || !versionAtLeast(reportedVersion, GROK_BUILD_REQUIRED_MINIMUM_VERSION))
        ) {
          this.verifiedExecutable = null;
          this.status = unverifiedStatus(this.options.provider);
          throw new AcpSubscriptionRuntimeError("acp-runtime-unavailable");
        }
        const authentication = await this.probeAuthentication(executable);
        this.verifiedExecutable = executable;
        this.status = acpSubscriptionStatus(
          this.options.provider,
          "ready",
          authentication.connection,
          reportedVersion,
          null,
          null,
          false,
          authentication.promptCapabilities,
        );
        return this.currentStatus();
      } catch (error) {
        if (error instanceof AcpSubscriptionRuntimeError) throw error;
        this.status = acpSubscriptionStatus(this.options.provider, "ready", "unknown");
        throw new AcpSubscriptionRuntimeError("acp-operation-failed");
      }
    });
  }

  /**
   * Starts only the documented device-code command. The official runtime may
   * open the user's native system browser, but LVIS does not automate that
   * browser. All output is parsed in-memory under strict allowlists only.
   */
  async startDeviceCodeLogin(): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      if (this.pendingLogin) throw new AcpSubscriptionRuntimeError("acp-login-in-progress");
      const executable = await this.requireExecutable();
      const child = this.launch(executable, this.manifest.loginArgs);
      if (!child.stdout || !child.stderr) {
        forceKillManagedChildProcess(child, "acp subscription login missing output streams");
        throw new AcpSubscriptionRuntimeError("acp-operation-failed");
      }
      const pending = {
        child,
        timer: undefined as unknown as NodeJS.Timeout,
        outputBytes: 0,
        stdoutDecoder: new StringDecoder("utf8"),
        stderrDecoder: new StringDecoder("utf8"),
        stdoutBuffer: "",
        stderrBuffer: "",
        verificationUrl: null,
        deviceCode: null,
      } satisfies PendingLogin;
      pending.timer = setTimeout(
        () => this.queueFinishPendingLogin(pending, "failed"),
        LOGIN_TIMEOUT_MS,
      );
      pending.timer.unref?.();
      this.pendingLogin = pending;
      this.completedLoginError = null;
      this.verifiedExecutable = null;
      this.status = acpSubscriptionStatus(
        this.options.provider,
        "unverified",
        "pending",
        null,
        "device-code",
        null,
        false,
      );
      child.stdout.on("data", (chunk: Buffer | string) => this.consumeLoginOutput(pending, "stdout", chunk));
      child.stderr.on("data", (chunk: Buffer | string) => this.consumeLoginOutput(pending, "stderr", chunk));
      child.once("error", () => this.queueFinishPendingLogin(pending, "failed"));
      child.once("close", (code: number | null) => {
        this.queueFinishPendingLogin(pending, code === 0 ? "succeeded" : "failed");
      });
      return this.currentStatus();
    });
  }

  /** The renderer never receives the dynamic URL; only this main-side callback does. */
  async openPendingVerificationUrl(openExternal: (url: string) => Promise<void>): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      const pending = this.pendingLogin;
      if (!pending?.verificationUrl) {
        throw new AcpSubscriptionRuntimeError("acp-verification-url-unavailable");
      }
      try {
        await openExternal(pending.verificationUrl);
      } catch {
        throw new AcpSubscriptionRuntimeError("acp-operation-failed");
      }
      return this.currentStatus();
    });
  }

  async cancelLogin(): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      const pending = this.pendingLogin;
      if (!pending) return this.getStatusUnsafe();
      this.finishPendingLogin(pending, "cancelled");
      return this.currentStatus();
    });
  }

  async logout(): Promise<AcpSubscriptionStatus> {
    return this.withOperationLock(async () => {
      if (!this.manifest.logoutArgs) {
        throw new AcpSubscriptionRuntimeError("acp-logout-not-supported");
      }
      if (this.pendingLogin) throw new AcpSubscriptionRuntimeError("acp-login-in-progress");
      const executable = await this.requireExecutable();
      try {
        await this.runCommand(executable, this.manifest.logoutArgs, false);
      } catch (error) {
        if (error instanceof AcpSubscriptionRuntimeError) throw error;
        throw new AcpSubscriptionRuntimeError("acp-operation-failed");
      }
      this.verifiedExecutable = null;
      this.status = acpSubscriptionStatus(this.options.provider, "unverified", "signed-out");
      return this.currentStatus();
    });
  }

  async stop(): Promise<void> {
    await this.withOperationLock(async () => {
      this.stopUnsafe();
    });
  }

  private async requireExecutable(): Promise<string> {
    if (!this.executablePath) throw new AcpSubscriptionRuntimeError("acp-runtime-not-configured");
    await this.requireRuntimeDirectories();
    try {
      return await this.resolveExecutable(this.executablePath);
    } catch {
      this.verifiedExecutable = null;
      this.status = unavailableStatus(this.options.provider);
      throw new AcpSubscriptionRuntimeError("acp-runtime-invalid-executable");
    }
  }

  private launch(executable: string, args: readonly string[]): ChildProcess {
    const env = sanitizedAcpSubscriptionEnvironment(
      this.options.provider,
      this.options.runtimeHome,
      process.env,
      this.platform,
      this.options.runtimeTempDir ?? join(this.options.runtimeHome, "tmp"),
    );
    return this.spawn(executable, args, {
      cwd: this.options.workspaceDir,
      env,
      // ACP authentication is JSONL over stdin/stdout. Keeping stdin piped is
      // required for the probe and harmless for version/login subcommands.
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: this.platform !== "win32",
    });
  }

  private async requireRuntimeDirectories(): Promise<void> {
    for (const candidate of [
      this.options.runtimeHome,
      this.options.workspaceDir,
      this.options.runtimeTempDir ?? join(this.options.runtimeHome, "tmp"),
    ]) {
      try {
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-runtime-directory");
      } catch {
        throw new AcpSubscriptionRuntimeError("acp-operation-failed");
      }
    }
  }

  private async runCommand(
    executable: string,
    args: readonly string[],
    captureStdout: boolean,
  ): Promise<string> {
    const child = this.launch(executable, args);
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      forceKillManagedChildProcess(child, "acp subscription command missing output streams");
      throw new AcpSubscriptionRuntimeError("acp-operation-failed");
    }
    return new Promise<string>((resolveCommand, rejectCommand) => {
      let settled = false;
      let stdout = "";
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectCommand(error);
        else resolveCommand(stdout);
      };
      const timer = setTimeout(() => {
        forceKillManagedChildProcess(child, "acp subscription command timeout");
        finish(new AcpSubscriptionRuntimeError("acp-runtime-unavailable"));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      stdoutStream.on("data", (chunk: Buffer | string) => {
        if (!captureStdout || settled) return;
        stdout += String(chunk);
        if (Buffer.byteLength(stdout, "utf8") > MAX_VERSION_LENGTH * 4) {
          forceKillManagedChildProcess(child, "acp subscription command output limit");
          finish(new AcpSubscriptionRuntimeError("acp-operation-failed"));
        }
      });
      stderrStream.on("data", () => {});
      child.once("error", () => {
        forceKillManagedChildProcess(child, "acp subscription command error");
        finish(new AcpSubscriptionRuntimeError("acp-runtime-unavailable"));
      });
      child.once("close", (code: number | null) => {
        if (code === 0) finish();
        else finish(new AcpSubscriptionRuntimeError("acp-operation-failed"));
      });
    });
  }

  private async probeAuthentication(executable: string): Promise<AcpAuthenticationProbeResult> {
    const child = this.launch(executable, this.manifest.acpArgs);
    let probe: AcpAuthProbe | null = null;
    try {
      probe = new AcpAuthProbe(child);
      return await probe.authenticate(this.manifest, this.clientVersion);
    } catch (error) {
      if (error instanceof AcpSubscriptionRuntimeError || error instanceof AcpRpcError) throw error;
      throw new AcpSubscriptionRuntimeError("acp-operation-failed");
    } finally {
      if (probe) {
        probe.dispose();
      } else {
        forceKillManagedChildProcess(child, "acp subscription invalid authentication probe");
      }
    }
  }

  private consumeLoginOutput(
    pending: PendingLogin,
    stream: "stdout" | "stderr",
    chunk: Buffer | string,
  ): void {
    if (this.pendingLogin !== pending) return;
    pending.outputBytes += Buffer.byteLength(chunk);
    if (pending.outputBytes > MAX_LOGIN_OUTPUT_BYTES) {
      this.queueFinishPendingLogin(pending, "failed");
      return;
    }
    const decoder = stream === "stdout" ? pending.stdoutDecoder : pending.stderrDecoder;
    const decoded = typeof chunk === "string" ? chunk : decoder.write(chunk);
    const previous = stream === "stdout" ? pending.stdoutBuffer : pending.stderrBuffer;
    const buffer = `${previous}${decoded}`;
    if (Buffer.byteLength(buffer, "utf8") > MAX_LOGIN_LINE_BYTES) {
      this.queueFinishPendingLogin(pending, "failed");
      return;
    }
    let remainder = buffer;
    for (;;) {
      const newline = remainder.indexOf("\n");
      if (newline < 0) break;
      const line = remainder.slice(0, newline);
      remainder = remainder.slice(newline + 1);
      this.consumeLoginLine(pending, line);
      if (this.pendingLogin !== pending) return;
    }
    if (stream === "stdout") {
      pending.stdoutBuffer = remainder;
    } else {
      pending.stderrBuffer = remainder;
    }
  }

  private consumeLoginLine(pending: PendingLogin, line: string): void {
    if (this.pendingLogin !== pending) return;
    const normalized = line
      .replace(ANSI_ESCAPE, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (!normalized || Buffer.byteLength(normalized, "utf8") > MAX_LOGIN_LINE_BYTES) return;

    const verificationUrl = this.extractVerificationUrl(normalized);
    if (verificationUrl && !pending.verificationUrl) {
      pending.verificationUrl = verificationUrl;
      const deviceCode = this.safeDeviceCode(new URL(verificationUrl).searchParams.get("user_code"));
      if (deviceCode) pending.deviceCode = deviceCode;
    }
    if (!pending.deviceCode && pending.verificationUrl) {
      const labeledCode = normalized.match(
        /\b(?:user\s*code|device\s*code|code)\s*[:=]\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+){0,3})\b/i,
      )?.[1];
      const deviceCode = this.safeDeviceCode(labeledCode ?? null);
      if (deviceCode) pending.deviceCode = deviceCode;
    }
    this.refreshPendingLoginStatus(pending);
  }

  private extractVerificationUrl(line: string): string | null {
    const candidates = line.match(/https:\/\/[^\s<>"']+/g) ?? [];
    for (const candidate of candidates) {
      if (candidate.length > 2_048) continue;
      try {
        const parsed = new URL(candidate);
        if (
          parsed.protocol !== "https:"
          || parsed.username
          || parsed.password
          || parsed.hash
          || (parsed.port && parsed.port !== "443")
        ) {
          continue;
        }
        const hostname = parsed.hostname.toLocaleLowerCase();
        if (VERIFICATION_HOSTS[this.options.provider].includes(hostname)) {
          return parsed.toString();
        }
      } catch {
        // Untrusted runtime output is intentionally ignored.
      }
    }
    return null;
  }

  private safeDeviceCode(value: string | null): string | null {
    if (!value) return null;
    const deviceCode = value.trim().toUpperCase();
    if (
      deviceCode.length < 4
      || deviceCode.length > MAX_DEVICE_CODE_LENGTH
      || !DEVICE_CODE_PATTERN.test(deviceCode)
    ) {
      return null;
    }
    return deviceCode;
  }

  private refreshPendingLoginStatus(pending: PendingLogin): void {
    if (this.pendingLogin !== pending) return;
    this.status = acpSubscriptionStatus(
      this.options.provider,
      "unverified",
      "pending",
      null,
      "device-code",
      pending.deviceCode,
      Boolean(pending.verificationUrl),
    );
  }

  private queueFinishPendingLogin(
    pending: PendingLogin,
    outcome: "succeeded" | "failed" | "cancelled",
  ): void {
    void this.withOperationLock(async () => {
      this.finishPendingLogin(pending, outcome);
    }).catch(() => undefined);
  }

  private finishPendingLogin(
    pending: PendingLogin,
    outcome: "succeeded" | "failed" | "cancelled",
  ): void {
    if (this.pendingLogin !== pending) return;
    this.pendingLogin = null;
    clearTimeout(pending.timer);
    pending.stdoutBuffer = "";
    pending.stderrBuffer = "";
    pending.verificationUrl = null;
    pending.deviceCode = null;
    forceKillManagedChildProcess(pending.child, `acp subscription login ${outcome}`);
    this.verifiedExecutable = null;
    this.status = acpSubscriptionStatus(
      this.options.provider,
      "unverified",
      outcome === "succeeded" ? "unknown" : "signed-out",
    );
    if (outcome === "failed") this.completedLoginError = "acp-login-failed";
  }

  private stopUnsafe(): void {
    if (this.pendingLogin) this.finishPendingLogin(this.pendingLogin, "cancelled");
  }

  private currentStatus(): AcpSubscriptionStatus {
    return { ...this.status };
  }

  private async withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationLock;
    let release: () => void = () => {};
    this.operationLock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
