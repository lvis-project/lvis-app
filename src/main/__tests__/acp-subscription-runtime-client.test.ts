import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRecordedSpawn } from "../../__tests__/test-helpers.js";
import {
  AcpSubscriptionRuntimeClient,
  resolveAcpSubscriptionExecutable,
  sanitizedAcpSubscriptionEnvironment,
  type AcpSubscriptionRuntimeClientOptions,
} from "../acp-subscription-runtime-client.js";
import {
  GROK_BUILD_REQUIRED_MINIMUM_VERSION,
  grokBuildGovernedAgentDefinitionPath,
} from "../acp-subscription-runtime-config.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

type Spawn = NonNullable<AcpSubscriptionRuntimeClientOptions["spawn"]>;

class FakeRuntimeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = -1;
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    return true;
  });
}

interface LoginHarness {
  client: AcpSubscriptionRuntimeClient;
  child: FakeRuntimeProcess;
  runtimeRoot: string;
  spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }>;
  runtimeTempDir: string;
}

const harnesses: LoginHarness[] = [];
const TEST_RUNTIME_PARENT = process.platform === "win32" ? "C:\\tmp" : tmpdir();

function createLoginHarness(provider: "kimi-code" | "grok-build" = "kimi-code"): LoginHarness {
  const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-acp-subscription-client-"));
  const runtimeHome = join(runtimeRoot, "home");
  const workspaceDir = join(runtimeRoot, "workspace");
  const runtimeTempDir = join(runtimeRoot, "temporary");
  mkdirSync(runtimeHome);
  mkdirSync(workspaceDir);
  mkdirSync(runtimeTempDir);

  const child = new FakeRuntimeProcess();
  const spawnCalls: LoginHarness["spawnCalls"] = [];
  const spawn: Spawn = makeRecordedSpawn(child as unknown as ChildProcess, spawnCalls);
  const client = new AcpSubscriptionRuntimeClient({
    provider,
    runtimeHome,
    workspaceDir,
    executablePath: `C:\\approved\\${provider}.exe`,
    runtimeTempDir,
    resolveExecutable: async () => `C:\\approved\\${provider}.exe`,
    spawn,
    platform: "win32",
    clientVersion: "test-version",
  });
  const harness = { client, child, runtimeRoot, runtimeTempDir, spawnCalls };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.client.stop();
    harness.child.stdin.destroy();
    harness.child.stdout.destroy();
    harness.child.stderr.destroy();
    await cleanupTmpDir(harness.runtimeRoot);
  }
  vi.restoreAllMocks();
});

describe("AcpSubscriptionRuntimeClient security boundary", () => {
  it("uses only the fixed Kimi device-code argv and never projects untrusted runtime output", async () => {
    const { client, child, runtimeTempDir, spawnCalls } = createLoginHarness();

    const pending = await client.startDeviceCodeLogin();
    child.stdout.write("URL: https://attacker.example/device?state=browser-secret\n");
    child.stderr.write("account=owner@example.test token=runtime-secret\n");

    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    const status = client.getCachedStatus();
    const projected = JSON.stringify({ pending, status });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: "C:\\approved\\kimi-code.exe",
      args: ["login"],
      options: { shell: false, windowsHide: true },
    });
    expect(spawnCalls[0]?.options.env).toMatchObject({
      TEMP: win32.normalize(runtimeTempDir),
      TMP: win32.normalize(runtimeTempDir),
      TMPDIR: win32.normalize(runtimeTempDir),
    });
    expect(status).toMatchObject({
      connection: "pending",
      pendingLogin: "device-code",
      pendingDeviceCode: null,
      canOpenVerificationUrl: false,
    });
    expect(status).not.toHaveProperty("rawOutput");
    expect(status).not.toHaveProperty("verificationUrl");
    expect(projected).not.toContain("attacker.example");
    expect(projected).not.toContain("browser-secret");
    expect(projected).not.toContain("owner@example.test");
    expect(projected).not.toContain("runtime-secret");

    await client.cancelLogin();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

  });
  it("opens the ACP authentication probe over a bidirectional JSONL pipe", async () => {
    const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-acp-auth-probe-"));
    const runtimeHome = join(runtimeRoot, "home");
    const workspaceDir = join(runtimeRoot, "workspace");
    const runtimeTempDir = join(runtimeRoot, "temporary");
    mkdirSync(runtimeHome);
    mkdirSync(workspaceDir);
    mkdirSync(runtimeTempDir);
    const versionChild = new FakeRuntimeProcess();
    const probeChild = new FakeRuntimeProcess();
    const probeRequests: Array<{ id: number; method: string }> = [];
    let probeInput = "";
    probeChild.stdin.on("data", (chunk: Buffer | string) => {
      probeInput += String(chunk);
      for (;;) {
        const newline = probeInput.indexOf("\n");
        if (newline < 0) return;
        const line = probeInput.slice(0, newline).trim();
        probeInput = probeInput.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id?: unknown; method?: unknown };
        if (typeof request.id !== "number" || typeof request.method !== "string") continue;
        probeRequests.push({ id: request.id, method: request.method });
        if (request.method === "initialize") {
          probeChild.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { authMethods: [{ id: "login" }] },
          })}\n`);
        } else if (request.method === "authenticate") {
          probeChild.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
        }
      }
    });
    const spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }> = [];
    const spawn: Spawn = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      if (spawnCalls.length === 1) {
        queueMicrotask(() => {
          versionChild.stdout.write("kimi 1.2.3\n");
          versionChild.emit("close", 0);
        });
        return versionChild as unknown as ChildProcess;
      }
      return probeChild as unknown as ChildProcess;
    };
    const client = new AcpSubscriptionRuntimeClient({
      provider: "kimi-code",
      runtimeHome,
      workspaceDir,
      runtimeTempDir,
      executablePath: "C:\\approved\\kimi-code.exe",
      resolveExecutable: async () => "C:\\approved\\kimi-code.exe",
      spawn,
      platform: "win32",
      clientVersion: "test-version",
    });

    try {
      await expect(client.verify()).resolves.toMatchObject({ runtime: "ready", connection: "connected" });
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[1]).toMatchObject({
        command: "C:\\approved\\kimi-code.exe",
        args: ["acp"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
      });
      expect(probeRequests).toEqual([
        { id: 1, method: "initialize" },
        { id: 2, method: "authenticate" },
      ]);
    } finally {
      await client.stop();
      versionChild.stdin.destroy();
      versionChild.stdout.destroy();
      versionChild.stderr.destroy();
      probeChild.stdin.destroy();
      probeChild.stdout.destroy();
      probeChild.stderr.destroy();
      await cleanupTmpDir(runtimeRoot);
    }
  });

  it("performs the fixed Grok cached-token ACP verification handshake", async () => {
    const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-grok-acp-auth-probe-"));
    const runtimeHome = join(runtimeRoot, "home");
    const workspaceDir = join(runtimeRoot, "workspace");
    const runtimeTempDir = join(runtimeRoot, "temporary");
    mkdirSync(runtimeHome);
    mkdirSync(workspaceDir);
    mkdirSync(runtimeTempDir);
    const versionChild = new FakeRuntimeProcess();
    const probeChild = new FakeRuntimeProcess();
    const probeRequests: Array<{ id: number; method: string; params: unknown }> = [];
    let probeInput = "";
    probeChild.stdin.on("data", (chunk: Buffer | string) => {
      probeInput += String(chunk);
      for (;;) {
        const newline = probeInput.indexOf("\n");
        if (newline < 0) return;
        const line = probeInput.slice(0, newline).trim();
        probeInput = probeInput.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
        if (typeof request.id !== "number" || typeof request.method !== "string") continue;
        probeRequests.push({ id: request.id, method: request.method, params: request.params });
        if (request.method === "initialize") {
          probeChild.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { authMethods: [{ methodId: "cached_token" }] },
          })}\n`);
        } else if (request.method === "authenticate") {
          probeChild.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
        }
      }
    });
    const spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }> = [];
    const spawn: Spawn = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      if (spawnCalls.length === 1) {
        queueMicrotask(() => {
          versionChild.stdout.write("grok-build 1.2.3\n");
          versionChild.emit("close", 0);
        });
        return versionChild as unknown as ChildProcess;
      }
      return probeChild as unknown as ChildProcess;
    };
    const client = new AcpSubscriptionRuntimeClient({
      provider: "grok-build",
      runtimeHome,
      workspaceDir,
      runtimeTempDir,
      executablePath: "C:\\approved\\grok-build.exe",
      resolveExecutable: async () => "C:\\approved\\grok-build.exe",
      spawn,
      platform: "win32",
      clientVersion: "test-version",
    });

    try {
      await expect(client.verify()).resolves.toMatchObject({ runtime: "ready", connection: "connected" });
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]).toMatchObject({
        command: "C:\\approved\\grok-build.exe",
        args: ["--version"],
      });
      expect(spawnCalls[0]?.options.env).toMatchObject({
        GROK_AGENT: grokBuildGovernedAgentDefinitionPath(runtimeHome, "win32"),
        GROK_REQUIRED_MINIMUM_VERSION: GROK_BUILD_REQUIRED_MINIMUM_VERSION,
      });
      expect(spawnCalls[1]).toMatchObject({
        command: "C:\\approved\\grok-build.exe",
        args: ["--no-auto-update", "agent", "stdio"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
      });
      expect(probeRequests).toEqual([
        {
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "lvis", version: "test-version" },
          },
        },
        {
          id: 2,
          method: "authenticate",
          params: { methodId: "cached_token", _meta: { headless: true } },
        },
      ]);
    } finally {
      await client.stop();
      versionChild.stdin.destroy();
      versionChild.stdout.destroy();
      versionChild.stderr.destroy();
      probeChild.stdin.destroy();
      probeChild.stdout.destroy();
      probeChild.stderr.destroy();
      await cleanupTmpDir(runtimeRoot);
    }
  });

  it("fails closed before ACP authentication for Grok Build below the governed minimum", async () => {
    const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-grok-minimum-version-"));
    const runtimeHome = join(runtimeRoot, "home");
    const workspaceDir = join(runtimeRoot, "workspace");
    const runtimeTempDir = join(runtimeRoot, "temporary");
    mkdirSync(runtimeHome);
    mkdirSync(workspaceDir);
    mkdirSync(runtimeTempDir);
    const versionChild = new FakeRuntimeProcess();
    const spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }> = [];
    const spawn: Spawn = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      queueMicrotask(() => {
        versionChild.stdout.write("grok-build 0.2.115\n");
        versionChild.emit("close", 0);
      });
      return versionChild as unknown as ChildProcess;
    };
    const client = new AcpSubscriptionRuntimeClient({
      provider: "grok-build",
      runtimeHome,
      workspaceDir,
      runtimeTempDir,
      executablePath: "C:\\approved\\grok-build.exe",
      resolveExecutable: async () => "C:\\approved\\grok-build.exe",
      spawn,
      platform: "win32",
    });

    try {
      await expect(client.verify()).rejects.toMatchObject({ code: "acp-runtime-unavailable" });
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toMatchObject({ args: ["--version"] });
      expect(client.getCachedStatus()).toMatchObject({ runtime: "unverified", connection: "unknown" });
    } finally {
      await client.stop();
      versionChild.stdin.destroy();
      versionChild.stdout.destroy();
      versionChild.stderr.destroy();
      await cleanupTmpDir(runtimeRoot);
    }
  });
  it("rejects a Grok Build prerelease at the governed minimum", async () => {
    const { client, child, spawnCalls } = createLoginHarness("grok-build");
    const verification = client.verify();

    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    child.stdout.write("grok-build 0.2.116-alpha.1\n");
    child.emit("close", 0);

    await expect(verification).rejects.toMatchObject({ code: "acp-runtime-unavailable" });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ args: ["--version"] });
    expect(client.getCachedStatus()).toMatchObject({ runtime: "unverified", connection: "unknown" });
  });


  it("reads configured status without executing the selected runtime", async () => {
    const { client, spawnCalls } = createLoginHarness();

    const status = await client.getStatus();

    expect(status).toMatchObject({ runtime: "unverified", connection: "unknown" });
    expect(spawnCalls).toHaveLength(0);
  });


  it("keeps an allowlisted Kimi verification URL in main and opens it only after an explicit request", async () => {
    const { client, child } = createLoginHarness();
    const verificationUrl = "https://auth.kimi.com/device?user_code=ABCD-EFGH&state=main-process-only";
    const openExternal = vi.fn(async (_url: string) => undefined);

    await client.startDeviceCodeLogin();
    child.stderr.write("Open this page: https://auth.kimi.com/device?user_");
    child.stderr.write("code=ABCD-EFGH&state=main-process-only\n");

    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    const beforeOpen = client.getCachedStatus();
    expect(beforeOpen).toMatchObject({
      connection: "pending",
      pendingLogin: "device-code",
      pendingDeviceCode: "ABCD-EFGH",
      canOpenVerificationUrl: true,
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(JSON.stringify(beforeOpen)).not.toContain("auth.kimi.com");
    expect(JSON.stringify(beforeOpen)).not.toContain("main-process-only");

    const afterOpen = await client.openPendingVerificationUrl(openExternal);

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(verificationUrl);
    expect(JSON.stringify(afterOpen)).not.toContain("auth.kimi.com");
    expect(JSON.stringify(afterOpen)).not.toContain("main-process-only");
  });


  it("accepts the official Grok Build device page without projecting its URL", async () => {
    const { client, child, spawnCalls } = createLoginHarness("grok-build");
    const verificationUrl = "https://accounts.x.ai/device?user_code=GROK-1234&state=main-process-only";
    const openExternal = vi.fn(async (_url: string) => undefined);

    await client.startDeviceCodeLogin();
    child.stdout.write(`${verificationUrl}\n`);

    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    const status = client.getCachedStatus();
    expect(spawnCalls[0]).toMatchObject({
      command: "C:\\approved\\grok-build.exe",
      args: ["login", "--device-auth"],
    });
    expect(status).toMatchObject({
      connection: "pending",
      pendingDeviceCode: "GROK-1234",
      canOpenVerificationUrl: true,
    });
    expect(JSON.stringify(status)).not.toContain("accounts.x.ai");
    expect(JSON.stringify(status)).not.toContain("main-process-only");

    await client.openPendingVerificationUrl(openExternal);

    expect(openExternal).toHaveBeenCalledWith(verificationUrl);
  });
  it("does not extract a verification URL or device code from an untrusted host", async () => {
    const { client, child } = createLoginHarness();
    const openExternal = vi.fn(async (_url: string) => undefined);

    await client.startDeviceCodeLogin();
    child.stdout.write("URL: https://auth.kimi.com.attacker.test/device?user_code=LEAK-1234&state=evil\n");

    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    const status = client.getCachedStatus();
    expect(status).toMatchObject({
      connection: "pending",
      pendingDeviceCode: null,
      canOpenVerificationUrl: false,
    });
    expect(JSON.stringify(status)).not.toContain("attacker.test");
    expect(JSON.stringify(status)).not.toContain("LEAK-1234");

    await expect(client.openPendingVerificationUrl(openExternal)).rejects.toMatchObject({
      code: "acp-verification-url-unavailable",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
  it("accepts a native Windows executable but rejects command wrappers and UNC paths", async () => {
    const root = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-acp-subscription-executable-"));
    try {
      const executable = join(root, "kimi.exe");
      const wrapper = join(root, "kimi.cmd");
      writeFileSync(executable, "");
      writeFileSync(wrapper, "");

      await expect(resolveAcpSubscriptionExecutable(executable, "win32")).resolves.toBe(
        realpathSync(resolve(executable)),
      );
      await expect(resolveAcpSubscriptionExecutable(wrapper, "win32")).rejects.toMatchObject({
        code: "acp-runtime-invalid-executable",
      });
      await expect(resolveAcpSubscriptionExecutable("\\\\server\\share\\kimi.exe", "win32")).rejects.toMatchObject({
        code: "acp-runtime-invalid-executable",
      });
    } finally {
      await cleanupTmpDir(root);
    }
  });

  it("does not inherit credentials, proxy injection, or a user-controlled command environment", () => {
    const runtimeHome = "C:\\isolated\\kimi-home";
    const tempDir = "C:\\isolated\\temporary";
    const environment = sanitizedAcpSubscriptionEnvironment(
      "kimi-code",
      runtimeHome,
      {
        PATH: "C:\\attacker\\bin",
        COMSPEC: "C:\\attacker\\cmd.exe",
        TEMP: "C:\\attacker\\temp",
        TMP: "C:\\attacker\\tmp",
        TMPDIR: "C:\\attacker\\tmpdir",
        SYSTEMROOT: "C:\\Windows",
        WINDIR: "C:\\Windows",
        OPENAI_API_KEY: "must-not-reach-runtime",
        KIMI_API_KEY: "must-not-reach-runtime",
        HTTPS_PROXY: "https://proxy.example.test",
        SSL_CERT_FILE: "C:\\attacker\\custom-ca.pem",
        NODE_OPTIONS: "--require=C:\\attacker\\hook.js",
      },
      "win32",
      tempDir,
    );

    expect(environment).toMatchObject({
      KIMI_CODE_HOME: win32.normalize(runtimeHome),
      USERPROFILE: win32.normalize(runtimeHome),
      TEMP: win32.normalize(tempDir),
      TMP: win32.normalize(tempDir),
      TMPDIR: win32.normalize(tempDir),
      RUST_LOG: "error",
    });
    expect(environment.PATH ?? "").not.toContain("attacker");
    expect(environment.COMSPEC ?? "").not.toContain("attacker");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.KIMI_API_KEY).toBeUndefined();
    expect(environment.HTTPS_PROXY).toBeUndefined();
    expect(environment.SSL_CERT_FILE).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
  });

  it("forces Grok managed-MCP and compatibility discovery off in its isolated child environment", () => {
    const runtimeHome = "C:\\isolated\\grok-home";
    const tempDir = "C:\\isolated\\temporary";
    const environment = sanitizedAcpSubscriptionEnvironment(
      "grok-build",
      runtimeHome,
      {
        HOME: "C:\\Users\\outside-home",
        GROK_MANAGED_CONFIG: "true",
        GROK_AGENT: "C:\\attacker\\profile.md",
        GROK_REQUIRED_MINIMUM_VERSION: "0.0.1",
        GROK_MANAGED_MCPS_ENABLED: "true",
        GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "true",
        GROK_CLAUDE_MCPS_ENABLED: "true",
        GROK_CURSOR_MCPS_ENABLED: "true",
        GROK_CODEX_SESSIONS_ENABLED: "true",
      },
      "win32",
      tempDir,
    );

    expect(environment).toMatchObject({
      GROK_HOME: win32.normalize(runtimeHome),
      GROK_AGENT: grokBuildGovernedAgentDefinitionPath(runtimeHome, "win32"),
      GROK_REQUIRED_MINIMUM_VERSION: GROK_BUILD_REQUIRED_MINIMUM_VERSION,
      USERPROFILE: win32.normalize(runtimeHome),
      APPDATA: win32.join(win32.normalize(runtimeHome), "appdata"),
      LOCALAPPDATA: win32.join(win32.normalize(runtimeHome), "localappdata"),
    });
    // Windows launch environments must not inherit a separate Unix-style
    // home that could redirect third-party discovery outside the isolated
    // provider directories.
    expect(environment.HOME).toBeUndefined();
    for (const key of [
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
    ]) {
      expect(environment[key]).toBe("false");
    }
  });
});
