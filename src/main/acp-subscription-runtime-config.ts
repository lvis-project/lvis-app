/**
 * Main-owned configuration for explicitly approved ACP runtime executables.
 *
 * A configured executable is an execution grant, not a renderer setting. The
 * renderer never supplies a path; only the native file picker result reaches
 * this store. Paths are not credentials, but feature-namespace storage still
 * gives them the normal 0700 directory / 0600 atomic-write protection.
 */
import { constants as fsConstants, promises as fs } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { mainDir } from "./main-paths.js";
import type { AcpSubscriptionProviderId } from "../shared/acp-subscription.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
  writeFileAtomicAtPath,
} from "./storage/feature-namespace.js";

import { isPlainRecord } from "../shared/is-record.js";

const CONFIG_FILE = "config.json";
const CONFIG_VERSION = 1;
const MAX_EXECUTABLE_PATH_LENGTH = 4_096;
const MAX_NATIVE_POLICY_FILE_BYTES = 64 * 1024;
const MAX_MCP_SERVER_NAME_LENGTH = 128;
const MAX_MCP_SERVER_COMMAND_LENGTH = 4_096;
const MAX_MCP_SERVER_ARGS = 64;
const MAX_MCP_SERVER_ARG_LENGTH = 4_096;
const MAX_MCP_SERVER_ENV_ENTRIES = 32;
const MAX_MCP_SERVER_ENV_NAME_LENGTH = 128;
const MAX_MCP_SERVER_ENV_VALUE_LENGTH = 8_192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MCP_SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const MCP_SERVER_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_MCP_ENV_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** Increment when changing a native-runtime policy that must not reuse old homes. */
export const ACP_SUBSCRIPTION_RUNTIME_POLICY_VERSION = 8;
const NATIVE_POLICY_MARKER = `# lvis-acp-native-policy-v${ACP_SUBSCRIPTION_RUNTIME_POLICY_VERSION}`;
const EMPTY_ACP_SUBSCRIPTION_MCP_SERVERS: readonly AcpSubscriptionMcpServerConfig[] = Object.freeze([]);
export const GROK_BUILD_REQUIRED_MINIMUM_VERSION = "0.2.116";
export const GROK_BUILD_GOVERNED_AGENT_FILE_NAME = "lvis-governed-chat.md";
/**
 * A nonempty MCP-classified entry makes Grok Build 0.2.116 strip native
 * default tools while retaining MCP schemas registered after session creation.
 * It is deliberately a sentinel, not a static LVIS tool schema: bridge tools
 * are selected dynamically for each governed turn.
 */
export const GROK_BUILD_MCP_TOOLSET_SENTINEL = "mcp__lvis-host-tools__workspace_read";


/**
 * One source of truth for Grok's ACP and native agent-profile policies.
 * It intentionally does not select a model: account entitlement and Grok's
 * own catalog remain authoritative, while the LVIS tool boundary is fixed.
 */
export const GROK_BUILD_GOVERNED_AGENT_PROFILE = Object.freeze({
  name: "lvis-governed-chat",
  description: "LVIS governed subscription chat; use only the supplied LVIS MCP bridge.",
  promptMode: "full",
  promptBody: "Use only the LVIS host MCP bridge. Do not use native tools, external MCP servers, subagents, skills, project instructions, or web tools.",
  tools: Object.freeze([GROK_BUILD_MCP_TOOLSET_SENTINEL] as const),
  permissionMode: "dontAsk",
  agentsMd: false,
  discoverSkills: false,
  inheritSkills: false,
  injectDefaultTools: false,
  mcpInheritance: "none",
  skills: Object.freeze([] as const),
});

/** Absolute app-owned path passed through GROK_AGENT, never renderer input. */
export function grokBuildGovernedAgentDefinitionPath(
  runtimeHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? win32.join(runtimeHome, GROK_BUILD_GOVERNED_AGENT_FILE_NAME)
    : join(runtimeHome, GROK_BUILD_GOVERNED_AGENT_FILE_NAME);
}

const GROK_NATIVE_AGENT_PROFILE = [
  "---",
  `name: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.name}`,
  `description: ${JSON.stringify(GROK_BUILD_GOVERNED_AGENT_PROFILE.description)}`,
  `promptMode: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.promptMode}`,
  `permissionMode: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.permissionMode}`,
  `agentsMd: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.agentsMd}`,
  `discoverSkills: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.discoverSkills}`,
  `inheritSkills: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.inheritSkills}`,
  `injectDefaultTools: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.injectDefaultTools}`,
  "tools:",
  ...GROK_BUILD_GOVERNED_AGENT_PROFILE.tools.map((tool) => `  - ${tool}`),
  `mcpInheritance: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.mcpInheritance}`,
  "skills: []",
  "---",
  GROK_BUILD_GOVERNED_AGENT_PROFILE.promptBody,
  "",
].join("\n");


/**
 * The one stdio MCP server LVIS may hand to an ACP subscription runtime.
 *
 * This descriptor is main-process-only: it is never persisted, exposed through
 * IPC, or accepted from a renderer/session prompt. The validator copies only
 * these four fields so a third-party ACP runtime cannot gain arbitrary launch
 * options such as a cwd, transport URL, inherited environment, or extra server.
 */
export interface AcpSubscriptionMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  return keys.length === expected.length && keys.every((key) => (
    typeof key === "string"
    && expected.includes(key)
    && Object.prototype.propertyIsEnumerable.call(record, key)
  ));
}

function boundedMcpString(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > maxLength || CONTROL_CHARACTERS.test(value)) return null;
  if (!allowEmpty && !value) return null;
  return value;
}

function validatedMcpArgs(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVER_ARGS || Reflect.ownKeys(value).length !== value.length + 1) {
    return null;
  }
  const args: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    const arg = boundedMcpString(descriptor.value, MAX_MCP_SERVER_ARG_LENGTH, true);
    if (arg === null) return null;
    args.push(arg);
  }
  return Object.freeze(args);
}

function validatedMcpEnvironment(value: unknown): Readonly<Record<string, string>> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_MCP_SERVER_ENV_ENTRIES || keys.some((key) => typeof key !== "string")) return null;
  const env = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (
      typeof key !== "string"
      || key.length > MAX_MCP_SERVER_ENV_NAME_LENGTH
      || RESERVED_MCP_ENV_NAMES.has(key)
      || !MCP_SERVER_ENV_NAME.test(key)
    ) return null;
    const envValue = boundedMcpString(
      ownValue(value, key),
      MAX_MCP_SERVER_ENV_VALUE_LENGTH,
      true,
    );
    if (envValue === null) return null;
    Object.defineProperty(env, key, {
      configurable: false,
      enumerable: true,
      value: envValue,
      writable: false,
    });
  }
  return Object.freeze(env);
}

/**
 * Validate and copy the sole LVIS-owned ACP MCP launch descriptor.
 *
 * Callers outside the main-process assembly cannot inject an additional
 * server or a broader ACP launch shape: unknown fields and non-stdio inputs
 * are rejected instead of being forwarded to `session/new`.
 */
export function validateAcpSubscriptionMcpServerConfig(
  value: unknown,
): AcpSubscriptionMcpServerConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["name", "command", "args", "env"])) {
    throw new Error("invalid-acp-subscription-mcp-server-config");
  }
  const name = boundedMcpString(ownValue(value, "name"), MAX_MCP_SERVER_NAME_LENGTH);
  const command = boundedMcpString(ownValue(value, "command"), MAX_MCP_SERVER_COMMAND_LENGTH);
  const args = validatedMcpArgs(ownValue(value, "args"));
  const env = validatedMcpEnvironment(ownValue(value, "env"));
  if (
    !name
    || !MCP_SERVER_NAME.test(name)
    || !command
    || !isAbsolute(command)
    || !args
    || !env
  ) {
    throw new Error("invalid-acp-subscription-mcp-server-config");
  }
  return Object.freeze({ name, command, args, env });
}

/**
 * Accept zero or exactly one LVIS-owned descriptor for an ACP session. A
 * per-session bridge is intentionally explicit, so an ACP runtime can never
 * inherit user/global MCP configuration or add a second launch target.
 */
export function validateAcpSubscriptionMcpServerConfigs(
  value: unknown,
): readonly AcpSubscriptionMcpServerConfig[] {
  if (value === undefined) return EMPTY_ACP_SUBSCRIPTION_MCP_SERVERS;
  if (
    !Array.isArray(value)
    || value.length > 1
    || Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new Error("invalid-acp-subscription-mcp-server-config");
  }
  if (value.length === 0) return EMPTY_ACP_SUBSCRIPTION_MCP_SERVERS;
  return Object.freeze([validateAcpSubscriptionMcpServerConfig(value[0])]);
}

export interface AcpSubscriptionRuntimeDirectoryNames {
  readonly runtimeHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
}

/** Static directory names; renderer input can never influence any path segment. */
export function acpSubscriptionRuntimeDirectoryNames(
  provider: AcpSubscriptionProviderId,
): AcpSubscriptionRuntimeDirectoryNames {
  const prefix = `acp-v${ACP_SUBSCRIPTION_RUNTIME_POLICY_VERSION}-${provider}`;
  return Object.freeze({
    runtimeHome: `${prefix}-home`,
    workspaceDir: `${prefix}-workspace`,
    runtimeTempDir: `${prefix}-tmp`,
  });
}

type AcpSubscriptionRuntimePolicyErrorCode =
  | "acp-runtime-policy-invalid-home"
  | "acp-runtime-policy-unverified";

/** Stable local-policy failure only; no third-party runtime output is exposed. */
class AcpSubscriptionRuntimePolicyError extends Error {
  constructor(readonly code: AcpSubscriptionRuntimePolicyErrorCode) {
    super(code);
    this.name = "AcpSubscriptionRuntimePolicyError";
  }
}

export interface AcpSubscriptionNativePolicyFiles {
  readonly configToml?: string;
  readonly tuiToml?: string;
  readonly requirementsToml?: string;
  readonly agentProfileMd?: string;
}

export function acpSubscriptionNativePolicyFiles(
  provider: AcpSubscriptionProviderId,
  runtimeHome: string,
): AcpSubscriptionNativePolicyFiles {
  return provider === "kimi-code"
    ? Object.freeze({ configToml: join(runtimeHome, "config.toml"), tuiToml: join(runtimeHome, "tui.toml") })
    : Object.freeze({
      configToml: join(runtimeHome, "config.toml"),
      requirementsToml: join(runtimeHome, "requirements.toml"),
      agentProfileMd: grokBuildGovernedAgentDefinitionPath(runtimeHome),
    });
}

const KIMI_NATIVE_CONFIG = `${NATIVE_POLICY_MARKER}
default_permission_mode = "manual"
default_plan_mode = false
merge_all_available_skills = false
telemetry = false

[tools]
enabled = ["mcp__lvis-host-tools__*"]

[[permission.rules]]
decision = "allow"
pattern = "mcp__lvis-host-tools__*"

[background]
keep_alive_on_exit = false
bash_auto_background_on_timeout = false

[thinking]
enabled = false

[loop_control]
max_steps_per_turn = 1
`;

const KIMI_TUI_POLICY = `${NATIVE_POLICY_MARKER}
[upgrade]
auto_install = false
`;

const GROK_PRE_TOOL_POLICY_ENTRYPOINT = "subscription-grok-tool-policy-hook.js";

/** Quote one absolute executable/script path for the runtime's native shell. */
function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Grok executes config hooks through a shell, so both host-owned paths must
 * remain quoted. `ELECTRON_RUN_AS_NODE` is supplied by the hook entry itself
 * rather than inherited from the third-party ACP process.
 */
function grokPreToolPolicyCommand(): string {
  return `${shellQuote(process.execPath)} ${shellQuote(join(mainDir, GROK_PRE_TOOL_POLICY_ENTRYPOINT))}`;
}

// The isolated v8 home is created solely for this policy and ACP `session/new`
// receives zero or exactly one validated LVIS-owned stdio descriptor. The full
// policy is pinned in GROK_HOME/config.toml, while requirements.toml contains
// only vendor-supported immutable clamps for precedence over remote settings.
// Grok's
// native permission taxonomy cannot express a deny-by-default policy with an
// MCP exception, so the canonical PreToolUse gate denies every actual tool
// name except the exact LVIS MCP namespace before the provider executes it.
// The lowercase permission filters are an additional vendor-native backstop.
const GROK_NATIVE_CONFIG = `${NATIVE_POLICY_MARKER}
[ui]
permission_mode = "ask"
disable_bypass_permissions_mode = true
yolo = false

[cli]
auto_update = false
required_minimum_version = "${GROK_BUILD_REQUIRED_MINIMUM_VERSION}"

[features]
managed_config = false
web_fetch = false
ask_user_question = false
image_gen = false
video_gen = false
write_file = false
voice_mode = false

[managed_mcps]
enabled = false
gateway_tools_enabled = false

[subagents]
enabled = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false
# This is a documented runtime cutoff, not an import request: it prevents
# fallback reads of the real user's ~/.claude settings and enabled-plugin list.
# It must live in config.toml because Grok reads this marker directly from that
# app-owned file rather than from the requirements layer.
[claude_compat]
imported = true


[permission]
rules = [
  { action = "deny", tool = "bash" },
  { action = "deny", tool = "edit" },
  { action = "deny", tool = "read" },
  { action = "deny", tool = "grep" },
  { action = "deny", tool = "webfetch" },
  { action = "allow", tool = "mcp", pattern = "lvis-host-tools__*" },
]

[[hooks.PreToolUse]]
hooks = [{ type = "command", command = ${JSON.stringify(grokPreToolPolicyCommand())}, timeout = 10, env = { ELECTRON_RUN_AS_NODE = "1" }]
`;

/**
 * Only keys documented as immutable requirements clamps belong here. The full
 * local policy remains in config.toml so unrecognized deep-merged values can
 * never make a runtime reject its entire policy file.
 */
const GROK_NATIVE_REQUIREMENTS = `${NATIVE_POLICY_MARKER}
[managed_mcps]
enabled = false

[subagents]
enabled = false

[cli]
auto_update = false
required_minimum_version = "${GROK_BUILD_REQUIRED_MINIMUM_VERSION}"

[ui]
yolo = false

[features]
web_fetch = false
ask_user_question = false
image_gen = false
video_gen = false
write_file = false
voice_mode = false
`;

/**
 * A Grok hook crash is vendor-defined fail-open. Refuse to launch a real ACP
 * runtime if the app-owned bundled entrypoint is not present as a regular
 * file. Unit tests import TypeScript sources directly, before esbuild emits
 * the sibling JavaScript entrypoint, so packaging presence is proven by the
 * build gate rather than this source-mode test path.
 */
async function assertGrokPreToolPolicyEntrypoint(): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  try {
    const entrypoint = resolve(mainDir, GROK_PRE_TOOL_POLICY_ENTRYPOINT);
    const stat = await fs.lstat(entrypoint);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe policy hook entrypoint");
  } catch {
    throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-unverified");
  }
}

let nativePolicyWriteTail: Promise<void> = Promise.resolve();

/**
 * Materialize the vendor-native policy before any login or ACP process starts.
 * A policy-versioned home is created fresh. The policy files are exact
 * canonical bodies: credentials live in the runtime's separate credential
 * storage, so a modified config is never merged or trusted on a later launch.
 * A policy upgrade therefore requires a fresh login rather than carrying a
 * prior runtime's MCP, plugin, or permission configuration forward.
 */
export async function ensureAcpSubscriptionNativePolicy(
  provider: AcpSubscriptionProviderId,
  runtimeHome: string,
): Promise<void> {
  const operation = nativePolicyWriteTail.then(() => ensureNativePolicy(provider, runtimeHome));
  nativePolicyWriteTail = operation.catch(() => undefined);
  await operation;
}

async function ensureNativePolicy(
  provider: AcpSubscriptionProviderId,
  runtimeHome: string,
): Promise<void> {
  await assertIsolatedRuntimeHome(runtimeHome);
  if (provider === "grok-build") await assertGrokPreToolPolicyEntrypoint();
  const files = acpSubscriptionNativePolicyFiles(provider, runtimeHome);
  const requiredFiles: Array<readonly [string, string]> = provider === "kimi-code"
    ? [[files.configToml as string, KIMI_NATIVE_CONFIG], [files.tuiToml as string, KIMI_TUI_POLICY]]
    : [
      [files.agentProfileMd as string, GROK_NATIVE_AGENT_PROFILE],
      [files.requirementsToml as string, GROK_NATIVE_REQUIREMENTS],
      [files.configToml as string, GROK_NATIVE_CONFIG],
    ];
  for (const [filePath, policy] of requiredFiles) {
    const existing = await readExistingPolicyFile(filePath);
    if (existing !== null) {
      if (!isVerifiedNativePolicy(provider, filePath, files, existing)) {
        throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-unverified");
      }
      continue;
    }
    await writeFileAtomicAtPath(filePath, policy);
  }
}


function isVerifiedNativePolicy(
  provider: AcpSubscriptionProviderId,
  filePath: string,
  files: AcpSubscriptionNativePolicyFiles,
  body: string,
): boolean {
  const expected = provider === "grok-build"
    ? filePath === files.agentProfileMd
      ? GROK_NATIVE_AGENT_PROFILE
      : filePath === files.requirementsToml
        ? GROK_NATIVE_REQUIREMENTS
        : filePath === files.configToml
          ? GROK_NATIVE_CONFIG
          : null
    : filePath === files.tuiToml
      ? KIMI_TUI_POLICY
      : filePath === files.configToml
        ? KIMI_NATIVE_CONFIG
        : null;
  return expected !== null && body === expected;
}
async function assertIsolatedRuntimeHome(runtimeHome: string): Promise<void> {
  if (
    !runtimeHome
    || runtimeHome.length > MAX_EXECUTABLE_PATH_LENGTH
    || CONTROL_CHARACTERS.test(runtimeHome)
    || !isAbsolute(runtimeHome)
  ) {
    throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-invalid-home");
  }
  try {
    const stat = await fs.lstat(resolve(runtimeHome));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-runtime-home");
  } catch (error) {
    if (error instanceof AcpSubscriptionRuntimePolicyError) throw error;
    throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-invalid-home");
  }
}

async function readExistingPolicyFile(filePath: string): Promise<string | null> {
  try {
    // Bind the link check, size check, and contents to one descriptor.
    // Checking metadata by path and then reopening it leaves a path-swap
    // window for a different policy file to reach the runtime.
    // Node exposes descriptor no-follow only on POSIX. Windows uses a
    // post-open lstat to reject an observed file-link/reparse replacement;
    // the app-owned runtime home additionally prevents untrusted writes.
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== "number") {
      throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-unverified");
    }
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    try {
      const pathStat = await fs.lstat(filePath);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
        throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-unverified");
      }
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_NATIVE_POLICY_FILE_BYTES) {
        throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-unverified");
      }
      const bytes = Buffer.allocUnsafe(MAX_NATIVE_POLICY_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_NATIVE_POLICY_FILE_BYTES) {
        throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-unverified");
      }
      return bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof AcpSubscriptionRuntimePolicyError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AcpSubscriptionRuntimePolicyError("acp-runtime-policy-unverified");
  }
}

interface PersistedAcpSubscriptionRuntimeConfig {
  version: number;
  executables: Partial<Record<AcpSubscriptionProviderId, string>>;
}

const EMPTY_CONFIG: PersistedAcpSubscriptionRuntimeConfig = {
  version: CONFIG_VERSION,
  executables: {},
};

function safeExecutablePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (
    !path ||
    path.length > MAX_EXECUTABLE_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    !isAbsolute(path)
  ) {
    return null;
  }
  return path;
}

function sanitizeConfig(value: unknown): PersistedAcpSubscriptionRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_CONFIG };
  const record = value as Record<string, unknown>;
  const source = record.executables;
  if (!source || typeof source !== "object" || Array.isArray(source)) return { ...EMPTY_CONFIG };
  const executables: PersistedAcpSubscriptionRuntimeConfig["executables"] = {};
  for (const provider of ["kimi-code", "grok-build"] as const) {
    const path = safeExecutablePath((source as Record<string, unknown>)[provider]);
    if (path) executables[provider] = path;
  }
  return { version: CONFIG_VERSION, executables };
}

export class AcpSubscriptionRuntimeConfigStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly namespace: FeatureNamespaceHandle = openFeatureNamespace("subscription-runtimes"),
  ) {}

  async getExecutable(provider: AcpSubscriptionProviderId): Promise<string | null> {
    const config = sanitizeConfig(await this.namespace.readJson(CONFIG_FILE, EMPTY_CONFIG));
    return config.executables[provider] ?? null;
  }

  async setExecutable(provider: AcpSubscriptionProviderId, executablePath: string): Promise<void> {
    const safePath = safeExecutablePath(executablePath);
    if (!safePath) throw new Error("invalid-acp-subscription-executable-path");
    await this.update((config) => ({
      ...config,
      executables: { ...config.executables, [provider]: safePath },
    }));
  }

  async clearExecutable(provider: AcpSubscriptionProviderId): Promise<void> {
    await this.update((config) => {
      const executables = { ...config.executables };
      delete executables[provider];
      return { ...config, executables };
    });
  }

  private async update(
    change: (config: PersistedAcpSubscriptionRuntimeConfig) => PersistedAcpSubscriptionRuntimeConfig,
  ): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const current = sanitizeConfig(await this.namespace.readJson(CONFIG_FILE, EMPTY_CONFIG));
      await this.namespace.writeJson(CONFIG_FILE, sanitizeConfig(change(current)));
    });
    this.writeTail = operation.catch(() => undefined);
    await operation;
  }
}
