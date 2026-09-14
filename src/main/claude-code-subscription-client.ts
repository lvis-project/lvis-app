/**
 * Main-process connection manager for an explicitly approved Claude Code CLI.
 *
 * Credentials stay in the official CLI home under a LVIS-owned CLAUDE_CONFIG_DIR.
 * This module never reads token files. It only runs the approved executable for
 * version probes, auth status, browser login, logout, and isolation verification.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import { JsonLineReader } from "../lib/json-line-reader.js";
import { isRecord } from "../shared/is-record.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { claudeCodePrintArgs, ClaudeCodeStream } from "./claude-code-stream.js";
import {
  CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID,
  claudeCodeSubscriptionStatus,
  type ClaudeCodeSubscriptionErrorCode,
  type ClaudeCodeSubscriptionStatus,
} from "../shared/claude-code-subscription.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import {
  openFeatureNamespace,
  readJsonFile,
  type FeatureNamespaceHandle,
  writeFileAtomicAtPath,
  writeJsonAtomic,
} from "./storage/feature-namespace.js";

const CONFIG_FILE = "config.json";
const CONFIG_VERSION = 1;
const PROBE_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const MAX_EXECUTABLE_PATH_LENGTH = 4_096;
const MAX_VERSION_LENGTH = 80;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type SpawnClaude = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export class ClaudeCodeSubscriptionError extends Error {
  constructor(readonly code: ClaudeCodeSubscriptionErrorCode) {
    super(code);
    this.name = "ClaudeCodeSubscriptionError";
  }
}

export interface ClaudeCodeSubscriptionClientOptions {
  /** Existing app-owned isolated data root for this runtime only. */
  runtimeHome: string;
  /** Existing blank app-owned workspace. Never bind a real project here. */
  workspaceDir: string;
  /** Existing app-owned temporary directory. */
  runtimeTempDir?: string;
  /** A previously main-approved absolute executable path, if one exists. */
  executablePath?: string | null;
  /** Opens a trusted login page only when the CLI prints one. */
  openExternal?: (url: string) => Promise<void> | void;
  /** Test seam; production uses the managed-child registry. */
  spawn?: SpawnClaude;
  /** Test seam for filesystem-based executable validation. */
  resolveExecutable?: (candidate: string) => Promise<string>;
  platform?: NodeJS.Platform;
  configStore?: ClaudeCodeSubscriptionConfigStore;
}

interface PendingLogin {
  child: ChildProcess;
  timer: NodeJS.Timeout;
}

interface AuthStatusPayload {
  loggedIn: boolean;
}

export async function validateClaudeCodeRuntimeDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    try {
      if (!isAbsolute(directory) || CONTROL_CHARACTERS.test(directory)) throw new Error("invalid-directory");
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid-directory");
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable");
    }
  }
}

function configuredStatus(): ClaudeCodeSubscriptionStatus {
  return claudeCodeSubscriptionStatus("not-configured", "unknown");
}

function unverifiedStatus(
  connection: ClaudeCodeSubscriptionStatus["connection"] = "unknown",
  version: string | null = null,
): ClaudeCodeSubscriptionStatus {
  return claudeCodeSubscriptionStatus("unverified", connection, version);
}

function unavailableStatus(): ClaudeCodeSubscriptionStatus {
  return claudeCodeSubscriptionStatus("unavailable", "unknown");
}

function safeVersion(value: string): string | null {
  const match = value.match(/\bv?\d+(?:\.\d+){1,4}(?:[-+][0-9a-z.-]+)?\b/i);
  if (!match) return null;
  const version = match[0];
  return version.length <= MAX_VERSION_LENGTH && !CONTROL_CHARACTERS.test(version)
    ? version
    : null;
}

function blocksInheritedEnvironment(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.startsWith("ANTHROPIC_")
    || normalized.startsWith("CLAUDE_")
    || normalized.startsWith("OPENAI_")
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
    || normalized.startsWith("LD_")
    || normalized.startsWith("DYLD_");
}

const SAFE_INHERITED_ENV_NAMES = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
]);

function normalizedRuntimeDirectory(candidate: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.normalize(candidate) : resolve(candidate);
}

function unsafeWindowsPath(path: string): boolean {
  return path.startsWith("\\") || path.startsWith("\\?\\") || path.startsWith("\\.\\");
}

export async function resolveClaudeCodeSubscriptionExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const absolute = platform === "win32" ? win32.isAbsolute(candidate) : isAbsolute(candidate);
  if (
    !candidate
    || candidate.length > MAX_EXECUTABLE_PATH_LENGTH
    || CONTROL_CHARACTERS.test(candidate)
    || !absolute
    || (platform === "win32" && unsafeWindowsPath(candidate))
  ) {
    throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
  }
  try {
    const executable = await fs.realpath(candidate);
    const stat = await fs.stat(executable);
    if (!stat.isFile()) throw new Error("not-a-file");
    if (platform === "win32") {
      if (unsafeWindowsPath(executable) || !executable.toLocaleLowerCase().endsWith(".exe")) {
        throw new Error("not-a-native-windows-executable");
      }
    } else {
      await fs.access(executable, fsConstants.X_OK);
    }
    return executable;
  } catch {
    throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
  }
}

export function sanitizedClaudeCodeEnvironment(
  runtimeHome: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runtimeTempDir = join(runtimeHome, "tmp"),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (!value || blocksInheritedEnvironment(key)) continue;
    if (SAFE_INHERITED_ENV_NAMES.has(key) || SAFE_INHERITED_ENV_NAMES.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  const isolatedHome = normalizedRuntimeDirectory(runtimeHome, platform);
  const isolatedTemp = normalizedRuntimeDirectory(runtimeTempDir, platform);
  if (platform === "win32") {
    env.USERPROFILE = isolatedHome;
    env.HOME = isolatedHome;
    env.APPDATA = win32.join(isolatedHome, "appdata");
    env.LOCALAPPDATA = win32.join(isolatedHome, "localappdata");
  } else {
    env.HOME = isolatedHome;
    env.XDG_CONFIG_HOME = join(isolatedHome, "config");
    env.XDG_DATA_HOME = join(isolatedHome, "data");
    env.XDG_CACHE_HOME = join(isolatedHome, "cache");
  }
  env.TEMP = isolatedTemp;
  env.TMP = isolatedTemp;
  env.TMPDIR = isolatedTemp;
  // The official CLI stores auth and session transcripts under this directory.
  env.CLAUDE_CONFIG_DIR = isolatedHome;
  // The host supplies the complete MCP catalog and owns tool discovery.
  env.ENABLE_TOOL_SEARCH = "false";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}

interface ConfigDocument {
  version: number;
  executablePath: string | null;
}

export class ClaudeCodeSubscriptionConfigStore {
  private readonly root: FeatureNamespaceHandle;

  constructor(namespace?: FeatureNamespaceHandle) {
    this.root = namespace ?? openFeatureNamespace("subscription-runtimes");
  }

  static create(namespace?: FeatureNamespaceHandle): ClaudeCodeSubscriptionConfigStore {
    return new ClaudeCodeSubscriptionConfigStore(namespace);
  }

  async getExecutable(): Promise<string | null> {
    const document = await this.read();
    return document.executablePath;
  }

  async setExecutable(path: string): Promise<void> {
    await this.write({ version: CONFIG_VERSION, executablePath: path });
  }

  async clearExecutable(): Promise<void> {
    await this.write({ version: CONFIG_VERSION, executablePath: null });
  }

  private async read(): Promise<ConfigDocument> {
    const dir = await this.root.childDir("claude-code-config");
    const raw = await readJsonFile(join(dir, CONFIG_FILE), {
      version: CONFIG_VERSION,
      executablePath: null,
    });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { version: CONFIG_VERSION, executablePath: null };
    }
    const record = raw as Record<string, unknown>;
    const executablePath = typeof record.executablePath === "string" && record.executablePath
      ? record.executablePath
      : null;
    return { version: CONFIG_VERSION, executablePath };
  }

  private async write(document: ConfigDocument): Promise<void> {
    const dir = await this.root.childDir("claude-code-config");
    await writeJsonAtomic(dir, CONFIG_FILE, document);
  }
}

function spawnClaudeCode(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
): ChildProcess {
  return spawnManaged(command, args, options, { label: "claude-code-subscription" });
}

export class ClaudeCodeSubscriptionClient {
  private readonly runtimeHome: string;
  private readonly workspaceDir: string;
  private readonly runtimeTempDir: string;
  private readonly openExternal: ((url: string) => Promise<void> | void) | null;
  private readonly spawn: SpawnClaude;
  private readonly resolveExecutable: (candidate: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly configStore: ClaudeCodeSubscriptionConfigStore | null;
  private executablePath: string | null;
  private pendingLogin: PendingLogin | null = null;
  private verifiedVersion: string | null = null;
  private stopped = false;
  private epoch = 0;
  private loginStarting = false;
  private configuring = false;
  private readonly commands = new Set<() => void>();

  constructor(options: ClaudeCodeSubscriptionClientOptions) {
    this.runtimeHome = options.runtimeHome;
    this.workspaceDir = options.workspaceDir;
    this.runtimeTempDir = options.runtimeTempDir ?? join(options.runtimeHome, "tmp");
    this.openExternal = options.openExternal ?? null;
    this.spawn = options.spawn ?? spawnClaudeCode;
    this.resolveExecutable = options.resolveExecutable
      ?? ((candidate) => resolveClaudeCodeSubscriptionExecutable(candidate, options.platform));
    this.platform = options.platform ?? process.platform;
    this.configStore = options.configStore ?? null;
    this.executablePath = options.executablePath ?? null;
  }

  getConfiguredExecutable(): string | null {
    return this.executablePath;
  }

  getRuntimePaths(): {
    readonly runtimeHome: string;
    readonly workspaceDir: string;
    readonly runtimeTempDir: string;
  } {
    return Object.freeze({
      runtimeHome: this.runtimeHome,
      workspaceDir: this.workspaceDir,
      runtimeTempDir: this.runtimeTempDir,
    });
  }

  async getStatus(): Promise<ClaudeCodeSubscriptionStatus> {
    if (!this.executablePath) return configuredStatus();
    if (this.pendingLogin) {
      return claudeCodeSubscriptionStatus("ready", "pending", this.verifiedVersion, "browser");
    }
    try {
      const auth = await this.readAuthStatus();
      if (auth.loggedIn === true) {
        return claudeCodeSubscriptionStatus(
          this.verifiedVersion ? "ready" : "unverified",
          "connected",
          this.verifiedVersion,
        );
      }
      return claudeCodeSubscriptionStatus(
        this.verifiedVersion ? "ready" : "unverified",
        "signed-out",
        this.verifiedVersion,
      );
    } catch {
      return unavailableStatus();
    }
  }

  async setExecutable(pickerPath: string): Promise<ClaudeCodeSubscriptionStatus> {
    if (this.configuring) throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    this.configuring = true;
    try {
      const epoch = this.epoch;
      const executable = await this.resolveExecutable(pickerPath);
      this.assertCurrent(epoch);
      if (this.configStore) await this.configStore.setExecutable(executable);
      this.assertCurrent(epoch);
      await this.invalidateCommands();
      this.executablePath = executable;
      return unverifiedStatus("unknown");
    } finally { this.configuring = false; }
  }

  async clearExecutable(): Promise<ClaudeCodeSubscriptionStatus> {
    if (this.configuring) throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    this.configuring = true;
    try {
      const epoch = this.epoch;
      this.assertCurrent(epoch);
      if (this.configStore) await this.configStore.clearExecutable();
      this.assertCurrent(epoch);
      await this.invalidateCommands();
      this.executablePath = null;
      return configuredStatus();
    } finally { this.configuring = false; }
  }

  async verify(): Promise<ClaudeCodeSubscriptionStatus> {
    const epoch = this.epoch;
    const executable = this.requireExecutable();
    this.verifiedVersion = null;
    const version = await this.probeVersion(executable);
    const auth = await this.readAuthStatus();
    if (auth.loggedIn !== true) {
      this.assertCurrent(epoch);
      this.verifiedVersion = version;
      return claudeCodeSubscriptionStatus("ready", "signed-out", version);
    }
    await this.probePrint(executable);
    this.assertCurrent(epoch);
    this.verifiedVersion = version;
    return claudeCodeSubscriptionStatus("ready", "connected", version);
  }

  async startBrowserLogin(): Promise<ClaudeCodeSubscriptionStatus> {
    const executable = this.requireExecutable();
    if (this.pendingLogin || this.loginStarting) {
      throw new ClaudeCodeSubscriptionError("claude-code-login-in-progress");
    }
    const epoch = this.epoch;
    this.loginStarting = true;
    try {
      await this.prepareExecutable(executable, epoch);
      const child = this.spawn(executable, ["auth", "login"], {
        cwd: this.workspaceDir,
        env: sanitizedClaudeCodeEnvironment(this.runtimeHome, process.env, this.platform, this.runtimeTempDir),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
      });
      const timer = setTimeout(() => {
        void this.cancelLoginQuietly();
      }, LOGIN_TIMEOUT_MS);
      this.pendingLogin = { child, timer };
      timer.unref();
      child.once("close", () => {
        if (this.pendingLogin?.child === child) {
          clearTimeout(this.pendingLogin.timer);
          this.pendingLogin = null;
        }
      });
      const failLogin = () => { if (this.pendingLogin?.child === child) void this.cancelLoginQuietly(); };
      child.on("error", failLogin);
      child.stdout?.on("error", failLogin);
      child.stderr?.on("error", failLogin);
      // Drain output without retaining secrets or URLs beyond a short trusted open.
      this.watchLoginOutput(child);
      if (!child.stdout || !child.stderr) {
        await this.cancelLoginQuietly();
        throw new ClaudeCodeSubscriptionError("claude-code-login-failed");
      }
      return claudeCodeSubscriptionStatus("ready", "pending", this.verifiedVersion, "browser");
    } finally { this.loginStarting = false; }
  }

  async cancelLogin(): Promise<ClaudeCodeSubscriptionStatus> {
    await this.invalidateCommands();
    return this.getStatus();
  }

  async logout(): Promise<ClaudeCodeSubscriptionStatus> {
    const executable = this.requireExecutable();
    await this.invalidateCommands();
    await this.runCaptured(executable, ["auth", "logout"], PROBE_TIMEOUT_MS);
    this.verifiedVersion = null;
    return claudeCodeSubscriptionStatus("unverified", "signed-out");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.invalidateCommands();
  }

  private async invalidateCommands(): Promise<void> {
    this.epoch += 1;
    this.verifiedVersion = null;
    for (const cancel of this.commands) cancel();
    await this.cancelLoginQuietly();
  }

  private assertCurrent(epoch: number): void {
    if (this.stopped || this.epoch !== epoch) throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
  }

  private async prepareExecutable(executable: string, epoch: number): Promise<void> {
    await validateClaudeCodeRuntimeDirectories([this.runtimeHome, this.workspaceDir, this.runtimeTempDir]);
    if (await this.resolveExecutable(executable) !== executable) {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
    }
    this.assertCurrent(epoch);
  }

  private requireExecutable(): string {
    this.assertCurrent(this.epoch);
    if (this.configuring) throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    if (!this.executablePath) {
      throw new ClaudeCodeSubscriptionError("claude-code-runtime-not-configured");
    }
    return this.executablePath;
  }

  private async cancelLoginQuietly(): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) return;
    this.pendingLogin = null;
    clearTimeout(pending.timer);
    try {
      forceKillManagedChildProcess(pending.child, "claude-code-login-cancel");
    } catch {
      // Best-effort cancellation only.
    }
  }

  private watchLoginOutput(child: ChildProcess): void {
    let opened = false;
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      stream?.on("data", (chunk: Buffer | string) => {
        if (this.pendingLogin?.child !== child) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) { void this.cancelLoginQuietly(); return; }
        if (opened) return;
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        // Wait for a delimiter: a split URL must never open a partial address.
        if (!this.openExternal) return;
        for (const match of buffer.matchAll(/https:\/\/[^\s"'\u001b]+(?=[\s"'\u001b])/gi)) {
          let url: URL;
          try { url = new URL(match[0]); } catch { continue; }
          if (url.protocol !== "https:" || url.username || url.password || url.port
            || !["claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname.toLowerCase())) continue;
          opened = true;
          void Promise.resolve().then(() => {
            if (this.pendingLogin?.child === child) return this.openExternal?.(url.toString());
          }).catch(() => undefined);
          break;
        }
      });
    }
  }

  private async readAuthStatus(): Promise<AuthStatusPayload> {
    const executable = this.requireExecutable();
    const output = await this.runCaptured(executable, ["auth", "status"], PROBE_TIMEOUT_MS, { acceptedCodes: [0, 1] });
    try {
      const parsed: unknown = JSON.parse(output.stdout);
      if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean"
        || output.code !== (parsed.loggedIn ? 0 : 1)) throw new Error("invalid-auth-status");
      if (parsed.loggedIn && (parsed.authMethod !== "claude.ai" || parsed.apiProvider !== "firstParty"
        || typeof parsed.subscriptionType !== "string" || !parsed.subscriptionType.trim())) {
        throw new Error("subscription-auth-required");
      }
      return { loggedIn: parsed.loggedIn };
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    }
  }

  private async probeVersion(executable: string): Promise<string> {
    const output = await this.runCaptured(executable, ["--version"], PROBE_TIMEOUT_MS);
    const version = safeVersion(output.stdout);
    if (!version) throw new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable");
    return version;
  }

  private async probePrint(executable: string): Promise<void> {
    const path = join(this.runtimeTempDir, `verify-${randomUUID()}.json`);
    await validateClaudeCodeRuntimeDirectories([this.runtimeTempDir]);
    try {
      await writeFileAtomicAtPath(path, `${JSON.stringify({ mcpServers: {} })}\n`);
      const output = await this.runCaptured(executable, claudeCodePrintArgs(path, []),
        TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs, { input: "Reply with exactly: LVIS_OK" });
      const stream = new ClaudeCodeStream([]);
      let malformed = false;
      const reader = new JsonLineReader({
        maxLineBytes: MAX_OUTPUT_BYTES,
        onMessage: (event) => { stream.accept(event); },
        onError: () => { malformed = true; },
      });
      reader.write(output.stdout);
      reader.write("\n");
      reader.close();
      if (malformed) throw new Error("invalid-print-stream");
      stream.assertComplete();
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    } finally {
      await fs.rm(path, { force: true });
    }
  }

  private async runCaptured(
    executable: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    options: { input?: string; acceptedCodes?: readonly number[] } = {},
  ): Promise<{ stdout: string; code: number }> {
    const epoch = this.epoch;
    await this.prepareExecutable(executable, epoch);
    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let outputBytes = 0;
      let stdout = "";
      const stdoutDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const child = this.spawn(executable, args, {
        cwd: this.workspaceDir,
        env: sanitizedClaudeCodeEnvironment(this.runtimeHome, process.env, this.platform, this.runtimeTempDir),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
      });
      const timer = setTimeout(() => cancel(), timeoutMs);
      timer.unref();
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.commands.delete(cancel);
        callback();
      };
      const cancel = (code: ClaudeCodeSubscriptionErrorCode = "claude-code-operation-failed"): void => {
        if (settled) return;
        finish(() => rejectPromise(new ClaudeCodeSubscriptionError(code)));
        forceKillManagedChildProcess(child, "claude-code-command-cancel");
      };
      this.commands.add(cancel);
      const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          cancel();
          return;
        }
        // Never retain stderr or use it as a replacement protocol response.
        try {
          if (target === "stdout") stdout += typeof chunk === "string"
            ? chunk : stdoutDecoder.decode(chunk, { stream: true });
        } catch { cancel(); }
      };
      child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
      child.on("error", () => cancel("claude-code-runtime-unavailable"));
      child.stdout?.on("error", () => cancel());
      child.stderr?.on("error", () => cancel());
      child.stdin?.on("error", () => cancel());
      child.once("close", (code, signal) => {
        if (settled) return;
        try {
          stdout += stdoutDecoder.decode();
          this.assertCurrent(epoch);
          if (signal || code === null || !(options.acceptedCodes ?? [0]).includes(code)) {
            throw new Error("invalid-command-result");
          }
          finish(() => resolvePromise({ stdout, code }));
        } catch { cancel(); }
      });
      if (!child.stdout || !child.stderr || (options.input !== undefined && !child.stdin)) { cancel(); return; }
      if (options.input !== undefined) child.stdin!.end(options.input, (error?: Error | null) => { if (error) cancel(); });
    });
  }
}

export function claudeCodeRuntimeDirectoryNames(): {
  readonly runtimeHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
} {
  const prefix = `claude-cli-v1-${CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID}`;
  return Object.freeze({
    runtimeHome: `${prefix}-home`,
    workspaceDir: `${prefix}-workspace`,
    runtimeTempDir: `${prefix}-tmp`,
  });
}
