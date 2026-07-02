/**
 * cli/http-client — #1436 HTTP transport + discovery-file reader tests.
 *
 * Three layers, all exercised WITHOUT spawning the tsx entry as a subprocess
 * (slow/flaky). The entry (`scripts/lvis-cli.ts`) is deliberately thin — parse →
 * connect → run → print — so the transport tests here plus the command-table
 * `runCommand` test below cover its real logic. That boundary is intentional:
 * do NOT add a subprocess smoke of the entry to this suite.
 *
 *   1. `createHttpLocalApi` against a REAL `startLocalApiHttpServer` on port 0
 *      with a stub dispatcher: public read passthrough, gesture-gated 403
 *      passthrough, wrong-secret 401, and a closed server → server-unavailable.
 *   2. `readLocalApiConnection` with a per-test LVIS_HOME temp override: missing
 *      file → null, tombstone → null, valid file → { port, secret }.
 *   3. End-to-end: `runCommand(["permission:mode"], createLvisClient(httpApi,
 *      "cli"))` over the real server + a REAL `createLocalApi` (deep-proxy deps).
 *
 * Every started server is torn down in afterEach so vitest exits clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startLocalApiHttpServer,
  type LocalApiHttpServer,
} from "../../api/http-server.js";
import { createStreamBroadcaster } from "../../api/stream-broadcaster.js";
import { createLocalApi } from "../../api/local-api.js";
import type { LocalApi, LocalApiRequest, LocalApiResult } from "../../api/local-api.js";
import type { ChatSendContext } from "../../ipc/handlers/chat.js";
import type { IpcDeps } from "../../ipc/types.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { LOCAL_API_INFO_FILE, type LocalApiServerInfoFile } from "../../main/local-api-server.js";
import { makeDeepProxy } from "../../testing/deep-proxy.js";
import { createLvisClient } from "../../sdk/index.js";
import { CHANNELS, PERMISSIONS } from "../../contract/app-contract.js";
import {
  CLI_SERVER_UNAVAILABLE,
  createHttpLocalApi,
  readLocalApiConnection,
  type CliConnection,
} from "../http-client.js";

const TRANSPORT_SECRET = "cli-transport-secret-abcdef0123456789";
const LOCAL_API_FEATURE = "local-api";

/** Dispatcher stub whose result depends on the requested channel (per-test wire). */
function channelSwitchedApi(): LocalApi {
  const dispatch = async (req: LocalApiRequest): Promise<LocalApiResult> => {
    if (req.channel === PERMISSIONS.getMode) {
      return { ok: true, data: { mode: "plan" } };
    }
    if (req.channel === CHANNELS.plugins.cards) {
      return { ok: false, error: "gesture-required-origin-unsupported" };
    }
    return { ok: false, error: "channel-not-public" };
  };
  return { dispatch };
}

let liveServers: LocalApiHttpServer[] = [];

/** Boot a tracked loopback server over `api`, resolving its bound connection. */
async function bootServer(api: LocalApi, secret = TRANSPORT_SECRET): Promise<CliConnection> {
  const broadcaster = createStreamBroadcaster();
  const server = await startLocalApiHttpServer({ api, secret, broadcaster, port: 0 });
  liveServers.push(server);
  return { port: server.port, secret };
}

afterEach(async () => {
  const pending = liveServers;
  liveServers = [];
  for (const one of pending) {
    await one.close();
  }
});

describe("createHttpLocalApi — dispatch over a real loopback server", () => {
  it("passes a public read success (200) through verbatim", async () => {
    const conn = await bootServer(channelSwitchedApi());
    const httpApi = createHttpLocalApi(conn);
    const result = await httpApi.dispatch({ channel: PERMISSIONS.getMode, origin: "cli" });
    expect(result).toEqual({ ok: true, data: { mode: "plan" } });
  });

  it("passes a gesture-gated rejection (403) through verbatim", async () => {
    const conn = await bootServer(channelSwitchedApi());
    const httpApi = createHttpLocalApi(conn);
    const result = await httpApi.dispatch({ channel: CHANNELS.plugins.cards, origin: "cli" });
    expect(result).toEqual({ ok: false, error: "gesture-required-origin-unsupported" });
  });

  it("maps a wrong secret (401) to the unauthorized code", async () => {
    const conn = await bootServer(channelSwitchedApi());
    const httpApi = createHttpLocalApi({ port: conn.port, secret: "the-wrong-secret" });
    const result = await httpApi.dispatch({ channel: PERMISSIONS.getMode, origin: "cli" });
    expect(result).toEqual({ ok: false, error: "unauthorized" });
  });

  it("returns server-unavailable when the server is closed (network error, no throw)", async () => {
    const conn = await bootServer(channelSwitchedApi());
    const httpApi = createHttpLocalApi(conn);
    // Close the only tracked server, then dispatch into the dead port.
    const [server] = liveServers;
    liveServers = [];
    await server.close();
    const result = await httpApi.dispatch({ channel: PERMISSIONS.getMode, origin: "cli" });
    expect(result).toEqual({ ok: false, error: CLI_SERVER_UNAVAILABLE });
  });
});

describe("readLocalApiConnection — discovery via LVIS_HOME override", () => {
  let prevHome: string | undefined;
  let homeDir: string;

  beforeEach(() => {
    prevHome = process.env.LVIS_HOME;
    homeDir = mkdtempSync(join(tmpdir(), "lvis-cli-conn-"));
    process.env.LVIS_HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns null when the discovery file is missing", async () => {
    expect(await readLocalApiConnection()).toBeNull();
  });

  it("returns null for a tombstone (port 0, empty secret)", async () => {
    const tomb: LocalApiServerInfoFile = { port: 0, secret: "", pid: 0 };
    await openFeatureNamespace(LOCAL_API_FEATURE).writeJson(LOCAL_API_INFO_FILE, tomb);
    expect(await readLocalApiConnection()).toBeNull();
  });

  it("returns { port, secret } for a valid discovery file (live pid)", async () => {
    // The test process itself is the canonical "alive" pid.
    const info: LocalApiServerInfoFile = {
      port: 51789,
      secret: "deadbeef".repeat(8),
      pid: process.pid,
    };
    await openFeatureNamespace(LOCAL_API_FEATURE).writeJson(LOCAL_API_INFO_FILE, info);
    expect(await readLocalApiConnection()).toEqual({ port: 51789, secret: info.secret });
  });

  it("returns null when the recorded pid is no longer alive (stale after crash)", async () => {
    // Spawn-and-reap a real child so its pid is guaranteed dead (a fixed fake
    // pid could collide with a live process on a busy machine).
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid ?? 0;
    expect(deadPid).toBeGreaterThan(0);
    const info: LocalApiServerInfoFile = {
      port: 51789,
      secret: "deadbeef".repeat(8),
      pid: deadPid,
    };
    await openFeatureNamespace(LOCAL_API_FEATURE).writeJson(LOCAL_API_INFO_FILE, info);
    expect(await readLocalApiConnection()).toBeNull();
  });
});

describe("runCommand over the real transport (cli origin, end-to-end)", () => {
  // A minimal, non-electron ChatSendContext — `permission:mode` never streams,
  // so the sink/allocator/tracker are inert stubs just to satisfy the type.
  const inertChatContext: ChatSendContext = {
    sink: () => undefined,
    allocateStreamId: () => 0,
    trackStreamTurn: (make) => make(),
  };

  it("dispatches permission:mode through cli → http → dispatcher → handler", async () => {
    // Deep-proxy stands in for the full IpcDeps; only permissionManager.getMode
    // is consulted by handleGetMode, so override just that leaf.
    const base = makeDeepProxy(["conversationLoop", "memoryManager"]) as Record<string, unknown>;
    const ipc = new Proxy(base, {
      get(target, prop) {
        if (prop === "conversationLoop") {
          return { getSessionId: () => "cli-session", permissionManager: { getMode: () => "acceptEdits" } };
        }
        return Reflect.get(target, prop);
      },
    }) as unknown as IpcDeps;

    const conn = await bootServer(createLocalApi({ ipc, chatSendContext: inertChatContext }));
    const client = createLvisClient(createHttpLocalApi(conn), "cli");

    const { runCommand } = await import("../commands.js");
    const result = await runCommand(["permission:mode"], client);
    expect(result).toEqual({ ok: true, command: "permission:mode", data: { mode: "acceptEdits" } });
  });
});

// ── US-104: permission:set-mode over the real transport ─────────────────────

describe("permission:set-mode over the real transport (approval-mediated external mutation)", () => {
  const inertChatContext: ChatSendContext = {
    sink: () => undefined,
    allocateStreamId: () => 0,
    trackStreamTurn: (make) => make(),
  };

  /**
   * Deps sufficient for `handleSetPermissionMode` to run end-to-end (mirrors
   * `local-api.test.ts`'s `makeMutationDeps`): a permission manager (getMode +
   * setModePersist), a ready audit-log chain, and a main-window stub for the
   * post-apply broadcast. `externalMutationApprover` resolves per-test.
   */
  function mutationIpc(): IpcDeps {
    let mode = "default";
    return {
      conversationLoop: {
        getSessionId: () => "s",
        permissionManager: {
          getMode: () => mode,
          setMode: (next: string) => {
            mode = next;
          },
          setModePersist: async (next: string) => {
            mode = next;
          },
        },
      },
      approvalGate: { requestAndWait: async () => ({ requestId: "x", choice: "allow-once" as const }) },
      auditLogger: {
        isPermissionAuditChainReady: () => true,
        appendPermissionAuditEntry: async () => undefined,
      },
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => {} } }),
    } as unknown as IpcDeps;
  }

  it("approver true → set-mode succeeds end-to-end (cli → http → dispatcher → handler)", async () => {
    const conn = await bootServer(
      createLocalApi({
        ipc: mutationIpc(),
        chatSendContext: inertChatContext,
        externalMutationApprover: async () => true,
      }),
    );
    const client = createLvisClient(createHttpLocalApi(conn), "cli");

    const { runCommand } = await import("../commands.js");
    const result = await runCommand(["permission:set-mode", "auto"], client);
    expect(result).toEqual({
      ok: true,
      command: "permission:set-mode",
      data: { ok: true, mode: "auto" },
    });
  });

  it("approver false → 403 external-mutation-denied surfaces through createHttpLocalApi + LvisClientError", async () => {
    const conn = await bootServer(
      createLocalApi({
        ipc: mutationIpc(),
        chatSendContext: inertChatContext,
        externalMutationApprover: async () => false,
      }),
    );
    const httpApi = createHttpLocalApi(conn);

    const direct = await httpApi.dispatch({ channel: PERMISSIONS.setMode, args: { mode: "auto" }, origin: "cli" });
    expect(direct).toEqual({ ok: false, error: "external-mutation-denied" });

    const client = createLvisClient(httpApi, "cli");
    await expect(client.setPermissionMode("auto")).rejects.toMatchObject({
      code: "external-mutation-denied",
      channel: PERMISSIONS.setMode,
    });
  });

  it("runCommand denial rejects with LvisClientError (maps to CLI exit 1)", async () => {
    const conn = await bootServer(
      createLocalApi({
        ipc: mutationIpc(),
        chatSendContext: inertChatContext,
        externalMutationApprover: async () => false,
      }),
    );
    const client = createLvisClient(createHttpLocalApi(conn), "cli");

    const { runCommand } = await import("../commands.js");
    await expect(runCommand(["permission:set-mode", "auto"], client)).rejects.toMatchObject({
      code: "external-mutation-denied",
      channel: PERMISSIONS.setMode,
    });
  });

  it("runCommand with no <mode> argument short-circuits as usage-error (maps to CLI exit 2, dispatcher never reached)", async () => {
    const dispatch = vi.fn(async () => ({ ok: true, data: {} }));
    const client = createLvisClient({ dispatch }, "cli");

    const { runCommand } = await import("../commands.js");
    const result = await runCommand(["permission:set-mode"], client);
    expect(result).toEqual({
      ok: false,
      error: "usage-error",
      command: "permission:set-mode",
      message: "permission:set-mode requires a <mode> argument",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
