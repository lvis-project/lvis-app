import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type CodexSubscriptionConnectionState,
  type CodexSubscriptionLoginMethod,
  type CodexSubscriptionModel,
  type CodexSubscriptionStatus,
  type CodexSubscriptionErrorCode,
  CODEX_SUBSCRIPTION_SIGNED_OUT_STATUS,
} from "../shared/codex-subscription.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import { spawnManaged } from "./managed-child-processes.js";

const require = createRequire(import.meta.url);

const RPC_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RPC_LINE_BYTES = 1_000_000;
const MAX_MODEL_COUNT = 100;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_PLAN_TYPE_LENGTH = 80;
const MAX_DEVICE_CODE_LENGTH = 128;

type JsonRecord = Record<string, unknown>;

type SpawnAppServer = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export type CodexAppServerErrorCode = CodexSubscriptionErrorCode;

export class CodexAppServerError extends Error {
  constructor(readonly code: CodexAppServerErrorCode) {
    super(code);
    this.name = "CodexAppServerError";
  }
}

export interface CodexAppServerClientOptions {
  /** Opens a trusted ChatGPT/OpenAI URL in the system browser. */
  openExternal: (url: string) => Promise<void> | void;
  /** Existing isolated directory owned by the host integration's runtime. */
  runtimeHome: string;

  /** Existing isolated SQLite directory owned by the host integration. */
  sqliteHome: string;
  /** Existing blank working directory with no project config or rules. */
  workspaceDir: string;
  /** Test seam for the packaged Codex executable resolver. */
  resolveExecutable?: () => string;
  /** Test seam; production always uses managed-child-processes. */
  spawn?: SpawnAppServer;
  clientVersion?: string;
}

interface PendingLogin {
  loginId: string;
  method: CodexSubscriptionLoginMethod;
  deviceCode: string | null;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
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

/**
 * Resolve the official package's native binary directly. We deliberately do
 * not execute a PATH-resolved `codex` shim or a shell command: the runtime is
 * pinned in package.json and every argv value below is host-owned.
 */
function resolveBundledCodexExecutable(): string {
  const target = PLATFORM_TARGETS[process.platform]?.[process.arch];
  if (!target) {
    throw new CodexAppServerError("codex-runtime-unavailable");
  }

  let packageJson: string;
  try {
    packageJson = require.resolve(`${target.packageName}/package.json`);
  } catch {
    throw new CodexAppServerError("codex-runtime-unavailable");
  }

  const packagedPath = join(
    dirname(packageJson),
    "vendor",
    target.targetTriple,
    "bin",
    target.executableName,
  );
  const executable = preferAsarUnpackedPath(packagedPath);
  if (!existsSync(executable)) {
    throw new CodexAppServerError("codex-runtime-unavailable");
  }
  return executable;
}

function preferAsarUnpackedPath(candidate: string): string {
  const asarSegment = `${sep}app.asar${sep}`;
  if (!candidate.includes(asarSegment)) return candidate;
  const unpacked = candidate.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : candidate;
}

function spawnPackagedCodex(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
): ChildProcess {
  return spawnManaged(command, args, options, { label: "codex-app-server" });
}

const BLOCKED_SUBSCRIPTION_ENV_NAMES = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_BASE_URL",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "RUST_LOG",
  "LOG_FORMAT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SSLKEYLOGFILE",
  "RUST_BACKTRACE",
]);

function blocksInheritedSubscriptionEnvironment(key: string): boolean {
  const normalized = key.toUpperCase();
  if (
    normalized.startsWith("CODEX_")
    || normalized.startsWith("OPENAI_")
    || normalized.startsWith("OTEL_")
  ) {
    return true;
  }
  return BLOCKED_SUBSCRIPTION_ENV_NAMES.has(normalized)
    || (process.platform === "linux" && normalized.startsWith("LD_"))
    || (process.platform === "darwin" && normalized.startsWith("DYLD_"));
}

function validateRuntimeDirectory(runtimeHome: string): string {
  const trimmed = runtimeHome.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new CodexAppServerError("codex-runtime-start-failed");
  }
  const directory = resolve(trimmed);
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Codex runtime directory is not a real directory");
    }
  } catch {
    throw new CodexAppServerError("codex-runtime-start-failed");
  }
  return directory;
}

function sanitizedCodexEnvironment(runtimeHome: string, sqliteHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Windows environment keys are case-insensitive, so filter all inherited
  // spellings before injecting the integration-owned isolated locations.
  for (const [key, value] of Object.entries(process.env)) {
    if (!blocksInheritedSubscriptionEnvironment(key)) env[key] = value;
  }
  return {
    ...env,
    CODEX_HOME: runtimeHome,
    CODEX_SQLITE_HOME: sqliteHome,
    RUST_LOG: "error",
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function trustedOpenAiAuthUrl(value: unknown): string | null {
  const raw = boundedString(value, 8_192);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const trusted = host === "openai.com"
    || host.endsWith(".openai.com")
    || host === "chatgpt.com"
    || host.endsWith(".chatgpt.com");
  return trusted ? url.toString() : null;
}

type AppServerRequestId = string | number;

function isAppServerRequestId(value: unknown): value is AppServerRequestId {
  return (typeof value === "number" && Number.isInteger(value))
    || (typeof value === "string" && value.length <= 512);
}

function blankStatus(runtime: CodexSubscriptionStatus["runtime"]): CodexSubscriptionStatus {
  return { ...CODEX_SUBSCRIPTION_SIGNED_OUT_STATUS, runtime };
}

/**
 * Main-process adapter for the stable App Server account APIs.
 *
 * The server owns browser callbacks, credential persistence, and token refresh.
 * This client intentionally never reads Codex auth files or token values.
 */
export class CodexAppServerClient {
  private readonly openExternal: (url: string) => Promise<void> | void;
  private readonly resolveExecutable: () => string;
  private readonly spawn: SpawnAppServer;
  private readonly clientVersion: string;
  private readonly runtimeHome: string;
  private readonly sqliteHome: string;
  private readonly workspaceDir: string;
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private accountStatus: CodexSubscriptionStatus = blankStatus("ready");
  private pendingLogin: PendingLogin | null = null;
  private completedLoginError: CodexAppServerErrorCode | null = null;

  private loginLock: Promise<void> = Promise.resolve();
  constructor(options: CodexAppServerClientOptions) {
    this.openExternal = options.openExternal;
    this.resolveExecutable = options.resolveExecutable ?? resolveBundledCodexExecutable;
    this.spawn = options.spawn ?? spawnPackagedCodex;
    this.clientVersion = options.clientVersion ?? getLvisAppVersion();
    this.runtimeHome = options.runtimeHome;
    this.sqliteHome = options.sqliteHome;
    this.workspaceDir = options.workspaceDir;
  }

  async getStatus(): Promise<CodexSubscriptionStatus> {
    await this.ensureStarted();
    const result = await this.request("account/read", { refreshToken: false });
    this.accountStatus = this.projectAccountStatus(result);
    if (this.accountStatus.connection === "connected") {
      this.pendingLogin = null;
      this.completedLoginError = null;
    }
    const completedLoginError = this.completedLoginError;
    if (completedLoginError) {
      this.completedLoginError = null;
      throw new CodexAppServerError(completedLoginError);
    }
    return this.currentStatus();
  }

  /** Returns the in-memory projection only; it never causes token refresh. */
  getCachedStatus(): CodexSubscriptionStatus {
    return this.currentStatus();
  }

  async startBrowserLogin(): Promise<CodexSubscriptionStatus> {
    return this.withLoginLock(async () => {
      await this.ensureStarted();
      this.assertNoPendingLogin();
      this.completedLoginError = null;
      const result = await this.request("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      });
      const response = isRecord(result) ? result : null;
      const loginId = boundedString(response?.loginId, 128);
      const authUrl = trustedOpenAiAuthUrl(response?.authUrl);
      if (response?.type !== "chatgpt" || !loginId || !authUrl) {
        throw new CodexAppServerError("codex-login-failed");
      }
      this.pendingLogin = { loginId, method: "browser", deviceCode: null };
      try {
        await this.openExternal(authUrl);
      } catch {
        await this.cancelPendingLoginQuietly(loginId);
        throw new CodexAppServerError("codex-login-failed");
      }
      return this.currentStatus();
    });
  }

  async startDeviceCodeLogin(): Promise<{ status: CodexSubscriptionStatus; userCode: string }> {
    return this.withLoginLock(async () => {
      await this.ensureStarted();
      this.assertNoPendingLogin();
      this.completedLoginError = null;
      const result = await this.request("account/login/start", {
        type: "chatgptDeviceCode",
      });
      const response = isRecord(result) ? result : null;
      const loginId = boundedString(response?.loginId, 128);
      const verificationUrl = trustedOpenAiAuthUrl(response?.verificationUrl);
      const userCode = boundedString(response?.userCode, MAX_DEVICE_CODE_LENGTH);
      if (response?.type !== "chatgptDeviceCode" || !loginId || !verificationUrl || !userCode) {
        throw new CodexAppServerError("codex-login-failed");
      }
      this.pendingLogin = { loginId, method: "device-code", deviceCode: userCode };
      try {
        await this.openExternal(verificationUrl);
      } catch {
        await this.cancelPendingLoginQuietly(loginId);
        throw new CodexAppServerError("codex-login-failed");
      }
      return { status: this.currentStatus(), userCode };
    });
  }

  async cancelLogin(): Promise<CodexSubscriptionStatus> {
    return this.withLoginLock(async () => {
      await this.ensureStarted();
      const pending = this.pendingLogin;
      if (!pending) return this.getStatus();
      try {
        await this.request("account/login/cancel", { loginId: pending.loginId });
      } finally {
        if (this.pendingLogin?.loginId === pending.loginId) this.pendingLogin = null;
      }
      return this.currentStatus();
    });
  }

  async logout(): Promise<CodexSubscriptionStatus> {
    return this.withLoginLock(async () => {
      await this.ensureStarted();
      // Do not leave an abandoned login attempt blocking future sign-ins when
      // the server rejects logout. The account projection remains unchanged
      // until the parameterless logout request succeeds.
      this.pendingLogin = null;
      this.completedLoginError = null;
      await this.request("account/logout");
      this.accountStatus = blankStatus("ready");
      return this.currentStatus();
    });
  }
  async listModels(): Promise<{
    status: CodexSubscriptionStatus;
    models: CodexSubscriptionModel[];
  }> {
    const status = await this.getStatus();
    if (status.connection !== "connected") return { status, models: [] };
    const result = await this.request("model/list", {
      limit: MAX_MODEL_COUNT,
      includeHidden: false,
    });
    const rows = isRecord(result) && Array.isArray(result.data) ? result.data : [];
    const seen = new Set<string>();
    const models: CodexSubscriptionModel[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = boundedString(row.id ?? row.model, MAX_MODEL_ID_LENGTH);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const displayName = boundedString(row.displayName, MAX_MODEL_ID_LENGTH) ?? id;
      const inputModalities = Array.isArray(row.inputModalities)
        ? row.inputModalities
          .map((item) => boundedString(item, 40))
          .filter((item): item is string => item !== null)
          .slice(0, 8)
        : ["text", "image"];
      models.push({
        id,
        displayName,
        isDefault: row.isDefault === true,
        inputModalities,
      });
      if (models.length >= MAX_MODEL_COUNT) break;
    }
    return { status, models };
  }

  stop(): void {
    this.abortTransport(new CodexAppServerError("codex-operation-failed"));
  }

  private currentStatus(): CodexSubscriptionStatus {
    const pendingLogin = this.pendingLogin?.method ?? null;
    const pendingDeviceCode = pendingLogin === "device-code"
      ? this.pendingLogin?.deviceCode ?? null
      : null;
    const connection: CodexSubscriptionConnectionState = this.accountStatus.connection === "connected"
      ? "connected"
      : pendingLogin
        ? "pending"
        : "signed-out";
    return {
      runtime: this.accountStatus.runtime,
      connection,
      planType: connection === "connected" ? this.accountStatus.planType : null,
      pendingLogin,
      pendingDeviceCode,
    };
  }

  private projectAccountStatus(result: unknown): CodexSubscriptionStatus {
    const root = isRecord(result) ? result : null;
    const account = root && isRecord(root.account) ? root.account : null;
    if (account?.type === "chatgpt") {
      return {
        runtime: "ready",
        connection: "connected",
        planType: boundedString(account.planType, MAX_PLAN_TYPE_LENGTH),
        pendingLogin: null,
        pendingDeviceCode: null,
      };
    }
    return blankStatus("ready");
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = null;
        this.closeTransport(error instanceof CodexAppServerError
          ? error
          : new CodexAppServerError("codex-runtime-start-failed"));
        throw error;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    let executable: string;
    try {
      executable = this.resolveExecutable();
    } catch (error) {
      if (error instanceof CodexAppServerError) throw error;
      throw new CodexAppServerError("codex-runtime-unavailable");
    }

    // Parent IPC owns secure namespace creation; validate the ready paths here
    // before passing them to the third-party runtime.
    const runtimeHome = validateRuntimeDirectory(this.runtimeHome);
    const sqliteHome = validateRuntimeDirectory(this.sqliteHome);
    const workspaceDir = validateRuntimeDirectory(this.workspaceDir);
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
          env: sanitizedCodexEnvironment(runtimeHome, sqliteHome),
        },
      );
    } catch {
      throw new CodexAppServerError("codex-runtime-start-failed");
    }
    if (!child.stdin || !child.stdout) {
      try {
        child.kill();
      } catch {
        // The start failure is the user-facing result.
      }
      throw new CodexAppServerError("codex-runtime-start-failed");
    }

    this.child = child;
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    const abort = (code: CodexAppServerErrorCode): void => {
      this.abortTransport(new CodexAppServerError(code), child);
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (this.child === child) this.consumeStdout(chunk, child);
    });
    child.stdout.once("error", () => abort("codex-operation-failed"));
    child.stdin.once("error", () => abort("codex-operation-failed"));
    // Drain stderr so a broken runtime cannot block on a full pipe. Its content
    // may contain sensitive login context, so it is intentionally not logged.
    child.stderr?.on("data", () => {});
    child.stderr?.once("error", () => abort("codex-operation-failed"));
    child.once("error", () => abort("codex-runtime-start-failed"));
    child.once("exit", () => abort("codex-operation-failed"));

    try {
      // The App Server expects initialized immediately after initialize (the
      // official quickstart sends both messages back-to-back).
      const initialized = this.request("initialize", {
        clientInfo: {
          name: "lvis",
          title: "LVIS",
          version: this.clientVersion,
        },
      });
      this.notify("initialized", {});
      await initialized;
      this.accountStatus = blankStatus("ready");
    } catch {
      const error = new CodexAppServerError("codex-runtime-start-failed");
      this.abortTransport(error, child);
      throw error;
    }
  }

  private async withLoginLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.loginLock;
    let release: () => void = () => {};
    this.loginLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
  private assertNoPendingLogin(): void {
    if (this.pendingLogin) {
      throw new CodexAppServerError("codex-login-in-progress");
    }
  }

  private async cancelPendingLoginQuietly(loginId: string): Promise<void> {
    try {
      await this.request("account/login/cancel", { loginId });
    } catch {
      // Browser launch already failed. Avoid leaking a secondary transport error.
    } finally {
      if (this.pendingLogin?.loginId === loginId) this.pendingLogin = null;
    }
  }

  private request(method: string, params?: JsonRecord): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) {
      return Promise.reject(new CodexAppServerError("codex-operation-failed"));
    }
    const stdin = child.stdin;
    const id = this.nextRequestId++;
    const payload = JSON.stringify({
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_LINE_BYTES) {
      return Promise.reject(new CodexAppServerError("codex-operation-failed"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingRequests.has(id)) return;
        this.abortTransport(new CodexAppServerError("codex-operation-failed"), child);
      }, RPC_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        stdin.write(`${payload}\n`);
      } catch {
        this.abortTransport(new CodexAppServerError("codex-operation-failed"), child);
      }
    });
  }

  private notify(method: string, params?: JsonRecord): void {
    const child = this.child;
    if (!child?.stdin || !child.stdin.writable) return;
    const payload = JSON.stringify({
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_LINE_BYTES) return;
    try {
      child.stdin.write(`${payload}\n`);
    } catch {
      this.abortTransport(new CodexAppServerError("codex-operation-failed"), child);
    }
  }

  private consumeStdout(chunk: Buffer | string, child: ChildProcess): void {
    const text = typeof chunk === "string"
      ? chunk
      : this.stdoutDecoder.write(chunk);
    this.stdoutBuffer += text;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_RPC_LINE_BYTES) {
      this.abortTransport(new CodexAppServerError("codex-operation-failed"), child);
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
        this.abortTransport(new CodexAppServerError("codex-operation-failed"), child);
        return;
      }
      this.handleMessage(message, child);
    }
  }

  private handleMessage(message: unknown, child: ChildProcess): void {
    if (!isRecord(message)) {
      this.abortTransport(new CodexAppServerError("codex-operation-failed"), child);
      return;
    }
    if (isAppServerRequestId(message.id) && typeof message.method === "string") {
      // This integration never enables external-token auth or experimental host
      // tools. Decline unexpected server requests rather than inventing a
      // privileged fallback path.
      this.notifyServerRequestError(message.id, child);
      return;
    }
    if (typeof message.id === "number" && Number.isInteger(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new CodexAppServerError("codex-operation-failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    this.handleNotification(message.method, message.params);
  }

  private notifyServerRequestError(id: AppServerRequestId, child: ChildProcess): void {
    if (this.child !== child || !child.stdin || !child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify({
        id,
        error: { code: -32601, message: "Unsupported request" },
      })}\n`);
    } catch {
      this.abortTransport(new CodexAppServerError("codex-operation-failed"), child);
    }
  }
  private handleNotification(method: string, params: unknown): void {
    const payload = isRecord(params) ? params : null;
    if (method === "account/updated" && payload) {
      if (payload.authMode === "chatgpt") {
        this.pendingLogin = null;
        this.completedLoginError = null;
        this.accountStatus = {
          runtime: "ready",
          connection: "connected",
          planType: boundedString(payload.planType, MAX_PLAN_TYPE_LENGTH),
          pendingLogin: null,
          pendingDeviceCode: null,
        };
      } else {
        this.pendingLogin = null;
        this.accountStatus = blankStatus("ready");
      }
      return;
    }
    if (method === "account/login/completed" && payload) {
      const loginId = boundedString(payload.loginId, 128);
      if (loginId && this.pendingLogin?.loginId === loginId && payload.success !== true) {
        this.pendingLogin = null;
        this.completedLoginError = "codex-login-failed";
      }
    }
  }

  private abortTransport(
    error: CodexAppServerError,
    expectedChild?: ChildProcess,
  ): void {
    const child = this.child;
    if (expectedChild && child !== expectedChild) return;
    this.closeTransport(error, child);
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Managed-child-processes still owns process-tree cleanup at shutdown.
      }
    }
  }

  private closeTransport(
    error: CodexAppServerError,
    expectedChild?: ChildProcess | null,
  ): void {
    if (expectedChild && this.child !== expectedChild) return;
    this.child = null;
    this.startPromise = null;
    this.stdoutBuffer = "";
    this.pendingLogin = null;
    this.accountStatus = blankStatus("ready");
    this.completedLoginError = null;
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
