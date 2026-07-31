import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexConversationRuntime,
  sanitizedCodexConversationEnvironment,
  type CodexConversationRuntimeOptions,
} from "../codex-conversation-runtime.js";

type Spawn = NonNullable<CodexConversationRuntimeOptions["spawn"]>;
type JsonRecord = Record<string, unknown>;

class FakeAppServerProcess extends EventEmitter {
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

interface Harness {
  runtime: CodexConversationRuntime;
  child: FakeAppServerProcess;
  runtimeRoot: string;
  workspaceDir: string;
  spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }>;
  messages: JsonRecord[];
}

const harnesses: Harness[] = [];
const TEST_RUNTIME_PARENT = process.platform === "win32" ? "C:\\tmp" : tmpdir();

function createHarness(onMessage?: (message: JsonRecord, harness: Harness) => boolean | void): Harness {
  const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-codex-conversation-runtime-"));
  const runtimeHome = join(runtimeRoot, "home");
  const sqliteHome = join(runtimeRoot, "sqlite");
  const workspaceDir = join(runtimeRoot, "workspace");
  mkdirSync(runtimeHome);
  mkdirSync(sqliteHome);
  mkdirSync(workspaceDir);

  const child = new FakeAppServerProcess();
  const spawnCalls: Harness["spawnCalls"] = [];
  const messages: JsonRecord[] = [];
  const spawn: Spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child as unknown as ChildProcess;
  };
  const runtime = new CodexConversationRuntime({
    runtimeHome,
    sqliteHome,
    workspaceDir,
    resolveExecutable: () => "C:\\approved\\codex.exe",
    spawn,
    clientVersion: "test-version",
  });
  const harness = { runtime, child, runtimeRoot, workspaceDir, spawnCalls, messages };
  child.stdin.on("data", (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonRecord;
      messages.push(message);
      const handled = onMessage?.(message, harness) === true;
      if (!handled && message.method === "windowsSandbox/readiness") {
        reply(child, requestId(message), { status: "ready" });
      }
    }
  });
  harnesses.push(harness);
  return harness;
}

function reply(child: FakeAppServerProcess, id: unknown, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(child: FakeAppServerProcess, method: string, params: unknown): void {
  child.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

function serverRequest(
  child: FakeAppServerProcess,
  id: string | number,
  method: string,
  params: unknown,
): void {
  child.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
}

function methodMessages(harness: Harness, method: string): JsonRecord[] {
  return harness.messages.filter((message) => message.method === method);
}

function requestId(message: JsonRecord): number {
  expect(typeof message.id).toBe("number");
  return message.id as number;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.runtime.stop();
    harness.child.stdin.destroy();
    harness.child.stdout.destroy();
    harness.child.stderr.destroy();
    rmSync(harness.runtimeRoot, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("CodexConversationRuntime", () => {
  it("initializes an isolated blank-workspace thread and streams text and reasoning through callbacks", async () => {
    const textDeltas: unknown[] = [];
    const reasoningDeltas: unknown[] = [];
    const completions: unknown[] = [];
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), { userAgent: "test" });
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        // Notifications can arrive before the turn/start response. The client
        // must correlate them to the pending active turn without losing deltas.
        notify(current.child, "item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "Hello ",
        });
        notify(current.child, "item/reasoning/summaryTextDelta", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "Checking context",
          summaryIndex: 0,
        });
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        notify(current.child, "item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "world",
        });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
    });

    const result = await harness.runtime.startTurn(
      { text: "Say hello", model: "gpt-5.4" },
      {
        onTextDelta: (event) => textDeltas.push(event),
        onReasoningDelta: (event) => reasoningDeltas.push(event),
        onTurnCompleted: (event) => completions.push(event),
      },
    );

    expect(result).toEqual({ threadId: "thread-1", turnId: "turn-1", status: "completed" });
    expect(textDeltas).toEqual([
      { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "Hello " },
      { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "world" },
    ]);
    expect(reasoningDeltas).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        delta: "Checking context",
        summaryIndex: 0,
      },
    ]);
    expect(completions).toEqual([result]);

    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]).toMatchObject({
      command: "C:\\approved\\codex.exe",
      options: {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    });
    expect(harness.spawnCalls[0]?.args).toEqual([
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
    ]);

    const initializedIndex = harness.messages.findIndex((message) => message.method === "initialized");
    const threadStart = methodMessages(harness, "thread/start")[0];
    const turnStart = methodMessages(harness, "turn/start")[0];
    expect(initializedIndex).toBeGreaterThan(harness.messages.findIndex((message) => message.method === "initialize"));
    expect(threadStart?.params).toMatchObject({
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      ephemeral: true,
    });
    expect(turnStart?.params).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      cwd: harness.workspaceDir,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [harness.workspaceDir],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      input: [{ type: "text", text: "Say hello" }],
    });
    expect(JSON.stringify({ threadStart, turnStart })).not.toContain("read-only");
    expect(JSON.stringify({ threadStart, turnStart })).not.toContain("danger-full-access");
  });

  it("stages a subscription image as localImage bytes and removes it after completion", async () => {
    let stagedPath: string | undefined;
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        const input = (message.params as { input?: Array<{ type?: string; path?: string }> }).input;
        stagedPath = input?.find((part) => part.type === "localImage")?.path;
        expect(stagedPath).toBeTruthy();
        expect(readFileSync(stagedPath as string)).toEqual(Buffer.from("iVBORw0KGgo=", "base64"));
        expect(JSON.stringify(message)).not.toContain("iVBORw0KGgo=");
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
    });

    await expect(harness.runtime.startTurn({
      text: "Inspect this image.",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    })).resolves.toMatchObject({ status: "completed" });
    await vi.waitFor(() => expect(existsSync(stagedPath as string)).toBe(false));
  });

  it("removes a staged localImage when turn/start fails", async () => {
    let stagedPath: string | undefined;
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        const input = (message.params as { input?: Array<{ type?: string; path?: string }> }).input;
        stagedPath = input?.find((part) => part.type === "localImage")?.path;
        current.child.stdout.write(JSON.stringify({
          id: requestId(message),
          error: { code: -32_000, message: "turn start rejected" },
        }) + "\n");
      }
    });

    await expect(harness.runtime.startTurn({
      text: "Fail after staging.",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    })).rejects.toMatchObject({ code: "codex-operation-failed" });
    await vi.waitFor(() => expect(existsSync(stagedPath as string)).toBe(false));
  });

  it("removes a staged localImage when an active turn is interrupted", async () => {
    let stagedPath: string | undefined;
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        const input = (message.params as { input?: Array<{ type?: string; path?: string }> }).input;
        stagedPath = input?.find((part) => part.type === "localImage")?.path;
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        return;
      }
      if (message.method === "turn/interrupt") {
        reply(current.child, requestId(message), {});
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted" },
        });
      }
    });

    const pending = harness.runtime.startTurn({
      text: "Interrupt after staging.",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    });
    await vi.waitFor(() => expect(stagedPath).toBeTruthy());
    await harness.runtime.interrupt();
    await expect(pending).resolves.toMatchObject({ status: "interrupted" });
    await vi.waitFor(() => expect(existsSync(stagedPath as string)).toBe(false));
  });

  for (const [terminalEvent, closeTransport] of [
    ["stop()", (harness: Harness) => harness.runtime.stop()],
    ["child exit", (harness: Harness) => harness.child.emit("exit", 1, null)],
  ] as const) {
    it("removes a staged localImage when " + terminalEvent + " races its write", async () => {
      let stagedPath: string | undefined;
      let releaseWrite: () => void = () => {};
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let signalWriteStarted: () => void = () => {};
      const writeStarted = new Promise<void>((resolve) => {
        signalWriteStarted = resolve;
      });
      vi.spyOn(fs, "open").mockImplementation((async (path: string | Buffer | URL) => {
        stagedPath = String(path);
        writeFileSync(stagedPath, "staged", { mode: 0o600 });
        return {
          writeFile: async () => {
            signalWriteStarted();
            await writeReleased;
          },
          close: async () => undefined,
        } as unknown as fs.FileHandle;
      }) as unknown as typeof fs.open);
      const harness = createHarness((message, current) => {
        if (message.method === "initialize") {
          reply(current.child, requestId(message), {});
          return;
        }
        if (message.method === "thread/start") {
          reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        }
      });

      const pending = harness.runtime.startTurn({
        text: "Stop while staging this image.",
        attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
      });
      await writeStarted;
      expect(existsSync(stagedPath as string)).toBe(true);
      closeTransport(harness);
      releaseWrite();

      await expect(pending).rejects.toMatchObject({ code: "codex-operation-failed" });
      await vi.waitFor(() => expect(existsSync(stagedPath as string)).toBe(false));
      expect(methodMessages(harness, "turn/start")).toHaveLength(0);
    });
  }

  it("removes only stale exact staged image files before a new staging session", async () => {
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
    });
    const runtimeHome = join(harness.runtimeRoot, "home");
    const staleImage = join(runtimeHome, "lvis-subscription-image-11111111-1111-4111-8111-111111111111.png");
    const unrelatedFile = join(runtimeHome, "lvis-subscription-image-not-a-uuid.png");
    writeFileSync(staleImage, "old image", { mode: 0o600 });
    utimesSync(staleImage, new Date(0), new Date(0));
    writeFileSync(unrelatedFile, "keep", { mode: 0o600 });

    await expect(harness.runtime.startTurn({
      text: "Start a new image turn.",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    })).resolves.toMatchObject({ status: "completed" });

    expect(existsSync(staleImage)).toBe(false);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

  it("projects a safe TPM diagnostic from a turn/start response error", async () => {
    const rawDetail = "429 rate limit for private-plan: tokens per minute account=secret";
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        current.child.stdout.write(`${JSON.stringify({
          id: requestId(message),
          error: {
            message: rawDetail,
            statusCode: 429,
            data: {
              rateLimit: {
                kind: "tokens_per_minute",
                limit: 200_000,
                used: 190_000,
                requested: 30_000,
                retryAfterSeconds: 2.5,
                secret: "must-not-leak",
              },
            },
          },
        })}\n`);
      }
    });

    const failure = await harness.runtime.startTurn({ text: "recover safely" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "codex-operation-failed",
      providerError: {
        providerCode: "rate_limit_exceeded",
        classification: "rate-limit",
        rateLimit: {
          kind: "tokens-per-minute",
          limit: 200_000,
          used: 190_000,
          requested: 30_000,
          retryAfterSeconds: 2.5,
        },
      },
    });
    expect(JSON.stringify(failure)).not.toContain(rawDetail);
    expect(JSON.stringify(failure)).not.toContain("private-plan");
    expect(JSON.stringify(failure)).not.toContain("must-not-leak");
  });

  it("projects a safe context diagnostic from a failed turn completion", async () => {
    const rawDetail = "context_length_exceeded for private conversation history";
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: rawDetail, data: { status: 413 } },
          },
        });
      }
    });

    const result = await harness.runtime.startTurn({ text: "compact safely" });
    expect(result).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "failed",
      providerError: {
        origin: "provider",
        statusCode: 413,
        classification: "context-length",
        messagePreview: "context window exceeded",
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawDetail);
    expect(JSON.stringify(result)).not.toContain("private conversation history");
  });

  it.skipIf(process.platform !== "win32")(
    "fails closed when Windows sandbox readiness is unavailable without configuring it",
    async () => {
      const harness = createHarness((message, current) => {
        if (message.method === "initialize") {
          reply(current.child, requestId(message), {});
          return;
        }
        if (message.method === "windowsSandbox/readiness") {
          reply(current.child, requestId(message), { status: "notConfigured" });
          return true;
        }
      });

      await expect(harness.runtime.startTurn({ text: "Fail closed" })).rejects.toMatchObject({
        code: "codex-runtime-start-failed",
      });

      expect(methodMessages(harness, "windowsSandbox/setupStart")).toHaveLength(0);
      expect(methodMessages(harness, "thread/start")).toHaveLength(0);
      expect(harness.child.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it("verifies the shared ChatGPT account without creating a thread or a billable turn", async () => {
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "account/read") {
        reply(current.child, requestId(message), {
          account: { type: "chatgpt" },
        });
      }
    });

    await expect(harness.runtime.verifyIsolation()).resolves.toBeUndefined();

    expect(methodMessages(harness, "initialize")).toHaveLength(1);
    expect(methodMessages(harness, "account/read")[0]?.params).toEqual({ refreshToken: false });
    const accountReadIndex = harness.messages.findIndex((message) => message.method === "account/read");
    expect(accountReadIndex).toBeGreaterThan(harness.messages.findIndex((message) => message.method === "initialize"));
    if (process.platform === "win32") {
      expect(accountReadIndex).toBeGreaterThan(
        harness.messages.findIndex((message) => message.method === "windowsSandbox/readiness"),
      );
    }
    expect(methodMessages(harness, "thread/start")).toHaveLength(0);
    expect(methodMessages(harness, "turn/start")).toHaveLength(0);
    expect(harness.runtime.getThreadId()).toBeNull();
    expect(harness.runtime.isTurnActive()).toBe(false);
  });

  it("fails closed when the shared runtime does not report ChatGPT authentication", async () => {
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "account/read") {
        reply(current.child, requestId(message), { account: null });
      }
    });

    await expect(harness.runtime.verifyIsolation()).rejects.toMatchObject({
      code: "codex-operation-failed",
    });

    expect(methodMessages(harness, "account/read")).toHaveLength(1);
    expect(methodMessages(harness, "thread/start")).toHaveLength(0);
    expect(methodMessages(harness, "turn/start")).toHaveLength(0);
    expect(harness.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(harness.runtime.getThreadId()).toBeNull();
    expect(harness.runtime.isTurnActive()).toBe(false);
  });
  it("terminates the transport when a native tool item starts", async () => {
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        notify(current.child, "item/started", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "command-1", type: "commandExecution", command: "unsafe" },
        });
      }
    });

    await expect(harness.runtime.startTurn({ text: "Do not execute tools" })).rejects.toMatchObject({
      code: "codex-operation-failed",
    });

    expect(methodMessages(harness, "turn/interrupt")[0]?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(harness.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("constructs a credential-free, isolated Windows child environment", () => {
    const environment = sanitizedCodexConversationEnvironment(
      "C:\\isolated\\home",
      "C:\\isolated\\sqlite",
      "C:\\isolated\\temp",
      {
        PATH: "C:\\host-tools",
        OPENAI_API_KEY: "secret-api-key",
        CODEX_HOME: "C:\\host-home",
        HTTP_PROXY: "http://proxy.example",
        NODE_OPTIONS: "--require C:\\host-hook.js",
        SystemRoot: "C:\\host-windows",
        LANG: "ko_KR.UTF-8",
      },
      "win32",
    );

    expect(environment).toMatchObject({
      CODEX_HOME: "C:\\isolated\\home",
      CODEX_SQLITE_HOME: "C:\\isolated\\sqlite",
      HOME: "C:\\isolated\\home",
      USERPROFILE: "C:\\isolated\\home",
      APPDATA: "C:\\isolated\\home",
      LOCALAPPDATA: "C:\\isolated\\home",
      TEMP: "C:\\isolated\\temp",
      TMP: "C:\\isolated\\temp",
      TMPDIR: "C:\\isolated\\temp",
      LANG: "ko_KR.UTF-8",
    });
    expect(environment.PATH).not.toContain("host-tools");
    expect(JSON.stringify(environment)).not.toContain("secret-api-key");
    expect(JSON.stringify(environment)).not.toContain("host-home");
    expect(JSON.stringify(environment)).not.toContain("proxy.example");
    expect(JSON.stringify(environment)).not.toContain("host-hook.js");
    expect(JSON.stringify(environment)).not.toContain("host-windows");
  });
  it("declines all server approvals and rejects unsupported reverse-RPC without exposing raw request payloads", async () => {
    const observations: unknown[] = [];
    let sentRequests = false;
    let repliesSeen = 0;
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        sentRequests = true;
        serverRequest(current.child, "command-1", "item/commandExecution/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          command: "type C:\\Users\\secret.txt",
          cwd: "C:\\Users\\sensitive-project",
        });
        serverRequest(current.child, "file-1", "item/fileChange/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-1",
          grantRoot: "C:\\Users\\sensitive-project",
        });
        serverRequest(current.child, "permission-1", "item/permissions/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "permission-1",
          cwd: "C:\\Users\\sensitive-project",
          permissions: { filesystem: { roots: ["C:\\Users\\sensitive-project"] } },
        });
        serverRequest(current.child, "tool-1", "item/tool/call", {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-1",
          namespace: null,
          tool: "untrusted_tool",
          arguments: { token: "runtime-secret" },
        });
        return;
      }
      if (typeof message.id === "string" && sentRequests) {
        repliesSeen += 1;
        if (repliesSeen === 4) {
          notify(current.child, "turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          });
        }
      }
    });

    await expect(harness.runtime.startTurn(
      { text: "Work safely" },
      { onServerRequest: (request) => observations.push(request) },
    )).resolves.toMatchObject({ status: "completed" });

    const serverReplies = harness.messages.filter((message) => typeof message.id === "string");
    expect(serverReplies).toEqual(expect.arrayContaining([
      { id: "command-1", result: { decision: "decline" } },
      { id: "file-1", result: { decision: "decline" } },
      { id: "permission-1", result: { permissions: [], scope: "turn" } },
      { id: "tool-1", error: { code: -32601, message: "Unsupported request" } },
    ]));
    expect(observations).toEqual([
      {
        kind: "command-approval",
        method: "item/commandExecution/requestApproval",
        requestId: "command-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
      },
      {
        kind: "file-change-approval",
        method: "item/fileChange/requestApproval",
        requestId: "file-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-1",
      },
      {
        kind: "permissions-approval",
        method: "item/permissions/requestApproval",
        requestId: "permission-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permission-1",
      },
      {
        kind: "dynamic-tool",
        method: "item/tool/call",
        requestId: "tool-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: null,
      },
    ]);
    const observationJson = JSON.stringify(observations);
    expect(observationJson).not.toContain("secret.txt");
    expect(observationJson).not.toContain("sensitive-project");
    expect(observationJson).not.toContain("runtime-secret");
  });

  it("keeps native command, file, and permission approvals deny-only with dynamic tools enabled", async () => {
    const dynamicTools = [{
      name: "lvis_echo",
      description: "Returns a value only through the LVIS host bridge.",
      inputSchema: { type: "object" as const, properties: {} },
    }] as const;
    const onDynamicToolCall = vi.fn(async () => "must not run");
    let nativeReplies = 0;
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        serverRequest(current.child, "native-command", "item/commandExecution/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "native-command",
          command: "unsafe command must never reach LVIS",
        });
        serverRequest(current.child, "native-file", "item/fileChange/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "native-file",
          changes: [],
        });
        serverRequest(current.child, "native-permission", "item/permissions/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "native-permission",
          permissions: { network: true },
        });
        return;
      }
      if (
        message.id === "native-command"
        || message.id === "native-file"
        || message.id === "native-permission"
      ) {
        nativeReplies += 1;
        if (nativeReplies === 3) {
          notify(current.child, "turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          });
        }
      }
    });

    await expect(harness.runtime.startTurn(
      { text: "Keep native capabilities denied", dynamicTools },
      { onDynamicToolCall },
    )).resolves.toEqual({ threadId: "thread-1", turnId: "turn-1", status: "completed" });

    expect(methodMessages(harness, "thread/start")[0]?.params).toMatchObject({
      dynamicTools: [{ type: "function", name: "lvis_echo" }],
    });
    expect(harness.messages).toEqual(expect.arrayContaining([
      { id: "native-command", result: { decision: "decline" } },
      { id: "native-file", result: { decision: "decline" } },
      { id: "native-permission", result: { permissions: [], scope: "turn" } },
    ]));
    expect(onDynamicToolCall).not.toHaveBeenCalled();
  });

  it("uses turn/interrupt and waits for the authoritative interrupted completion", async () => {
    let turnStartSeen: (() => void) | null = null;
    const waitForTurnStart = new Promise<void>((resolveTurnStart) => {
      turnStartSeen = resolveTurnStart;
    });
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        turnStartSeen?.();
        return;
      }
      if (message.method === "turn/interrupt") {
        reply(current.child, requestId(message), {});
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted" },
        });
      }
    });

    const turn = harness.runtime.startTurn({ text: "Cancel this turn" });
    await waitForTurnStart;
    await new Promise<void>((resolveTurnStart) => setImmediate(resolveTurnStart));
    await harness.runtime.interrupt();

    await expect(turn).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "interrupted",
    });
    expect(methodMessages(harness, "turn/interrupt")[0]?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("dispatches turn/interrupt when cancellation races the turn/start response", async () => {
    let deferredTurnStart: JsonRecord | null = null;
    let signalTurnStart: () => void = () => {};
    const turnStartReceived = new Promise<void>((resolveTurnStart) => {
      signalTurnStart = resolveTurnStart;
    });
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        deferredTurnStart = message;
        signalTurnStart();
        return;
      }
      if (message.method === "turn/interrupt") {
        reply(current.child, requestId(message), {});
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted" },
        });
      }
    });

    const turn = harness.runtime.startTurn({ text: "Cancel before the turn starts" });
    await turnStartReceived;
    const interrupt = harness.runtime.interrupt();
    await Promise.resolve();
    expect(methodMessages(harness, "turn/interrupt")).toHaveLength(0);

    const turnStart = deferredTurnStart;
    if (!turnStart) throw new Error("missing-turn-start-request");
    reply(harness.child, requestId(turnStart), { turn: { id: "turn-1", status: "inProgress" } });

    await vi.waitFor(() => expect(methodMessages(harness, "turn/interrupt")).toHaveLength(1));
    await interrupt;
    await expect(turn).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "interrupted",
    });
  });

  it("does not leave interrupt pending when completion precedes the turn/start response", async () => {
    let deferredTurnStart: JsonRecord | null = null;
    let signalTurnStart: () => void = () => {};
    const turnStartReceived = new Promise<void>((resolveTurnStart) => {
      signalTurnStart = resolveTurnStart;
    });
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        deferredTurnStart = message;
        signalTurnStart();
      }
    });

    const turn = harness.runtime.startTurn({ text: "Complete before the start response" });
    await turnStartReceived;
    const interrupt = harness.runtime.interrupt();
    notify(harness.child, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    });

    await interrupt;
    expect(methodMessages(harness, "turn/interrupt")).toHaveLength(0);
    const turnStart = deferredTurnStart;
    if (!turnStart) throw new Error("missing-turn-start-request");
    reply(harness.child, requestId(turnStart), { turn: { id: "turn-1", status: "inProgress" } });
    await expect(turn).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "interrupted",
    });
  });

  it("rejects a pending turn and force-kills the managed child on shutdown", async () => {
    let turnStartSeen: (() => void) | null = null;
    const waitForTurnStart = new Promise<void>((resolveTurnStart) => {
      turnStartSeen = resolveTurnStart;
    });
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        turnStartSeen?.();
      }
    });

    const turn = harness.runtime.startTurn({ text: "Do not leave a child alive" });
    await waitForTurnStart;
    const rejectedTurn = expect(turn).rejects.toMatchObject({ code: "codex-operation-failed" });
    harness.runtime.stop();

    await rejectedTurn;
    expect(harness.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(harness.runtime.getThreadId()).toBeNull();
    expect(harness.runtime.isTurnActive()).toBe(false);
  });
  it("bridges a declared LVIS ToolSchema call through the active turn only", async () => {
    const dynamicTools = [{
      name: "lvis_echo",
      description: "Returns the provided value through LVIS governance.",
      inputSchema: {
        type: "object" as const,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    }] as const;
    const onDynamicToolCall = vi.fn(async (call) => {
      expect(call).toEqual({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "lvis_echo",
        arguments: { value: "hello" },
      });
      return "LVIS tool result.";
    });
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        notify(current.child, "item/started", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "dynamic-item-1",
            type: "dynamicToolCall",
            namespace: null,
            tool: "lvis_echo",
            arguments: { value: "hello" },
          },
        });
        serverRequest(current.child, "lvis-rpc-1", "item/tool/call", {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "lvis_echo",
          arguments: { value: "hello" },
        });
        return;
      }
      if (message.id === "lvis-rpc-1") {
        expect(message).toEqual({
          id: "lvis-rpc-1",
          result: {
            contentItems: [{ type: "inputText", text: "LVIS tool result." }],
            success: true,
          },
        });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
    });

    await expect(harness.runtime.startTurn(
      { text: "Use the LVIS tool", dynamicTools },
      { onDynamicToolCall },
    )).resolves.toEqual({ threadId: "thread-1", turnId: "turn-1", status: "completed" });

    expect(onDynamicToolCall).toHaveBeenCalledTimes(1);
    expect(methodMessages(harness, "initialize")[0]?.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    expect(methodMessages(harness, "thread/start")[0]?.params).toMatchObject({
      dynamicTools: [{
        type: "function",
        name: "lvis_echo",
        description: "Returns the provided value through LVIS governance.",
        inputSchema: dynamicTools[0].inputSchema,
      }],
    });
    expect(harness.child.kill).not.toHaveBeenCalled();
  });

  it("rejects malformed dynamic tool requests without invoking LVIS", async () => {
    const onDynamicToolCall = vi.fn(async () => "must not run");
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        serverRequest(current.child, "malformed-rpc", "item/tool/call", {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "lvis_echo",
        });
        return;
      }
      if (message.id === "malformed-rpc") {
        expect(message).toEqual({
          id: "malformed-rpc",
          error: { code: -32602, message: "Invalid dynamic tool request" },
        });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
    });

    await expect(harness.runtime.startTurn(
      {
        text: "Reject malformed request",
        dynamicTools: [{
          name: "lvis_echo",
          description: "LVIS only",
          inputSchema: { type: "object", properties: {} },
        }],
      },
      { onDynamicToolCall },
    )).resolves.toMatchObject({ status: "completed" });

    expect(onDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects a dynamic tool request for another thread or turn", async () => {
    const onDynamicToolCall = vi.fn(async () => "must not run");
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        notify(current.child, "item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "assistant-item-1",
          delta: "Primed active turn.",
        });
        serverRequest(current.child, "mismatch-thread-rpc", "item/tool/call", {
          threadId: "thread-other",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "lvis_echo",
          arguments: { value: "untrusted" },
        });
        return;
      }
      if (message.id === "mismatch-thread-rpc") {
        expect(message).toEqual({
          id: "mismatch-thread-rpc",
          error: { code: -32602, message: "Invalid dynamic tool request" },
        });
        serverRequest(current.child, "mismatch-turn-rpc", "item/tool/call", {
          threadId: "thread-1",
          turnId: "turn-other",
          callId: "call-2",
          namespace: null,
          tool: "lvis_echo",
          arguments: { value: "untrusted" },
        });
        return;
      }
      if (message.id === "mismatch-turn-rpc") {
        expect(message).toEqual({
          id: "mismatch-turn-rpc",
          error: { code: -32602, message: "Invalid dynamic tool request" },
        });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
    });

    await expect(harness.runtime.startTurn(
      {
        text: "Reject mismatched request",
        dynamicTools: [{
          name: "lvis_echo",
          description: "LVIS only",
          inputSchema: { type: "object", properties: {} },
        }],
      },
      { onDynamicToolCall },
    )).resolves.toMatchObject({ status: "completed" });

    expect(onDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects unknown dynamic tools even for the active LVIS turn", async () => {
    const onDynamicToolCall = vi.fn(async () => "must not run");
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") {
        reply(current.child, requestId(message), { thread: { id: "thread-1" } });
        return;
      }
      if (message.method === "turn/start") {
        reply(current.child, requestId(message), { turn: { id: "turn-1", status: "inProgress" } });
        serverRequest(current.child, "unknown-rpc", "item/tool/call", {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "unknown_lvis_tool",
          arguments: { value: "untrusted" },
        });
        return;
      }
      if (message.id === "unknown-rpc") {
        expect(message).toEqual({
          id: "unknown-rpc",
          error: { code: -32601, message: "Unsupported request" },
        });
        notify(current.child, "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
    });

    await expect(harness.runtime.startTurn(
      {
        text: "Reject unknown tool",
        dynamicTools: [{
          name: "lvis_echo",
          description: "LVIS only",
          inputSchema: { type: "object", properties: {} },
        }],
      },
      { onDynamicToolCall },
    )).resolves.toMatchObject({ status: "completed" });

    expect(onDynamicToolCall).not.toHaveBeenCalled();
  });
  it("does not start a Codex thread or turn when aborted during initialization", async () => {
    let initializeRequest: JsonRecord | undefined;
    const harness = createHarness((message) => {
      if (message.method === "initialize") initializeRequest = message;
    });
    const abortController = new AbortController();
    const pendingTurn = harness.runtime.startTurn({
      text: "cancel during startup",
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => expect(initializeRequest).toBeDefined());
    abortController.abort();
    if (!initializeRequest) throw new Error("missing-initialize-request");
    reply(harness.child, requestId(initializeRequest), {});

    await expect(pendingTurn).rejects.toMatchObject({ name: "AbortError" });
    expect(methodMessages(harness, "thread/start")).toHaveLength(0);
    expect(methodMessages(harness, "turn/start")).toHaveLength(0);
  });

  it("does not start a Codex turn when aborted while creating its thread", async () => {
    let threadStartRequest: JsonRecord | undefined;
    const harness = createHarness((message, current) => {
      if (message.method === "initialize") {
        reply(current.child, requestId(message), {});
        return;
      }
      if (message.method === "thread/start") threadStartRequest = message;
    });
    const abortController = new AbortController();
    const pendingTurn = harness.runtime.startTurn({
      text: "cancel during thread setup",
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => expect(threadStartRequest).toBeDefined());
    abortController.abort();
    if (!threadStartRequest) throw new Error("missing-thread-start-request");
    reply(harness.child, requestId(threadStartRequest), { thread: { id: "thread-1" } });

    await expect(pendingTurn).rejects.toMatchObject({ name: "AbortError" });
    expect(methodMessages(harness, "turn/start")).toHaveLength(0);
  });
});
