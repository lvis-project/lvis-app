import { vi } from "vitest";

export function makeAuthLoginMockupDeps() {
  return {
    settingsService: {
      get: vi.fn(() => ({
        provider: "openai",
        vendors: { openai: { model: "gpt-4o" } },
      })),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      replaceLlm: vi.fn(async () => undefined),
    },
    auditLogger: { log: vi.fn() },
    conversationLoop: { refreshProvider: vi.fn() },
    rewireReviewerAgent: vi.fn(),
    refreshActiveLlmWildcard: vi.fn(),
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
      { frameId: 0, processId: 0, frame: { url: "lvis://app" } } as never,
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
