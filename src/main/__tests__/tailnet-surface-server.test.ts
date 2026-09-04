import { createServer } from "node:net";
import { occupyLoopbackPort as occupy } from "../../__tests__/test-helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { TailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import type { TailnetShareActorId } from "../tailnet-pairing-share-store.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import {
  chooseObserverPort,
  configureTailscaleServe,
  DEFAULT_TAILNET_OBSERVER_PORT,
  getTailnetObserverRuntimeState,
  getTailnetPairedSharingRuntime,
  loadTailnetObserverConfig,
  maybeStartTailnetObserverServer,
  parseTailnetObserverConfigFile,
  probeTailscaleEnvironment,
  resetTailnetObserverServerForTests,
  isTailnetOwnDeviceAdmissionEnabled,
  resolveTailnetObserverConfig,
  restartTailnetObserverServer,
  setTailnetOwnDeviceAdmission,
  stopTailnetObserverServer,
  tailnetWebOriginFor,
  tailscaleServeCommandText,
  type TailnetObserverConfigFile,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from "../tailnet-surface-server.js";

const CAPABILITY = "lvis.example.com/cap/conversation-observer";
const CAPABILITY_ENV = "app-capability:" + CAPABILITY;
const APP_CAPABILITY = Object.freeze({ kind: "app-capability" as const, capability: CAPABILITY });
const TAILNET_IDENTITY = Object.freeze({ kind: "tailnet-identity" as const });
const WEB_ORIGIN = "https://lvis.example.ts.net";

function runtime(): ConversationSurfaceRuntime {
  return {
    sharedProjection: {},
  } as ConversationSurfaceRuntime;
}

/** A probe reading whose only question is which login this desktop is signed in as. */
function tailscaleEnvironment(login: string | null) {
  return {
    state: "ready" as const,
    cliPath: "tailscale",
    login,
    dnsName: null,
    tailnetName: null,
    serveConfigured: false,
    serveTargetPort: null,
    detail: null,
  };
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

  it("requires an explicitly named authorization boundary and a valid fixed port when enabled", () => {
    expect(resolveTailnetObserverConfig({})).toBeNull();
    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
    })).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      authorization: APP_CAPABILITY,
      controllerEnabled: false,
      pairedSharingEnabled: false,
    });

    // Identity mode is a first-class choice, not the absence of one: it has to
    // be named as explicitly as the capability it replaces.
    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: "tailnet-identity",
    })).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      authorization: TAILNET_IDENTITY,
      controllerEnabled: false,
      pairedSharingEnabled: false,
    });

    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      LVIS_TAILNET_PAIRED_SHARING: "1",
    })).toMatchObject({
      pairedSharingEnabled: true,
    });

    // The controller needs the pairing boundary, so it is only valid WITH
    // paired sharing — the same coupling the web adapter already requires.
    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      LVIS_TAILNET_CONTROLLER: "1",
      LVIS_TAILNET_PAIRED_SHARING: "1",
    })).toMatchObject({
      controllerEnabled: true,
      pairedSharingEnabled: true,
    });
    expect(resolveTailnetObserverConfig({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      LVIS_TAILNET_PAIRED_SHARING: "1",
      LVIS_TAILNET_WEB: "1",
      LVIS_TAILNET_WEB_ORIGIN: WEB_ORIGIN,
    })).toMatchObject({
      pairedSharingEnabled: true,
      webOrigin: WEB_ORIGIN,
    });



    for (const env of [
      { LVIS_TAILNET_OBSERVER: "1" },
      { LVIS_TAILNET_OBSERVER: "1", LVIS_TAILNET_OBSERVER_AUTHORIZATION: "" },
      { LVIS_TAILNET_OBSERVER: "1", LVIS_TAILNET_OBSERVER_AUTHORIZATION: "app-capability:" },
      { LVIS_TAILNET_OBSERVER: "1", LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY },
      { LVIS_TAILNET_OBSERVER: "1", LVIS_TAILNET_OBSERVER_AUTHORIZATION: "app-capability:__proto__" },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_OBSERVER_PORT: "0",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_OBSERVER_PORT: "65536",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_CONTROLLER: "true",
      },
      // Controller enabled (valid "1") but WITHOUT paired sharing — the new
      // coupling gate rejects it rather than leaving the native routes ungated.
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_CONTROLLER: "1",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_PAIRED_SHARING: "true",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_WEB: "true",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_WEB: "1",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        LVIS_TAILNET_PAIRED_SHARING: "1",
        LVIS_TAILNET_WEB: "1",
        LVIS_TAILNET_WEB_ORIGIN: "http://lvis.example.ts.net",
      },
      {
        LVIS_TAILNET_OBSERVER: "1",
        LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
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
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
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

  it("pairs the desktop's own signed-in login without a code, still only as pending", async () => {
    const ACTOR = ("tailnet:" + "b".repeat(64)) as `tailnet:${string}`;
    const OWNER_LOGIN = "owner@example.test";
    let pairing: { readonly id: string; readonly state: "pending"; readonly expiresAt: number } | null = null;
    const createInvitation = vi.fn(async () => ({
      id: "44444444-4444-4444-8444-444444444444",
      code: "lvis-pair-v1." + "c".repeat(43),
      expiresAt: 4_102_444_800_000,
    }));
    const claimInvitation = vi.fn(async () => {
      pairing = { id: "55555555-5555-4555-8555-555555555555", state: "pending", expiresAt: 123_456 };
      return { pairingId: pairing.id, expiresAt: 123_456 };
    });
    const pairedRuntime = {
      store: { createInvitation, claimInvitation, currentPairing: () => pairing },
      authorizer: { actorIdFor: vi.fn(), authorize: vi.fn(), subscribe: vi.fn(() => () => {}) },
    } as unknown as TailnetPairedSharingRuntime;
    const f = options({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      LVIS_TAILNET_PAIRED_SHARING: "1",
      LVIS_TAILNET_WEB: "1",
      LVIS_TAILNET_WEB_ORIGIN: WEB_ORIGIN,
    });

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: {
        ...f.input.dependencies,
        probeEnvironment: async () => tailscaleEnvironment(OWNER_LOGIN),
      },
      tailnetPairedSharingRuntime: pairedRuntime,
    })).resolves.toEqual({ port: DEFAULT_TAILNET_OBSERVER_PORT });

    const claimOwnDevice = (f.startServer.mock.calls[0]?.[0] as {
      pairing?: {
        claimOwnDevice?: (login: string, actorId: `tailnet:${string}`) => Promise<unknown>;
      };
    }).pairing?.claimOwnDevice;
    expect(claimOwnDevice).toBeTypeOf("function");

    // The owner's own device pairs, but through the ordinary invitation: the
    // pairing is pending and the desktop still has to activate it.
    await expect(claimOwnDevice?.(OWNER_LOGIN, ACTOR)).resolves.toBe(true);
    expect(createInvitation).toHaveBeenCalledOnce();
    // The deadline stays on this side: what crossed the boundary is only that a
    // pairing exists, and it is `pending` — the desktop still has to activate it.
    expect(pairing).toMatchObject({ state: "pending", expiresAt: 123_456 });

    // The waiting page reloads on a timer; re-entry must not spend a second
    // invitation on a claim that the existing pairing would refuse.
    await expect(claimOwnDevice?.(OWNER_LOGIN, ACTOR)).resolves.toBe(true);
    expect(createInvitation).toHaveBeenCalledOnce();

    // Another account on the same tailnet is not this desktop's device.
    await expect(claimOwnDevice?.("guest@example.test", ACTOR)).resolves.toBe(false);
    expect(createInvitation).toHaveBeenCalledOnce();
  });

  it("pairs nobody without a code when it cannot read its own Tailscale login", async () => {
    const createInvitation = vi.fn();
    const pairedRuntime = {
      store: {
        createInvitation,
        claimInvitation: vi.fn(),
        currentPairing: () => null,
      },
      authorizer: { actorIdFor: vi.fn(), authorize: vi.fn(), subscribe: vi.fn(() => () => {}) },
    } as unknown as TailnetPairedSharingRuntime;
    const f = options({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      LVIS_TAILNET_PAIRED_SHARING: "1",
    });

    await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: {
        ...f.input.dependencies,
        probeEnvironment: async () => tailscaleEnvironment(null),
      },
      tailnetPairedSharingRuntime: pairedRuntime,
    });

    const claimOwnDevice = (f.startServer.mock.calls[0]?.[0] as {
      pairing?: {
        claimOwnDevice?: (login: string, actorId: `tailnet:${string}`) => Promise<unknown>;
      };
    }).pairing?.claimOwnDevice;
    await expect(claimOwnDevice?.(
      "owner@example.test",
      ("tailnet:" + "b".repeat(64)) as `tailnet:${string}`,
    )).resolves.toBe(false);
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("fails closed when P2 bootstrap could not create the shared runtime", async () => {
    const f = options({
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
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
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      LVIS_TAILNET_OBSERVER_PORT: "46174",
    }, startServer);

    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toEqual({ port: 46174 });
    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toEqual({ port: 46174 });
    expect(startServer).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 46174,
      authorization: APP_CAPABILITY,
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
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
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
        authorization: APP_CAPABILITY,
        pairedSharingEnabled: true,
      }),
    });

    expect(resolution.config).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      authorization: APP_CAPABILITY,
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
        authorization: APP_CAPABILITY,
        port: 46_500,
      }),
    });

    expect(resolution.config?.port).toBe(47_000);
    expect(resolution.provenance.port).toBe("env-override");
    expect(resolution.provenance.authorization).toBe("file");
  });

  it("lets the environment turn a file-enabled observer back off", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: { LVIS_TAILNET_OBSERVER: "0" },
      readConfigFile: file({ enabled: true, authorization: APP_CAPABILITY }),
    });

    expect(resolution.config).toBeNull();
    expect(resolution.provenance.enabled).toBe("env-override");
  });

  it("puts the file through the same gates the environment goes through", async () => {
    // One vocabulary, one validator: the file cannot admit a port, a capability
    // key, or a scope combination the env form would have rejected.
    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({ enabled: true, authorization: APP_CAPABILITY, port: 65_536 }),
    })).rejects.toThrow("tailnet-observer-port-invalid");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        authorization: { kind: "app-capability", capability: "__proto__" },
      }),
    })).rejects.toThrow("tailnet-observer-authorization-missing-or-invalid");

    // Neither boundary named is still invalid: there is no implicit default.
    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({ enabled: true }),
    })).rejects.toThrow("tailnet-observer-authorization-missing-or-invalid");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        authorization: APP_CAPABILITY,
        controllerEnabled: true,
      }),
    })).rejects.toThrow("tailnet-controller-requires-paired-sharing");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        authorization: APP_CAPABILITY,
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
      { enabled: true, authorization: "tailnet-identity" },
      { enabled: true, authorization: { kind: "app-capability" } },
      { enabled: true, authorization: { kind: "tailnet-identity", capability: "x" } },
    ]) {
      expect(() => parseTailnetObserverConfigFile(raw))
        .toThrow("tailnet-observer-config-file-invalid");
    }
  });

  it("keeps the env-only resolver on the answers it has always given", async () => {
    const env = {
      LVIS_TAILNET_OBSERVER: "1",
      LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
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
        readConfigFile: file({ enabled: true, authorization: APP_CAPABILITY }),
      },
    });

    expect(started?.port).toBe(DEFAULT_TAILNET_OBSERVER_PORT);
    expect(f.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", authorization: APP_CAPABILITY }),
    );
  });
});

/** A `tailscale status --json` payload for a node that is up and signed in. */
function readyStatus(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    BackendState: "Running",
    Self: { UserID: 7, DNSName: "desk.example-tailnet.ts.net." },
    User: { "7": { LoginName: "owner@example.com" } },
    CurrentTailnet: { Name: "example-tailnet.ts.net" },
    ...overrides,
  });
}

function runner(
  answers: Record<string, TailscaleCommandResult>,
): TailscaleCommandRunner {
  return async (_cliPath, args) =>
    answers[args.join(" ")] ?? { kind: "ran", code: 1, stdout: "", stderr: "no such command" };
}

describe("Tailscale environment probe", () => {
  it("reads the tailnet, the node name, and the login instead of asking for them", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": { kind: "ran", code: 0, stdout: readyStatus(), stderr: "" },
        "serve status --json": {
          kind: "ran",
          code: 0,
          stdout: JSON.stringify({
            Web: { "desk.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:46173" } } } },
          }),
          stderr: "",
        },
      }),
    });

    expect(environment.state).toBe("ready");
    expect(environment.login).toBe("owner@example.com");
    expect(environment.dnsName).toBe("desk.example-tailnet.ts.net");
    expect(environment.tailnetName).toBe("example-tailnet.ts.net");
    expect(environment.serveConfigured).toBe(true);
    expect(environment.serveTargetPort).toBe(46_173);
  });

  it("names a logged-out node instead of reporting an empty tailnet", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 0,
          stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
          stderr: "",
        },
      }),
    });

    expect(environment.state).toBe("logged-out");
    expect(environment.login).toBeNull();
    expect(environment.dnsName).toBeNull();
  });

  it("names a stopped backend separately from a signed-out one", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 0,
          stdout: JSON.stringify({ BackendState: "Stopped" }),
          stderr: "",
        },
      }),
    });

    expect(environment.state).toBe("stopped");
    expect(environment.detail).toBe("Stopped");
  });

  it("reports a node with no MagicDNS name as ready without inventing one", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 0,
          stdout: readyStatus({ Self: { UserID: 7, DNSName: "" }, CurrentTailnet: null }),
          stderr: "",
        },
        "serve status --json": { kind: "ran", code: 0, stdout: "{}", stderr: "" },
      }),
    });

    expect(environment.state).toBe("ready");
    expect(environment.dnsName).toBeNull();
    expect(environment.tailnetName).toBeNull();
    expect(tailnetWebOriginFor(environment.dnsName)).toBeNull();
  });

  it("reports an absent Tailscale as its own state, not as a stopped node", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: async () => ({ kind: "not-found" as const }),
    });

    expect(environment.state).toBe("cli-not-found");
    expect(environment.cliPath).toBeNull();
  });

  it("carries what the CLI printed when it could not answer", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 1,
          stdout: "",
          stderr: "failed to connect to local backend",
        },
      }),
    });

    expect(environment.state).toBe("cli-failed");
    expect(environment.detail).toBe("failed to connect to local backend");
  });

  it("derives the web origin from the MagicDNS name", () => {
    expect(tailnetWebOriginFor("desk.example-tailnet.ts.net"))
      .toBe("https://desk.example-tailnet.ts.net");
    expect(tailnetWebOriginFor("desk.example.internal")).toBeNull();
  });
});

describe("Tailscale Serve configuration", () => {
  it("shows the command it will run, built from the argv it runs", () => {
    expect(tailscaleServeCommandText("tailscale", 46_173))
      .toBe("tailscale serve --bg --https=443 http://127.0.0.1:46173");
  });

  it("runs the command for the owner and reports success", async () => {
    const runCommand = vi.fn(async () => ({ kind: "ran" as const, code: 0, stdout: "", stderr: "" }));

    await expect(configureTailscaleServe({ cliPath: "tailscale", port: 46_173, runCommand }))
      .resolves.toEqual({ ok: true });
    expect(runCommand).toHaveBeenCalledWith(
      "tailscale",
      ["serve", "--bg", "--https=443", "http://127.0.0.1:46173"],
    );
  });

  it("hands back what Tailscale printed when the command fails", async () => {
    const outcome = await configureTailscaleServe({
      cliPath: "tailscale",
      port: 46_173,
      runCommand: async () => ({
        kind: "ran" as const,
        code: 1,
        stdout: "",
        stderr: "HTTPS is not enabled on this tailnet",
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "command-failed",
      output: "HTTPS is not enabled on this tailnet",
    });
  });
});

describe("Tailnet observer restart", () => {
  it("brings the listener up on a newly saved configuration without a relaunch", async () => {
    const f = options({});
    let saved: TailnetObserverConfigFile | null = null;

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: { startServer: f.startServer as never, readConfigFile: async () => saved },
    })).resolves.toBeNull();
    expect(f.startServer).not.toHaveBeenCalled();

    saved = { enabled: true, authorization: APP_CAPABILITY, port: 46_500 };
    const started = await restartTailnetObserverServer();

    expect(started?.port).toBe(46_500);
    expect(getTailnetObserverRuntimeState().listeningPort).toBe(46_500);
  });

  it("closes the running listener when the saved configuration turns it off", async () => {
    const f = options({});
    let saved: TailnetObserverConfigFile | null = {
      enabled: true,
      authorization: APP_CAPABILITY,
    };

    await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: { startServer: f.startServer as never, readConfigFile: async () => saved },
    });
    expect(getTailnetObserverRuntimeState().listeningPort).toBe(DEFAULT_TAILNET_OBSERVER_PORT);

    saved = null;
    await expect(restartTailnetObserverServer()).resolves.toBeNull();
    expect(getTailnetObserverRuntimeState().listeningPort).toBeNull();
  });

  it("records why a restart failed instead of leaving a half-applied listener", async () => {
    const f = options({});
    let saved: TailnetObserverConfigFile | null = null;

    await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: { startServer: f.startServer as never, readConfigFile: async () => saved },
    });

    saved = { enabled: true };
    await expect(restartTailnetObserverServer()).rejects.toThrow(
      "tailnet-observer-authorization-missing-or-invalid",
    );
    expect(getTailnetObserverRuntimeState().lastStartError)
      .toBe("tailnet-observer-authorization-missing-or-invalid");
    expect(getTailnetObserverRuntimeState().listeningPort).toBeNull();
  });
});

describe("choosing a loopback port for the observer", () => {
  /** A port nothing holds right now, learned from the OS rather than guessed. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = probe.address();
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("no-address"));
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it("keeps a preferred port that is free", async () => {
    const free = await freePort();

    expect(await chooseObserverPort(free)).toBe(free);
  });

  it("asks for the shared default when nothing is preferred", async () => {
    const release = await occupy(DEFAULT_TAILNET_OBSERVER_PORT);
    try {
      // Occupied here, so the answer is a different port — which is itself the
      // evidence the default is what was asked for first.
      const chosen = await chooseObserverPort(null);
      expect(chosen).not.toBeNull();
      expect(chosen).not.toBe(DEFAULT_TAILNET_OBSERVER_PORT);
    } finally {
      await release();
    }
  });

  it("falls from an occupied preference to the default", async () => {
    const taken = await freePort();
    const releasePreferred = await occupy(taken);
    try {
      const chosen = await chooseObserverPort(taken);
      // The default may itself be busy on the machine running this; what must
      // never happen is silently handing back the port that is already held.
      expect(chosen).not.toBe(taken);
      expect(chosen).not.toBeNull();
    } finally {
      await releasePreferred();
    }
  });

  it("hands out an OS-assigned port when preference and default are both taken", async () => {
    const taken = await freePort();
    const releasePreferred = await occupy(taken);
    const releaseDefault = await occupy(DEFAULT_TAILNET_OBSERVER_PORT);
    try {
      const chosen = await chooseObserverPort(taken);
      expect(chosen).not.toBeNull();
      expect(chosen).not.toBe(taken);
      expect(chosen).not.toBe(DEFAULT_TAILNET_OBSERVER_PORT);
      // Usable, not merely a number: the whole point is that the listener can
      // bind what this returned.
      expect(await chooseObserverPort(chosen)).toBe(chosen);
    } finally {
      await releaseDefault();
      await releasePreferred();
    }
  });
});

/**
 * A namespace that lives only in this test, so nothing here reads — or writes —
 * the admission record of whoever is running the suite.
 */
function memoryNamespace(seed: Record<string, unknown> = {}): FeatureNamespaceHandle {
  const files = new Map<string, unknown>(Object.entries(seed));
  return {
    dir: "/nonexistent",
    readJson: async <T>(name: string, fallback: T) => (
      files.has(name) ? files.get(name) as T : fallback
    ),
    writeJson: async (name: string, value: unknown) => {
      files.set(name, value);
    },
    childDir: async () => "/nonexistent",
  };
}

const ADMISSION_FILE = "own-device-admission.json";
const OWNER_LOGIN = "owner@example.test";
const PENDING_ID = "55555555-5555-4555-8555-555555555555";
const OWN_ACTOR = ("tailnet:" + "a".repeat(64)) as TailnetShareActorId;
const OTHER_ACTOR = ("tailnet:" + "b".repeat(64)) as TailnetShareActorId;

interface FakePairing {
  id: string;
  actorId: TailnetShareActorId;
  state: "pending" | "active" | "revoked";
}

/**
 * The pairing store reduced to what admission touches. `activatePairing` and
 * `revokePairing` behave exactly as the durable store does — including
 * answering false for a pairing that is already in the target state, which is
 * what keeps a re-entry from being audited as a second grant.
 */
function fakeStore(initial: readonly FakePairing[] = []) {
  const pairings = initial.map((entry) => ({ ...entry }));
  const store = {
    pairings,
    createInvitation: vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      code: "lvis-pair-v1." + "c".repeat(43),
      expiresAt: 4_102_444_800_000,
    })),
    claimInvitation: vi.fn(async (_code: string, actorId: TailnetShareActorId) => {
      const id = "5555555" + pairings.length + "-5555-4555-8555-555555555555";
      pairings.push({ id, actorId, state: "pending" });
      return { pairingId: id, expiresAt: 123_456 };
    }),
    currentPairing: vi.fn((actorId: TailnetShareActorId) => {
      const found = pairings.find((entry) => (
        entry.actorId === actorId && entry.state !== "revoked"
      ));
      return found === undefined ? null : {
        id: found.id,
        actorFingerprint: "fingerprint-" + found.actorId.slice(-4),
        state: found.state,
        expiresAt: found.state === "pending" ? 123_456 : null,
      };
    }),
    activatePairing: vi.fn(async (id: string) => {
      const found = pairings.find((entry) => entry.id === id);
      if (found === undefined || found.state !== "pending") return false;
      found.state = "active";
      return true;
    }),
    revokePairing: vi.fn(async (id: string) => {
      const found = pairings.find((entry) => entry.id === id);
      if (found === undefined || found.state === "revoked") return false;
      found.state = "revoked";
      return true;
    }),
  };
  return store;
}

function fakeRuntime(store: ReturnType<typeof fakeStore>, logins: Record<string, TailnetShareActorId> = {
  [OWNER_LOGIN]: OWN_ACTOR,
}): TailnetPairedSharingRuntime {
  return {
    store,
    authorizer: {
      actorIdFor: (login: string) => logins[login] ?? null,
      authorize: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
  } as unknown as TailnetPairedSharingRuntime;
}

/** Collects the audit entries the admission path writes. */
function fakeAuditLogger() {
  const entries: { sessionId: string; type: string; input?: string }[] = [];
  return {
    logger: { log: (entry: { sessionId: string; type: string; input?: string }) => {
      entries.push(entry);
    } } as unknown as AuditLogger,
    entries,
  };
}

async function claimOwnDeviceFor(input: {
  namespace: FeatureNamespaceHandle;
  runtime: TailnetPairedSharingRuntime;
  probeLogin: string | null;
  auditLogger?: AuditLogger;
}) {
  const f = options({
    LVIS_TAILNET_OBSERVER: "1",
    LVIS_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
    LVIS_TAILNET_PAIRED_SHARING: "1",
  });
  await maybeStartTailnetObserverServer({
    ...f.input,
    ...(input.auditLogger === undefined ? {} : { auditLogger: input.auditLogger }),
    dependencies: {
      ...f.input.dependencies,
      probeEnvironment: async () => tailscaleEnvironment(input.probeLogin),
      openTailnetNamespace: () => input.namespace,
    },
    tailnetPairedSharingRuntime: input.runtime,
  });
  const claimOwnDevice = (f.startServer.mock.calls[0]?.[0] as {
    pairing?: {
      claimOwnDevice?: (login: string, actorId: TailnetShareActorId) => Promise<boolean>;
    };
  }).pairing?.claimOwnDevice;
  if (claimOwnDevice === undefined) throw new Error("claimOwnDevice-missing");
  return claimOwnDevice;
}

describe("own-device admission", () => {
  it("admits a same-account device with no approval click while it is on", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OWN_ACTOR },
    });
    const store = fakeStore();
    const audit = fakeAuditLogger();
    const claimOwnDevice = await claimOwnDeviceFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
      auditLogger: audit.logger,
    });

    await expect(claimOwnDevice(OWNER_LOGIN, OWN_ACTOR)).resolves.toBe(true);
    expect(store.pairings).toEqual([
      expect.objectContaining({ actorId: OWN_ACTOR, state: "active" }),
    ]);
    expect(audit.entries).toEqual([
      expect.objectContaining({ sessionId: "tailnet-own-device-admission", type: "approval" }),
    ]);
    expect(JSON.parse(audit.entries[0]?.input ?? "{}")).toMatchObject({ action: "granted" });

    // The waiting page reloads on a timer. A pairing that is already active is
    // not a second grant, so it is neither re-activated nor audited again.
    await expect(claimOwnDevice(OWNER_LOGIN, OWN_ACTOR)).resolves.toBe(true);
    expect(audit.entries).toHaveLength(1);
  });

  it("leaves the same device waiting for approval while it is off", async () => {
    const namespace = memoryNamespace();
    const store = fakeStore();
    const audit = fakeAuditLogger();
    const claimOwnDevice = await claimOwnDeviceFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
      auditLogger: audit.logger,
    });

    await expect(claimOwnDevice(OWNER_LOGIN, OWN_ACTOR)).resolves.toBe(true);
    expect(store.pairings).toEqual([
      expect.objectContaining({ actorId: OWN_ACTOR, state: "pending" }),
    ]);
    expect(store.activatePairing).not.toHaveBeenCalled();
    expect(audit.entries).toHaveLength(0);
  });

  it("admits nobody but this desktop's own login, on or off", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OWN_ACTOR },
    });
    const store = fakeStore();
    const claimOwnDevice = await claimOwnDeviceFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
    });

    await expect(claimOwnDevice("guest@example.test", OTHER_ACTOR)).resolves.toBe(false);
    expect(store.createInvitation).not.toHaveBeenCalled();
    expect(store.activatePairing).not.toHaveBeenCalled();
    expect(store.pairings).toEqual([]);
  });

  it("approves a device already waiting when the owner turns it on", async () => {
    const namespace = memoryNamespace();
    const store = fakeStore([{ id: PENDING_ID, actorId: OWN_ACTOR, state: "pending" }]);
    const audit = fakeAuditLogger();

    await setTailnetOwnDeviceAdmission(true, {
      runtime: fakeRuntime(store),
      namespace,
      probeEnvironment: async () => tailscaleEnvironment(OWNER_LOGIN),
      auditLogger: audit.logger,
    });

    expect(store.pairings[0]).toMatchObject({ state: "active" });
    expect(await namespace.readJson(ADMISSION_FILE, null))
      .toEqual({ version: 1, admittedActorId: OWN_ACTOR });
    expect(JSON.parse(audit.entries[0]?.input ?? "{}"))
      .toMatchObject({ action: "granted", pairingId: PENDING_ID });
  });

  it("refuses to record an admission it could not identify an account for", async () => {
    const namespace = memoryNamespace();
    const store = fakeStore();

    await expect(setTailnetOwnDeviceAdmission(true, {
      runtime: fakeRuntime(store),
      namespace,
      probeEnvironment: async () => tailscaleEnvironment(null),
    })).rejects.toThrow("tailnet-own-device-admission-login-unreadable");
    expect(await namespace.readJson(ADMISSION_FILE, null)).toBeNull();
  });

  it("takes the granted access back when the owner turns it off", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OWN_ACTOR },
    });
    const store = fakeStore([{ id: PENDING_ID, actorId: OWN_ACTOR, state: "active" }]);
    const audit = fakeAuditLogger();

    await setTailnetOwnDeviceAdmission(false, {
      runtime: fakeRuntime(store),
      namespace,
      probeEnvironment: async () => tailscaleEnvironment(OWNER_LOGIN),
      auditLogger: audit.logger,
    });

    expect(store.revokePairing).toHaveBeenCalledWith(PENDING_ID);
    expect(store.pairings[0]).toMatchObject({ state: "revoked" });
    expect(await namespace.readJson(ADMISSION_FILE, null))
      .toEqual({ version: 1, admittedActorId: null });
    expect(JSON.parse(audit.entries[0]?.input ?? "{}"))
      .toMatchObject({ action: "revoked", pairingId: PENDING_ID });

    // Off means off: the next request from that same device waits for approval.
    const claimOwnDevice = await claimOwnDeviceFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
    });
    await expect(claimOwnDevice(OWNER_LOGIN, OWN_ACTOR)).resolves.toBe(true);
    expect(store.pairings.at(-1)).toMatchObject({ state: "pending" });
  });

  it("moves the admission with the desktop's account and revokes the old one", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OTHER_ACTOR },
    });
    const store = fakeStore([{ id: PENDING_ID, actorId: OTHER_ACTOR, state: "active" }]);
    const audit = fakeAuditLogger();
    const claimOwnDevice = await claimOwnDeviceFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
      auditLogger: audit.logger,
    });

    await expect(claimOwnDevice(OWNER_LOGIN, OWN_ACTOR)).resolves.toBe(true);
    expect(store.pairings[0]).toMatchObject({ actorId: OTHER_ACTOR, state: "revoked" });
    expect(store.pairings[1]).toMatchObject({ actorId: OWN_ACTOR, state: "active" });
    expect(await namespace.readJson(ADMISSION_FILE, null))
      .toEqual({ version: 1, admittedActorId: OWN_ACTOR });
    expect(audit.entries.map((entry) => JSON.parse(entry.input ?? "{}").action))
      .toEqual(["revoked", "granted"]);
  });

  it("reads a damaged admission record as off rather than as a grant", async () => {
    const namespace = memoryNamespace({ [ADMISSION_FILE]: { version: 9, admittedActorId: OWN_ACTOR } });
    expect(await isTailnetOwnDeviceAdmissionEnabled(namespace)).toBe(false);

    const store = fakeStore();
    const claimOwnDevice = await claimOwnDeviceFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
    });
    await expect(claimOwnDevice(OWNER_LOGIN, OWN_ACTOR)).resolves.toBe(true);
    expect(store.activatePairing).not.toHaveBeenCalled();
  });

  it("has no admission to change without a pairing runtime", async () => {
    await expect(setTailnetOwnDeviceAdmission(true, {
      runtime: null,
      namespace: memoryNamespace(),
      probeEnvironment: async () => tailscaleEnvironment(OWNER_LOGIN),
    })).rejects.toThrow("tailnet-own-device-admission-unavailable");
  });
});
