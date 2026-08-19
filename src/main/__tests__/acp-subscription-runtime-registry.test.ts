import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpSubscriptionRuntimeConfigStore } from "../acp-subscription-runtime-config.js";
import { AcpSubscriptionRuntimeClient } from "../acp-subscription-runtime-client.js";
import {
  AcpSubscriptionRuntimeRegistry,
  type AcpSubscriptionSessionClientFactory,
  type AcpSubscriptionSessionTransport,
} from "../acp-subscription-runtime-registry.js";
import type { AcpSubscriptionPromptHandle } from "../acp-subscription-session-client.js";
import type { AcpSubscriptionProviderId } from "../../shared/acp-subscription.js";
import type { AcpSubscriptionMcpServerConfig } from "../acp-subscription-runtime-config.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const roots: string[] = [];

function testNamespace(root: string): FeatureNamespaceHandle {
  return {
    get dir(): string {
      return root;
    },
    async readJson<T>(_name: string, fallback: T): Promise<T> {
      return fallback;
    },
    async writeJson<T>(_name: string, _value: T): Promise<void> {},
    async childDir(name: string): Promise<string> {
      const directory = join(root, name);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
  };
}

function configuredClient(provider: AcpSubscriptionProviderId, root: string): AcpSubscriptionRuntimeClient {
  return new AcpSubscriptionRuntimeClient({
    provider,
    runtimeHome: join(root, `client-${provider}-home`),
    workspaceDir: join(root, `client-${provider}-workspace`),
    runtimeTempDir: join(root, `client-${provider}-tmp`),
    executablePath: `C:\\approved\\${provider}.exe`,
    resolveExecutable: async (path) => path,
    platform: "win32",
  });
}

class FakeSession implements AcpSubscriptionSessionTransport {
  readonly start = vi.fn(async (): Promise<unknown> => ({}));
  readonly cancelActivePrompt = vi.fn(async (): Promise<void> => {});
  readonly stop = vi.fn(async (): Promise<void> => {});

  async startPrompt(_input: { readonly text: string; readonly abortSignal?: AbortSignal }): Promise<AcpSubscriptionPromptHandle> {
    return {
      events: (async function* () {
        yield { type: "text_delta", text: "connected answer" } as const;
        yield { type: "message_complete", stopReason: "end_turn" } as const;
      })(),
      completion: Promise.resolve({ stopReason: "end_turn" }),
      cancel: async (): Promise<void> => {},
    };
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
  vi.restoreAllMocks();
});

describe("AcpSubscriptionRuntimeRegistry text sessions", () => {
  it("prepares an isolated v6 Grok runtime, streams through one session, and stops it with the registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-acp-registry-"));
    roots.push(root);
    const namespace = testNamespace(root);
    const sessions: FakeSession[] = [];
    const receivedOptions: Parameters<AcpSubscriptionSessionClientFactory>[0][] = [];
    const sessionClientFactory: AcpSubscriptionSessionClientFactory = (options) => {
      receivedOptions.push(options);
      const session = new FakeSession();
      sessions.push(session);
      return session;
    };
    const registry = await AcpSubscriptionRuntimeRegistry.create({
      namespace,
      configStore: new AcpSubscriptionRuntimeConfigStore(namespace),
      clients: {
        "kimi-code": configuredClient("kimi-code", root),
        "grok-build": configuredClient("grok-build", root),
      },
      sessionClientFactory,
    });
    const onHostRequest = vi.fn();

    const mcpServers: readonly AcpSubscriptionMcpServerConfig[] = [{
      name: "lvis-subscription-tools",
      command: process.execPath,
      args: ["--lvis-acp-mcp", "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }];
    const session = await registry.openTextSession("grok-build", { onHostRequest, mcpServers });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toHaveBeenCalledOnce();
    expect(receivedOptions[0]).toMatchObject({
      provider: "grok-build",
      executablePath: "C:\\approved\\grok-build.exe",
      runtimeHome: join(root, "acp-v8-grok-build-home"),
      workspaceDir: join(root, "acp-v8-grok-build-workspace"),
      runtimeTempDir: join(root, "acp-v8-grok-build-tmp"),
      mcpServers,
    });
    expect(receivedOptions[0]?.onHostRequest).toBe(onHostRequest);
    expect(readFileSync(join(root, "acp-v8-grok-build-home", "requirements.toml"), "utf8"))
      .toContain('auto_update = false');

    const events = [];
    for await (const event of session.streamTurn("hello")) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "connected answer" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    await session.cancelActiveTurn();
    expect(sessions[0]?.cancelActivePrompt).toHaveBeenCalledOnce();

    await registry.stopAll();
    expect(sessions[0]?.stop).toHaveBeenCalledOnce();
  });
});
