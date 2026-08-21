import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { TailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import {
  DEFAULT_TAILNET_OBSERVER_PORT,
  getTailnetPairedSharingRuntime,
  loadTailnetObserverConfig,
  maybeStartTailnetObserverServer,
  parseTailnetObserverConfigFile,
  resetTailnetObserverServerForTests,
  resolveTailnetObserverConfig,
  stopTailnetObserverServer,
  type TailnetObserverConfigFile,
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
      dependencies: {
        startServer: startServer as never,
        // This matrix asks an environment question. Reading the real
        // host-owned file would make the answer depend on whether the
        // developer running it happens to have an observer configured.
        readConfigFile: async () => null,
      },
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
    // Resolving the configuration reads the host-owned file, so listener
    // construction is no longer reached within the caller's own tick. Wait for
    // it rather than assuming: this case is about the shutdown race, and a
    // `resolveServer` that is still undefined would hang instead of failing.
    await vi.waitFor(() => expect(startServer).toHaveBeenCalled());
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

describe("Tailnet observer configuration surface", () => {
  const file = (config: TailnetObserverConfigFile) => async () => config;

  it("boots from the host-owned file with no environment at all", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        expectedAppCapability: CAPABILITY,
        pairedSharingEnabled: true,
      }),
    });

    expect(resolution.config).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      expectedAppCapability: CAPABILITY,
      controllerEnabled: false,
      pairedSharingEnabled: true,
    });
    expect(resolution.fileConfigured).toBe(true);
    expect(resolution.provenance.enabled).toBe("file");
    // Defaulted, not configured: the surface must not claim the file chose it.
    expect(resolution.provenance.port).toBe("unset");
  });

  it("stays OFF and side-effect free when neither source enables it", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: {},
      readConfigFile: async () => null,
    });

    expect(resolution.config).toBeNull();
    expect(resolution.fileConfigured).toBe(false);
    expect(new Set(Object.values(resolution.provenance))).toEqual(new Set(["unset"]));
  });

  it("lets an env var override the file per key, and says which key it took", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: { LVIS_TAILNET_OBSERVER_PORT: "47000" },
      readConfigFile: file({
        enabled: true,
        expectedAppCapability: CAPABILITY,
        port: 46_500,
      }),
    });

    expect(resolution.config?.port).toBe(47_000);
    expect(resolution.provenance.port).toBe("env-override");
    expect(resolution.provenance.expectedAppCapability).toBe("file");
  });

  it("lets the environment turn a file-enabled observer back off", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: { LVIS_TAILNET_OBSERVER: "0" },
      readConfigFile: file({ enabled: true, expectedAppCapability: CAPABILITY }),
    });

    expect(resolution.config).toBeNull();
    expect(resolution.provenance.enabled).toBe("env-override");
  });

  it("puts the file through the same gates the environment goes through", async () => {
    // One vocabulary, one validator: the file cannot admit a port, a capability
    // key, or a scope combination the env form would have rejected.
    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({ enabled: true, expectedAppCapability: CAPABILITY, port: 65_536 }),
    })).rejects.toThrow("tailnet-observer-port-invalid");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({ enabled: true, expectedAppCapability: "__proto__" }),
    })).rejects.toThrow("tailnet-observer-capability-missing-or-invalid");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        expectedAppCapability: CAPABILITY,
        controllerEnabled: true,
      }),
    })).rejects.toThrow("tailnet-controller-requires-paired-sharing");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        expectedAppCapability: CAPABILITY,
        pairedSharingEnabled: true,
        webEnabled: true,
      }),
    })).rejects.toThrow("tailnet-web-origin-missing-or-invalid");
  });

  it("rejects a malformed file rather than booting a half-applied config", () => {
    for (const raw of [
      [],
      "enabled",
      { enabled: "1" },
      { enabled: true, port: "46173" },
      { enabled: true, unknownKey: true },
    ]) {
      expect(() => parseTailnetObserverConfigFile(raw))
        .toThrow("tailnet-observer-config-file-invalid");
    }
  });

  it("keeps the env-only resolver on the answers it has always given", async () => {
    const env = {
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_CAP: CAPABILITY,
      LVIS_TAILNET_PAIRED_SHARING: "1",
    };

    expect(resolveTailnetObserverConfig(env)).toEqual(
      (await loadTailnetObserverConfig({ env, readConfigFile: async () => null })).config,
    );
  });

  it("starts the listener from a file-only configuration", async () => {
    const f = options({});
    const started = await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: {
        startServer: f.startServer as never,
        readConfigFile: file({ enabled: true, expectedAppCapability: CAPABILITY }),
      },
    });

    expect(started?.port).toBe(DEFAULT_TAILNET_OBSERVER_PORT);
    expect(f.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", expectedAppCapability: CAPABILITY }),
    );
  });
});
