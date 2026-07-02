import { vi } from "vitest";

export function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

type RegisteredHandler = (...args: unknown[]) => unknown;

export function invokeRegisteredHandler<T = unknown>(
  handlers: Map<string, RegisteredHandler>,
  channel: string,
  ...args: unknown[]
): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(null, ...args) as T;
}

export function invokeRegisteredHandlerWithEvent<T = unknown>(
  handlers: Map<string, RegisteredHandler>,
  channel: string,
  event: unknown,
  ...args: unknown[]
): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(event, ...args) as T;
}

export function makeMockPermissionManager() {
  return {
    getMode: vi.fn(() => "default"),
    setModePersist: vi.fn(),
    listPersistedRules: vi.fn(async () => []),
    addAlwaysAllowedPersist: vi.fn(),
    addAlwaysDeniedPersist: vi.fn(),
    removeRule: vi.fn(),
    getVisibilityDenyRules: vi.fn(() => []),
  };
}

export function makeMockConversationLoop(
  permissionManager: ReturnType<typeof makeMockPermissionManager>,
) {
  return {
    permissionManager,
    hasProvider: vi.fn(),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    getSessionId: vi.fn(() => "s1"),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
  };
}

export function makeMockApprovalGate() {
  return { resolve: vi.fn(), setPolicy: vi.fn() };
}

export function withPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
