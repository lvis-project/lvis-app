/**
 * Main-process connection manager for an explicitly approved Claude Code CLI.
 *
 * Credentials stay in the official CLI home under a LVIS-owned CLAUDE_CONFIG_DIR.
 * This module never reads token files. It only runs the approved executable for
 * version probes, auth status, browser login, logout, and isolation verification.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  loggedIn?: unknown;
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
    const executable = await this.resolveExecutable(pickerPath);
    this.verifiedVersion = null;
    this.executablePath = executable;
    if (this.configStore) await this.configStore.setExecutable(executable);
    return unverifiedStatus("unknown");
  }

  async clearExecutable(): Promise<ClaudeCodeSubscriptionStatus> {
    await this.cancelLoginQuietly();
    this.verifiedVersion = null;
    this.executablePath = null;
    if (this.configStore) await this.configStore.clearExecutable();
    return configuredStatus();
  }

  async verify(): Promise<ClaudeCodeSubscriptionStatus> {
    const executable = this.requireExecutable();
    const version = await this.probeVersion(executable);
    this.verifiedVersion = version;
    const auth = await this.readAuthStatus();
    if (auth.loggedIn !== true) {
      return claudeCodeSubscriptionStatus("ready", "signed-out", version);
    }
    await this.probePrint(executable);
    return claudeCodeSubscriptionStatus("ready", "connected", version);
  }

  async startBrowserLogin(): Promise<ClaudeCodeSubscriptionStatus> {
    const executable = this.requireExecutable();
    if (this.pendingLogin) {
      throw new ClaudeCodeSubscriptionError("claude-code-login-in-progress");
    }
    const child = this.spawn(executable, ["auth", "login", "--claudeai"], {
      cwd: this.workspaceDir,
      env: sanitizedClaudeCodeEnvironment(this.runtimeHome, process.env, this.platform, this.runtimeTempDir),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      void this.cancelLoginQuietly();
    }, LOGIN_TIMEOUT_MS);
    this.pendingLogin = { child, timer };
    child.once("exit", () => {
      if (this.pendingLogin?.child === child) {
        clearTimeout(this.pendingLogin.timer);
        this.pendingLogin = null;
      }
    });
    child.once("error", () => {
      if (this.pendingLogin?.child === child) {
        clearTimeout(this.pendingLogin.timer);
        this.pendingLogin = null;
      }
    });
    // Drain output without retaining secrets or URLs beyond a short trusted open.
    this.watchLoginOutput(child);
    return claudeCodeSubscriptionStatus("ready", "pending", this.verifiedVersion, "browser");
  }

  async cancelLogin(): Promise<ClaudeCodeSubscriptionStatus> {
    await this.cancelLoginQuietly();
    return this.getStatus();
  }

  async logout(): Promise<ClaudeCodeSubscriptionStatus> {
    const executable = this.requireExecutable();
    await this.cancelLoginQuietly();
    await this.runCaptured(executable, ["auth", "logout"], PROBE_TIMEOUT_MS);
    this.verifiedVersion = null;
    return claudeCodeSubscriptionStatus("unverified", "signed-out");
  }

  async stop(): Promise<void> {
    await this.cancelLoginQuietly();
  }

  private requireExecutable(): string {
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
      forceKillManagedChildProcess(pending.child);
    } catch {
      // Best-effort cancellation only.
    }
  }

  private watchLoginOutput(child: ChildProcess): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const consume = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (buffer.length > MAX_OUTPUT_BYTES) buffer = buffer.slice(-MAX_OUTPUT_BYTES);
      const match = buffer.match(/https:\/\/[^\s"']+/i);
      if (!match || !this.openExternal) return;
      let url: URL;
      try {
        url = new URL(match[0]);
      } catch {
        return;
      }
      const host = url.hostname.toLowerCase();
      const trusted = host === "claude.ai"
        || host.endsWith(".claude.ai")
        || host === "anthropic.com"
        || host.endsWith(".anthropic.com")
        || host === "console.anthropic.com"
        || host === "platform.claude.com";
      if (!trusted || url.protocol !== "https:") return;
      void Promise.resolve(this.openExternal(url.toString())).catch(() => undefined);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
  }

  private async readAuthStatus(): Promise<AuthStatusPayload> {
    const executable = this.requireExecutable();
    const output = await this.runCaptured(executable, ["auth", "status"], PROBE_TIMEOUT_MS);
    try {
      const parsed: unknown = JSON.parse(output);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as AuthStatusPayload
        : {};
    } catch {
      throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    }
  }

  private async probeVersion(executable: string): Promise<string> {
    const output = await this.runCaptured(executable, ["--version"], PROBE_TIMEOUT_MS);
    const version = safeVersion(output);
    if (!version) throw new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable");
    return version;
  }

  private async probePrint(executable: string): Promise<void> {
    // Isolation proof only: one short text turn with every native tool denied.
    await this.runCaptured(
      executable,
      [
        "-p",
        "Reply with exactly: LVIS_OK",
        "--output-format",
        "text",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        await this.writeEmptyMcpConfig(),
      ],
      PROBE_TIMEOUT_MS,
    );
  }

  private async writeEmptyMcpConfig(): Promise<string> {
    const path = join(this.runtimeTempDir, "empty-mcp.json");
    await fs.mkdir(this.runtimeTempDir, { recursive: true, mode: 0o700 });
    await writeFileAtomicAtPath(path, `${JSON.stringify({ mcpServers: {} })}\n`);
    return path;
  }

  private async runCaptured(
    executable: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ): Promise<string> {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let settled = false;
      let outputBytes = 0;
      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const child = this.spawn(executable, args, {
        cwd: this.workspaceDir,
        env: sanitizedClaudeCodeEnvironment(this.runtimeHome, process.env, this.platform, this.runtimeTempDir),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        finish(() => rejectPromise(new ClaudeCodeSubscriptionError("claude-code-operation-failed")));
        try {
          forceKillManagedChildProcess(child);
        } catch {
          // Ignore kill races.
        }
      }, timeoutMs);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
        const text = typeof chunk === "string"
          ? chunk
          : (target === "stdout" ? stdoutDecoder : stderrDecoder).write(chunk);
        outputBytes += Buffer.byteLength(text, "utf8");
        if (outputBytes > MAX_OUTPUT_BYTES) {
          finish(() => rejectPromise(new ClaudeCodeSubscriptionError("claude-code-operation-failed")));
          try {
            forceKillManagedChildProcess(child);
          } catch {
            // Ignore kill races.
          }
          return;
        }
        if (target === "stdout") stdout += text;
        else stderr += text;
      };
      child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
      child.once("error", () => {
        finish(() => rejectPromise(new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable")));
      });
      child.once("exit", (code) => {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (code === 0) {
          finish(() => resolvePromise(stdout || stderr));
          return;
        }
        finish(() => rejectPromise(new ClaudeCodeSubscriptionError("claude-code-operation-failed")));
      });
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
