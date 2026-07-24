import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<
      string,
      Array<{ callback: (...args: unknown[]) => void; once: boolean }>
    >();

    on(event: string, callback: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push({ callback, once: false });
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, callback: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push({ callback, once: true });
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      const listeners = [...(this.listeners.get(event) ?? [])];
      this.listeners.set(
        event,
        listeners.filter((listener) => !listener.once),
      );
      for (const listener of listeners) listener.callback(...args);
    }
  }

  const order: string[] = [];
  const sessions = new Map<string, {
    setUserAgent: ReturnType<typeof vi.fn>;
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    clearStorageData: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
    clearAuthCache: ReturnType<typeof vi.fn>;
  }>();
  const windows: FakeBrowserWindow[] = [];

  class FakeBrowserWindow extends Emitter {
    readonly webContents = Object.assign(new Emitter(), {
      setWindowOpenHandler: vi.fn(),
    });
    private destroyed = false;
    readonly setMenu = vi.fn();
    readonly show = vi.fn();
    readonly loadURL = vi.fn(async () => undefined);

    constructor(_options: unknown) {
      super();
      windows.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    destroy(): void {
      if (this.destroyed) return;
      order.push("viewer:destroy");
      this.destroyed = true;
      this.emit("closed");
    }
  }

  const fromPartition = vi.fn((partition: string) => {
    let session = sessions.get(partition);
    if (!session) {
      session = {
        setUserAgent: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        on: vi.fn(),
        clearStorageData: vi.fn(async () => {
          order.push("partition:storage");
        }),
        clearCache: vi.fn(async () => {
          order.push("partition:cache");
        }),
        clearAuthCache: vi.fn(async () => {
          order.push("partition:auth-cache");
        }),
      };
      sessions.set(partition, session);
    }
    return session;
  });

  return {
    FakeBrowserWindow,
    fromPartition,
    order,
    sessions,
    windows,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMocks.FakeBrowserWindow,
  screen: {},
  session: { fromPartition: electronMocks.fromPartition },
}));

const {
  __internals,
  openAuthPartitionViewer,
} = await import("../auth-partition-viewer-service.js");
const { clearAuthPartition } = await import("../auth-window-service.js");

describe("auth partition viewer cleanup", () => {
  beforeEach(() => {
    electronMocks.order.length = 0;
    electronMocks.windows.length = 0;
    electronMocks.sessions.clear();
    electronMocks.fromPartition.mockClear();
  });

  it("destroys live viewers before clearing persistent auth storage", async () => {
    const pluginId = "ep-api";
    const partition = `persist:plugin-auth:${encodeURIComponent(pluginId)}`;
    const opened = openAuthPartitionViewer({
      pluginId,
      url: "https://portal.example.com/home",
      allowedHosts: ["portal.example.com"],
    });
    const viewer = electronMocks.windows[0]!;
    viewer.emit("ready-to-show");
    await opened;
    expect(__internals.activeViewerCount(partition)).toBe(1);

    await clearAuthPartition(partition);

    expect(electronMocks.order).toEqual([
      "viewer:destroy",
      "partition:storage",
      "partition:cache",
      "partition:auth-cache",
    ]);
    expect(__internals.activeViewerCount(partition)).toBe(0);
  });

  it("rejects a new viewer until partition clearing has completed", async () => {
    const pluginId = "ep-api";
    const partition = `persist:plugin-auth:${encodeURIComponent(pluginId)}`;
    const opened = openAuthPartitionViewer({
      pluginId,
      url: "https://portal.example.com/home",
      allowedHosts: ["portal.example.com"],
    });
    electronMocks.windows[0]!.emit("ready-to-show");
    await opened;

    let releaseClear!: () => void;
    let clearEntered!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      clearEntered = resolve;
    });
    electronMocks.sessions
      .get(partition)!
      .clearStorageData.mockImplementationOnce(async () => {
        electronMocks.order.push("partition:storage");
        clearEntered();
        await clearGate;
      });

    const clearing = clearAuthPartition(partition);
    await clearStarted;
    await expect(openAuthPartitionViewer({
      pluginId,
      url: "https://portal.example.com/home",
      allowedHosts: ["portal.example.com"],
    })).rejects.toThrow(/partition cleanup is in progress/);

    releaseClear();
    await clearing;
    expect(electronMocks.windows).toHaveLength(1);
    expect(__internals.activeViewerCount(partition)).toBe(0);
  });
});
