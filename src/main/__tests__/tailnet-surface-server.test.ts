import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { TailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import {
  DEFAULT_TAILNET_OBSERVER_PORT,
  getTailnetPairedSharingRuntime,
  maybeStartTailnetObserverServer,
  resetTailnetObserverServerForTests,
  resolveTailnetObserverConfig,
  stopTailnetObserverServer,
} from "../tailnet-surface-server.js";

const CAPABILITY = "lvis.example.com/cap/conversation-observer";
const WEB_ORIGIN = "https://lvis.example.ts.net";

function runtime(): ConversationSurfaceRuntime {
  return {
    sharedProjection: {},
  } as ConversationSurfaceRuntime;
}

function options(
  env: NodeJS.ProcessEnv,
  startServer = vi.fn(async (input: { port: number }) => ({
    host: "127.0.0.1" as const,
    port: input.port,
    close: vi.fn(async () => undefined),
  })),
) {
  return {
    startServer,
    input: {
      conversationSurfaceRuntime: runtime(),
      getCurrentConversationId: () => "main-session",
      isConversationBusy: () => false,
      env,
      dependencies: { startServer: startServer as never },
    },
  };
}

afterEach(async () => {
  await stopTailnetObserverServer();
  resetTailnetObserverServerForTests();
});

describe("Tailnet observer lifecycle", () => {
  it("is default OFF and has zero listener construction effect", async () => {
    const f = options({});
    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toBeNull();
    expect(f.startServer).not.toHaveBeenCalled();
  });

  it("requires explicit owned capability and a valid fixed port when enabled", () => {
    expect(resolveTailnetObserverConfig({})).toBeNull();
    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
    })).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      expectedAppCapability: CAPABILITY,
      controllerEnabled: false,
      pairedSharingEnabled: false,
    });

    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
      LVIS_TAILNET_PAIRED_SHARING: "1",
    })).toMatchObject({
      pairedSharingEnabled: true,
    });

    // The controller needs the pairing boundary, so it is only valid WITH
    // paired sharing — the same coupling the web adapter already requires.
    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
      LVIS_TAILNET_CONTROLLER: "1",
      LVIS_TAILNET_PAIRED_SHARING: "1",
    })).toMatchObject({
      controllerEnabled: true,
      pairedSharingEnabled: true,
    });
    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
      LVIS_TAILNET_PAIRED_SHARING: "1",
      LVIS_TAILNET_WEB: "1",
      LVIS_TAILNET_WEB_ORIGIN: WEB_ORIGIN,
    })).toMatchObject({
      pairedSharingEnabled: true,
      webOrigin: WEB_ORIGIN,
    });



    for (const env of [
      { LVIS_TAILNET_OBSERVER: "1" },
      { LVIS_TAILNET_OBSERVER: "1", LVIS_TAILNET_OBSERVER_CAP: "__proto__" },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_OBSERVER_PORT: "0",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_OBSERVER_PORT: "65536",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_CONTROLLER: "true",
      },
      // Controller enabled (valid "1") but WITHOUT paired sharing — the new
      // coupling gate rejects it rather than leaving the native routes ungated.
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_CONTROLLER: "1",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_PAIRED_SHARING: "true",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_WEB: "true",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_WEB: "1",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_PAIRED_SHARING: "1",
        LVIS_TAILNET_WEB: "1",
        LVIS_TAILNET_WEB_ORIGIN: "http://lvis.example.ts.net",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
        LVIS_TAILNET_PAIRED_SHARING: "1",
        LVIS_TAILNET_WEB: "1",
        LVIS_TAILNET_WEB_ORIGIN: WEB_ORIGIN + "/path",
      },

    ]) {
      expect(() => resolveTailnetObserverConfig(env)).toThrow();
    }
  });
  it("uses one injected paired-sharing runtime for the listener and main lifecycle", async () => {
    const claimInvitation = vi.fn(async () => ({ expiresAt: 123_456 }));
    const pairedRuntime = {
      store: { claimInvitation },
      authorizer: {
        actorIdFor: vi.fn(),
        authorize: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
    } as unknown as TailnetPairedSharingRuntime;
    const f = options({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
      LVIS_TAILNET_PAIRED_SHARING: "1",
      LVIS_TAILNET_WEB: "1",
      LVIS_TAILNET_WEB_ORIGIN: WEB_ORIGIN,

    });

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      tailnetPairedSharingRuntime: pairedRuntime,
    })).resolves.toEqual({ port: DEFAULT_TAILNET_OBSERVER_PORT });

    expect(getTailnetPairedSharingRuntime()).toBe(pairedRuntime);
    const serverOptions = f.startServer.mock.calls[0]?.[0] as {
      pairedSharing?: unknown;
      pairing?: { claimInvitation?: (code: string, actorId: `tailnet:${string}`) => Promise<unknown> };
      web?: { origin?: string };
    };
    expect(serverOptions.pairedSharing).toBe(pairedRuntime.authorizer);
    expect(serverOptions.pairing?.claimInvitation).toBeTypeOf("function");
    expect(serverOptions.web).toEqual({ origin: WEB_ORIGIN });
    await expect(serverOptions.pairing?.claimInvitation?.(
      "lvis-pair-v1." + "a".repeat(43),
      ("tailnet:" + "b".repeat(64)) as `tailnet:${string}`,
    )).resolves.toEqual({ expiresAt: 123_456 });
    expect(claimInvitation).toHaveBeenCalledOnce();
  });
  it("fails closed when P2 bootstrap could not create the shared runtime", async () => {
    const f = options({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
      LVIS_TAILNET_PAIRED_SHARING: "1",
    });

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      tailnetPairedSharingRuntime: null,
    })).rejects.toThrow("tailnet-paired-sharing-runtime-unavailable");
    expect(f.startServer).not.toHaveBeenCalled();
    expect(getTailnetPairedSharingRuntime()).toBeNull();
  });



  it("starts only the separate literal-loopback observer and closes it idempotently", async () => {
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async (input: { port: number }) => ({
      host: "127.0.0.1" as const,
      port: input.port,
      close,
    }));
    const f = options({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
      LVIS_TAILNET_OBSERVER_PORT: "46174",
    }, startServer);

    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toEqual({ port: 46174 });
    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toEqual({ port: 46174 });
    expect(startServer).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 46174,
      expectedAppCapability: CAPABILITY,
      projectionStore: f.input.conversationSurfaceRuntime.sharedProjection,
    }));

    await Promise.all([
      stopTailnetObserverServer(),
      stopTailnetObserverServer(),
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a listener that finishes starting after shutdown begins", async () => {
    let resolveServer: ((value: {
      host: "127.0.0.1";
      port: number;
      close: () => Promise<void>;
    }) => void) | undefined;
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(() => new Promise<{
      host: "127.0.0.1";
      port: number;
      close: () => Promise<void>;
    }>((resolve) => {
      resolveServer = resolve;
    }));
    const f = options({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
    }, startServer as never);

    const starting = maybeStartTailnetObserverServer(f.input);
    const stopping = stopTailnetObserverServer();
    resolveServer?.({
      host: "127.0.0.1",
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      close,
    });

    await expect(starting).resolves.toBeNull();
    await stopping;
    expect(close).toHaveBeenCalledOnce();
  });
});
