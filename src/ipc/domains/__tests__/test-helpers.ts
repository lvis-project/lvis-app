import { vi } from "vitest";

export function makeAuthLoginMockupDeps() {
  // Stateful secret store so `getSecret` reflects what `setSecret` wrote. The
  // `settings:has-api-key` gate (which decides whether the login modal
  // re-appears on the next boot) is exactly `getSecret("llm.apiKey.<vendor>")
  // !== null`, so a stateful mock lets a test lock the post-activation gate
  // (e.g. activate-ollama → the ollama key is present) instead of only
  // asserting the setSecret call shape.
  const secrets = new Map<string, string>();
  return {
    settingsService: {
      get: vi.fn(() => ({
        provider: "openai",
        vendors: { openai: { model: "gpt-4o" } },
      })),
      getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
      setSecret: vi.fn(async (key: string, value: string) => {
        secrets.set(key, value);
      }),
      deleteSecret: vi.fn(async (key: string) => {
        secrets.delete(key);
      }),
      patch: vi.fn(async () => undefined),
      replaceLlm: vi.fn(async () => undefined),
    },
    auditLogger: { log: vi.fn() },
    conversationLoop: { refreshProvider: vi.fn() },
    rewireReviewerAgent: vi.fn(),
    refreshActiveLlmWildcard: vi.fn(),
    refreshSandboxNetworkConfig: vi.fn(),
  };
}

export function invokeAppIpcHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      {
        frameId: 0,
        processId: 0,
        frame: { url: "file:///app/index.html" },
        senderFrame: { url: "file:///app/index.html" },
      } as never,
      ...args,
    ),
  );
}

export function makeAppIpcInvoker(
  handlers: Map<string, (...args: unknown[]) => unknown>,
) {
  return (channel: string, ...args: unknown[]): Promise<unknown> =>
    invokeAppIpcHandler(handlers, channel, ...args);
}

export function invokeFileIpcHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      {
        frameId: 0,
        processId: 0,
        senderFrame: { url: "file:///app/index.html" },
      } as never,
      ...args,
    ),
  );
}

export async function loadAuthHandlersForMockup() {
  const demoMod = await import("../../../main/demo-credentials.js");
  demoMod.resetDemoCredentialsForTesting();
  demoMod.captureDemoCredentials();
  return await import("../auth.js");
}
