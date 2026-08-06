import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "../codex-app-server-client.js";

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type RequestHandler = (request: RpcRequest) => unknown;
type Spawn = NonNullable<CodexAppServerClientOptions["spawn"]>;

/**
 * In-memory App Server double. It handles exactly the App Server JSONL transport that
 * the client owns, so no actual Codex executable, browser, or login is used.
 */
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RpcRequest[] = [];
  killed = false;
  exitCode: number | null = null;
  private input = "";
  private heldInitialize: RpcRequest | null = null;

  constructor(
    private readonly handler: RequestHandler,
    private readonly deferInitializeUntilInitialized = false,
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => this.consume(String(chunk)));
  }

  kill = (_signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    return true;
  };

  dispose(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }

  private consume(chunk: string): void {
    this.input += chunk;
    for (;;) {
      const newline = this.input.indexOf("\n");
      if (newline < 0) return;
      const line = this.input.slice(0, newline).trim();
      this.input = this.input.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as RpcRequest;
      this.requests.push(request);
      if (request.method === "initialized" && this.heldInitialize) {
        const initialize = this.heldInitialize;
        this.heldInitialize = null;
        this.respond(initialize);
        continue;
      }
      if (typeof request.id !== "number") continue;
      if (this.deferInitializeUntilInitialized && request.method === "initialize") {
        this.heldInitialize = request;
        continue;
      }
      this.stdout.write(`${JSON.stringify({
        id: request.id,
        result: this.handler(request),
      })}\n`);
    }
  }
  private respond(request: RpcRequest): void {
    this.stdout.write(`${JSON.stringify({
      id: request.id,
      result: this.handler(request),
    })}\n`);
  }
}

interface Harness {
  client: CodexAppServerClient;
  openExternal: ReturnType<typeof vi.fn>;
  runtimeRoot: string;
  runtimeHome: string;
  sqliteHome: string;
  workspaceDir: string;
  runtimeTempDir: string;
  server: FakeAppServer;
  spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }>;
}

const harnesses: Harness[] = [];
const TEST_RUNTIME_PARENT = process.platform === "win32" ? "C:\\tmp" : tmpdir();

function createHarness(
  handler: RequestHandler,
  options: { deferInitializeUntilInitialized?: boolean } = {},
): Harness {
  const server = new FakeAppServer(handler, options.deferInitializeUntilInitialized);
  const openExternal = vi.fn(async (_url: string) => undefined);
  const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-codex-app-server-client-"));
  const runtimeHome = join(runtimeRoot, "home");
  const sqliteHome = join(runtimeRoot, "sqlite");
  const workspaceDir = join(runtimeRoot, "workspace");
  const runtimeTempDir = join(runtimeRoot, "temporary");
  mkdirSync(runtimeHome);
  mkdirSync(sqliteHome);
  mkdirSync(workspaceDir);
  mkdirSync(runtimeTempDir);
  const spawnCalls: Harness["spawnCalls"] = [];
  const spawn: Spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return server as unknown as ChildProcess;
  };
  const client = new CodexAppServerClient({
    openExternal,
    runtimeHome,
    sqliteHome,
    workspaceDir,
    runtimeTempDir,
    resolveExecutable: () => "C:\\test\\codex.exe",
    spawn,
    clientVersion: "test-version",
  });
  const harness = {
    client,
    openExternal,
    runtimeRoot,
    runtimeHome,
    sqliteHome,
    workspaceDir,
    runtimeTempDir,
    server,
    spawnCalls,
  };
  harnesses.push(harness);
  return harness;
}

function standardInitialize(request: RpcRequest): unknown {
  if (request.method === "initialize") return { serverInfo: { name: "fake-codex" } };
  throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.client.stop();
    harness.server.dispose();
    rmSync(harness.runtimeRoot, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CodexAppServerClient", () => {
  it("projects account status without exposing account email or auth data", async () => {
    vi.stubEnv("OpenAI_Api_Key", "should-not-reach-codex");
    vi.stubEnv("CoDeX_AcCeSs_ToKeN", "should-not-reach-codex");
    vi.stubEnv("openai_base_url", "https://should-not-reach-codex.test");
    vi.stubEnv("CoDeX_ReFrEsH_ToKeN_Url_OverRide", "https://override.example.test");
    vi.stubEnv("oTeL_ExPoRtEr_OtLp_EnDpOiNt", "https://telemetry.example.test");
    vi.stubEnv("HtTpS_PrOxY", "https://proxy.example.test");
    vi.stubEnv("SSL_CERT_FILE", "C:\\test\\custom-ca.pem");
    vi.stubEnv("RuSt_LoG", "trace");
    vi.stubEnv("HOME", "host-home");
    vi.stubEnv("TMPDIR", "host-tmpdir");
    vi.stubEnv("PATH", "host-path");
    vi.stubEnv("USERPROFILE", "C:\\host-profile");
    vi.stubEnv("APPDATA", "C:\\host-appdata");
    vi.stubEnv("LOCALAPPDATA", "C:\\host-local-appdata");
    vi.stubEnv("TEMP", "C:\\host-temp");

    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/read") {
        return {
          account: {
            type: "chatgpt",
            email: "owner@example.test",
            planType: "plus",
            accessToken: "account-token-must-not-leave-main",
            refreshToken: "refresh-token-must-not-leave-main",
          },
        };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const status = await harness.client.getStatus();

    expect(status).toEqual({
      runtime: "ready",
      connection: "connected",
      planType: "plus",
      pendingLogin: null,
      pendingDeviceCode: null,
    });
    const projected = JSON.stringify(status);
    expect(projected).not.toContain("owner@example.test");
    expect(projected).not.toContain("account-token-must-not-leave-main");
    expect(projected).not.toContain("refresh-token-must-not-leave-main");
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]).toMatchObject({
      command: "C:\\test\\codex.exe",
      args: [
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
      options: {
        cwd: harness.workspaceDir,
        shell: false,
        windowsHide: true,
        env: expect.objectContaining({
          CODEX_HOME: harness.runtimeHome,
          CODEX_SQLITE_HOME: harness.sqliteHome,
          HOME: harness.runtimeHome,
          TMPDIR: harness.runtimeTempDir,
          RUST_LOG: "error",
        }),
      },
    });

    const childEnv = harness.spawnCalls[0]?.options.env ?? {};
    const childEnvNames = Object.keys(childEnv).map((name) => name.toUpperCase());
    expect(childEnvNames.filter((name) => name.startsWith("CODEX_")).sort()).toEqual([
      "CODEX_HOME",
      "CODEX_SQLITE_HOME",
    ]);
    expect(childEnvNames.some((name) => name.startsWith("OPENAI_") || name.startsWith("OTEL_"))).toBe(false);
    expect(childEnvNames).not.toEqual(expect.arrayContaining(["HTTPS_PROXY", "SSL_CERT_FILE"]));
    expect(childEnv.RUST_LOG).toBe("error");
    expect(childEnv.HOME).toBe(harness.runtimeHome);
    expect(childEnv.TMPDIR).toBe(harness.runtimeTempDir);
    expect(childEnv.PATH).not.toBe("host-path");
    expect(JSON.stringify(childEnv)).not.toContain("host-");
    if (process.platform === "win32") {
      expect(childEnv.USERPROFILE).toBe(harness.runtimeHome);
      expect(childEnv.APPDATA).toBe(harness.runtimeHome);
      expect(childEnv.LOCALAPPDATA).toBe(harness.runtimeHome);
      expect(childEnv.TEMP).toBe(harness.runtimeTempDir);
      expect(childEnv.TMP).toBe(harness.runtimeTempDir);
    }
  });
  it("sends initialized before awaiting the initialize result", async () => {
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/read") return { account: null };
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    }, {
      deferInitializeUntilInitialized: true,
    });

    const statusPromise = harness.client.getStatus();
    void statusPromise.catch(() => undefined);
    await Promise.resolve();

    expect(harness.server.requests.map((request) => request.method).slice(0, 2)).toEqual([
      "initialize",
      "initialized",
    ]);
    await expect(statusPromise).resolves.toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    });
  });

  it("opens only a trusted browser login URL and returns a URL-free pending status", async () => {
    const authUrl = "https://auth.openai.com/authorize?state=browser-only-state";
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return { type: "chatgpt", loginId: "browser-login", authUrl };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const status = await harness.client.startBrowserLogin();

    expect(harness.openExternal).toHaveBeenCalledOnce();
    expect(harness.openExternal).toHaveBeenCalledWith(authUrl);
    expect(status).toEqual({
      runtime: "ready",
      connection: "pending",
      planType: null,
      pendingLogin: "browser",
      pendingDeviceCode: null,
    });
    expect(JSON.stringify(status)).not.toContain("browser-only-state");
    expect(JSON.stringify(status)).not.toContain("auth.openai.com");
    expect(harness.server.requests).toContainEqual(expect.objectContaining({
      method: "account/login/start",
      params: {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      },
    }));
  });

  it("rejects an untrusted login URL without opening it", async () => {
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgpt",
          loginId: "evil-login",
          authUrl: "https://openai.com.attacker.test/authorize?state=do-not-open",
        };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    await expect(harness.client.startBrowserLogin()).rejects.toMatchObject({
      code: "codex-login-failed",
    });

    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it("keeps the device verification URL in main while returning only the one-time code", async () => {
    const verificationUrl = "https://chatgpt.com/device?ticket=main-process-only";
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "device-login",
          verificationUrl,
          userCode: "ABCD-EFGH",
        };
      }
      if (request.method === "account/read") return { account: null };
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const result = await harness.client.startDeviceCodeLogin();

    expect(harness.openExternal).toHaveBeenCalledOnce();
    expect(harness.openExternal).toHaveBeenCalledWith(verificationUrl);
    expect(result).toEqual({
      status: {
        runtime: "ready",
        connection: "pending",
        planType: null,
        pendingLogin: "device-code",
        pendingDeviceCode: "ABCD-EFGH",
      },
      userCode: "ABCD-EFGH",
    });
    await expect(harness.client.getStatus()).resolves.toEqual(result.status);

    const projected = JSON.stringify(result);
    expect(projected).not.toContain("main-process-only");
    expect(projected).not.toContain("chatgpt.com/device");
  });
  it("clears the volatile device code when sign-in is cancelled", async () => {
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "device-login",
          verificationUrl: "https://chatgpt.com/device",
          userCode: "ABCD-EFGH",
        };
      }
      if (request.method === "account/login/cancel") return {};
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    await harness.client.startDeviceCodeLogin();
    const status = await harness.client.cancelLogin();

    expect(status).toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    });
    expect(harness.client.getCachedStatus()).toEqual(status);
    expect(harness.server.requests).toContainEqual(expect.objectContaining({
      method: "account/login/cancel",
      params: { loginId: "device-login" },
    }));
  });


  it("reports an asynchronous login failure without leaking App Server detail", async () => {
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "device-login",
          verificationUrl: "https://chatgpt.com/device",
          userCode: "ABCD-EFGH",
        };
      }
      if (request.method === "account/read") return { account: null };
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    await harness.client.startDeviceCodeLogin();
    harness.server.stdout.write(`${JSON.stringify({
      method: "account/login/completed",
      params: {
        loginId: "device-login",
        success: false,
        error: "opaque-server-detail",
      },
    })}\n`);

    await expect(harness.client.getStatus()).rejects.toMatchObject({
      code: "codex-login-failed",
    });
    expect(JSON.stringify(harness.client.getCachedStatus())).not.toContain(
      "opaque-server-detail",
    );
    await expect(harness.client.getStatus()).resolves.toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    });
  });

  it("uses headerless App Server JSONL and omits logout params", async () => {
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/logout") return {};
      throw new Error(`Unexpected App Server request: ${String(request.method)}`);
    });

    const status = await harness.client.logout();

    expect(status).toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    });
    const logout = harness.server.requests.find((request) => request.method === "account/logout");
    expect(logout).toEqual({
      id: expect.any(Number),
      method: "account/logout",
    });
    expect(logout).not.toHaveProperty("params");
    for (const request of harness.server.requests) {
      expect(request).not.toHaveProperty("jsonrpc");
    }
  });

  it("returns a non-sensitive status and filters malformed or duplicate models", async () => {
    const harness = createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/read") {
        return {
          account: {
            type: "chatgpt",
            email: "models-owner@example.test",
            planType: "pro",
          },
        };
      }
      if (request.method === "model/list") {
        return {
          data: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              isDefault: true,
              inputModalities: ["text", "image"],
            },
            {
              model: "gpt-5-mini",
              displayName: "   ",
              inputModalities: ["text", 7, "audio", "bad\u0000modality"],
            },
            { id: "gpt-5.4", displayName: "duplicate" },
            { id: "bad\u0000model", displayName: "ignored" },
            null,
          ],
        };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const result = await harness.client.listModels();

    expect(result).toEqual({
      status: {
        runtime: "ready",
        connection: "connected",
        planType: "pro",
        pendingLogin: null,
        pendingDeviceCode: null,
      },
      models: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
          inputModalities: ["text", "image"],
        },
        {
          id: "gpt-5-mini",
          displayName: "gpt-5-mini",
          isDefault: false,
          inputModalities: ["text", "audio"],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("models-owner@example.test");
    expect(harness.server.requests).toContainEqual(expect.objectContaining({
      method: "model/list",
      params: { limit: 100, includeHidden: false },
    }));
  });
});
