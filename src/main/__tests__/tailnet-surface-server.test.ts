import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { TailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import {
  configureTailscaleServe,
  DEFAULT_TAILNET_OBSERVER_PORT,
  getTailnetObserverRuntimeState,
  getTailnetPairedSharingRuntime,
  loadTailnetObserverConfig,
  maybeStartTailnetObserverServer,
  parseTailnetObserverConfigFile,
  probeTailscaleEnvironment,
  resetTailnetObserverServerForTests,
  resolveTailnetObserverConfig,
  restartTailnetObserverServer,
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
