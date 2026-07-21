/**
 * local-api-server — #1436 lifecycle wiring tests.
 *
 * Exercises the opt-in gate, per-boot secret generation + persistence via
 * `openFeatureNamespace`, a REAL fetch against the running loopback server, and
 * idempotent graceful shutdown (with the discovery file blanked afterwards).
 *
 * LVIS_HOME is redirected to a per-test temp dir so the `~/.lvis/local-api/`
 * discovery file lands in isolation (feature-namespace resolves it lazily on
 * every op, honouring the override). The module imports `electron` only as a
 * TYPE (erased at runtime) and its dispatch chain pulls no electron runtime
 * module, so no electron mock is needed for the node env.
 *
 * Every test that starts a server tears it down in afterEach so vitest exits
 * with no leaked handles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isLocalApiEnabled,
  isA2ALoopbackEnabled,
  maybeStartLocalApiServer,
  resetLocalApiServerForTests,
  resolveLoopbackRouteFamilies,
  stopLocalApiServer,
  buildExternalMutationApprover,
  LOCAL_API_INFO_FILE,
  type A2ARouterRuntime,
  type LocalApiServerInfoFile,
} from "../local-api-server.js";
import { makeDeepProxy } from "../../testing/deep-proxy.js";
import type { AppServices } from "../../boot.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { FeatureFlags, SystemSettings } from "../../data/settings-store.js";
import type { ApprovalGate } from "../../permissions/approval-gate.js";
import type { A2AHttpRouter } from "../../api/a2a-router.js";
import { PERMISSIONS, EXTERNAL_MUTATION_DENIED } from "../../contract/app-contract.js";

/** Minimal SettingsService stub for the independently snapshotted route gates. */
function stubSettings(
  system: Partial<SystemSettings>,
  features: Partial<FeatureFlags> = {},
): SettingsService {
  const resolved: SystemSettings = {
    closeBehavior: "hide-to-tray",
    appMode: "work",
    localApiServer: false,
    ...system,
  };
  return {
    get: (key: string) => {
      if (key === "system") return { ...resolved };
      if (key === "features") return { ...features };
      return undefined;
    },
  } as unknown as SettingsService;
}

const SERVICE_KEYS: readonly string[] = [
  "settingsService",
  "conversationLoop",
  "memoryManager",
  "auditLogger",
  "pluginRuntime",
  "pluginMarketplace",
];

/**
 * Build a services bag: a deep-proxy stands in for the full AppServices surface,
 * with `settingsService` (gate) + a `permissionManager.getMode` (smoke dispatch)
 * overridden to concrete values.
 */
function makeServices(
  system: Partial<SystemSettings>,
  getMode = "plan",
  approvalGate?: Pick<ApprovalGate, "requestAndWait">,
  features: Partial<FeatureFlags> = {},
  auditLog?: (entry: unknown) => void,
): AppServices {
  const base = makeDeepProxy(SERVICE_KEYS) as Record<string, unknown>;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "settingsService") return stubSettings(system, features);
      if (prop === "conversationLoop") {
        return {
          getSessionId: () => "test-session-id",
          permissionManager: { getMode: () => getMode },
        };
      }
      // When a test supplies a stub ApprovalGate, expose it so the wired
      // external-mutation approver drives it. Otherwise fall through to the
      // deep-proxy (the approver still builds, but no mutation test exercises it).
      if (prop === "approvalGate" && approvalGate) return approvalGate;
      if (prop === "auditLogger" && auditLog) return { log: auditLog };
      return Reflect.get(target, prop);
    },
    ownKeys() {
      return [...SERVICE_KEYS];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true, writable: true };
    },
  }) as unknown as AppServices;
}

const START_ARGS = {
  getMainWindow: () => null,
  getAppWindows: () => [],
  log: () => {},
};

const TEST_AGENT_CARD_PATH = "/a2a/test/.well-known/agent-card.json";

function stubA2ARouter(): A2AHttpRouter {
  return {
    handlerIds: ["test"],
    isPublicAgentCardRequest: (path, method) =>
      path === TEST_AGENT_CARD_PATH && method === "GET",
    tryHandle: async (_req, res, path, method) => {
      if (path !== TEST_AGENT_CARD_PATH || method !== "GET") return false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "Test A2A handler" }));
      return true;
    },
  };
}

function readInfo(home: string): LocalApiServerInfoFile {
  const path = join(home, "local-api", LOCAL_API_INFO_FILE);
  return JSON.parse(readFileSync(path, "utf-8")) as LocalApiServerInfoFile;
}

describe("local-api-server", () => {
  let prevLvisHome: string | undefined;
  let prevEnvFlag: string | undefined;
  let prevA2AEnvFlag: string | undefined;
  let home: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    prevEnvFlag = process.env.LVIS_LOCAL_API;
    prevA2AEnvFlag = process.env.LVIS_A2A;
    delete process.env.LVIS_LOCAL_API;
    delete process.env.LVIS_A2A;
    home = mkdtempSync(join(tmpdir(), "lvis-local-api-"));
    process.env.LVIS_HOME = home;
  });

  afterEach(async () => {
    // Always stop so a started server never leaks past a test.
    await stopLocalApiServer();
    resetLocalApiServerForTests();
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    if (prevEnvFlag === undefined) delete process.env.LVIS_LOCAL_API;
    else process.env.LVIS_LOCAL_API = prevEnvFlag;
    if (prevA2AEnvFlag === undefined) delete process.env.LVIS_A2A;
    else process.env.LVIS_A2A = prevA2AEnvFlag;
    rmSync(home, { recursive: true, force: true });
  });

  describe("gate", () => {
    it("isLocalApiEnabled is false by default", () => {
      expect(isLocalApiEnabled(stubSettings({}), {})).toBe(false);
    });

    it("isLocalApiEnabled true when the setting is on", () => {
      expect(isLocalApiEnabled(stubSettings({ localApiServer: true }), {})).toBe(true);
    });

    it("isLocalApiEnabled true when LVIS_LOCAL_API=1", () => {
      expect(isLocalApiEnabled(stubSettings({}), { LVIS_LOCAL_API: "1" })).toBe(true);
    });

    it("keeps A2A independently off unless its setting or exact env opt-in is enabled", () => {
      expect(isA2ALoopbackEnabled(stubSettings({}, {}), {})).toBe(false);
      expect(isA2ALoopbackEnabled(stubSettings({}, { a2aLoopbackServer: true }), {})).toBe(true);
      expect(isA2ALoopbackEnabled(stubSettings({}, {}), { LVIS_A2A: "1" })).toBe(true);
      expect(isA2ALoopbackEnabled(stubSettings({}, {}), { LVIS_A2A: "true" })).toBe(false);
    });

    it("resolves the two route-family gates independently", () => {
      expect(resolveLoopbackRouteFamilies(stubSettings({ localApiServer: true }, {}), {}))
        .toEqual({ localApi: true, a2a: false });
      expect(resolveLoopbackRouteFamilies(stubSettings({}, { a2aLoopbackServer: true }), {}))
        .toEqual({ localApi: false, a2a: true });
      expect(resolveLoopbackRouteFamilies(stubSettings({}, {}), {
        LVIS_LOCAL_API: "1",
        LVIS_A2A: "1",
      })).toEqual({ localApi: true, a2a: true });
    });

    it("default-off: maybeStart returns null and writes NO discovery file", async () => {
      const result = await maybeStartLocalApiServer({ services: makeServices({}), ...START_ARGS });
      expect(result).toBeNull();
      expect(existsSync(join(home, "local-api", LOCAL_API_INFO_FILE))).toBe(false);
      expect(existsSync(join(home, "local-api"))).toBe(false);
    });

    it("treats listener stop as terminal for the current process boot", async () => {
      const factory = vi.fn(() => stubA2ARouter());
      await expect(maybeStartLocalApiServer({
        services: makeServices({}),
        createA2ARouter: factory,
        ...START_ARGS,
      })).resolves.toBeNull();

      await stopLocalApiServer();

      process.env.LVIS_A2A = "1";
      await expect(maybeStartLocalApiServer({
        services: makeServices({}),
        createA2ARouter: factory,
        ...START_ARGS,
      })).resolves.toBeNull();
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe("independent route-family lifecycle", () => {
    it("single-flights concurrent starts onto exactly one listener", async () => {
      process.env.LVIS_A2A = "1";
      const factory = vi.fn(() => stubA2ARouter());
      const input = {
        services: makeServices({}),
        createA2ARouter: factory,
        ...START_ARGS,
      };

      const [first, second] = await Promise.all([
        maybeStartLocalApiServer(input),
        maybeStartLocalApiServer(input),
      ]);

      expect(first).not.toBeNull();
      expect(second).toEqual(first);
      expect(factory).toHaveBeenCalledOnce();
      expect(readInfo(home).port).toBe(first!.port);
    });

    it("invalidates a pending start during shutdown without resurrecting a listener", async () => {
      process.env.LVIS_A2A = "1";
      let resolveRuntime: ((runtime: A2ARouterRuntime) => void) | undefined;
      const dispose = vi.fn(async () => {});
      const factory = vi.fn(() => new Promise<A2ARouterRuntime>((resolve) => {
        resolveRuntime = resolve;
      }));
      const start = maybeStartLocalApiServer({
        services: makeServices({}),
        createA2ARouter: factory,
        ...START_ARGS,
      });
      expect(factory).toHaveBeenCalledOnce();

      const stopping = stopLocalApiServer();
      await expect(stopping).resolves.toBeUndefined();
      await expect(start).resolves.toBeNull();
      expect(existsSync(join(home, "local-api"))).toBe(false);

      // Release the detached factory after shutdown; its stale generation must
      // not continue into bind/discovery work.
      resolveRuntime!({
        router: stubA2ARouter(),
        discovery: { protocolVersion: "1.0", agentCardPaths: [TEST_AGENT_CARD_PATH] },
        dispose,
      });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    });

    it("starts A2A-only on the shared listener and hides /v1 before auth", async () => {
      process.env.LVIS_A2A = "1";
      const result = await maybeStartLocalApiServer({
        services: makeServices({}),
        createA2ARouter: () => stubA2ARouter(),
        ...START_ARGS,
      });
      expect(result).not.toBeNull();
      expect(readInfo(home).a2a).toEqual({
        protocolVersion: "1.0",
        agentCardPaths: [TEST_AGENT_CARD_PATH],
      });

      const localResponse = await fetch(`http://127.0.0.1:${result!.port}/v1/health`);
      expect(localResponse.status).toBe(404);
      expect(await localResponse.json()).toEqual({ ok: false, error: "not-found" });

      const cardResponse = await fetch(
        `http://127.0.0.1:${result!.port}${TEST_AGENT_CARD_PATH}`,
      );
      expect(cardResponse.status).toBe(200);
      expect(await cardResponse.json()).toEqual({ name: "Test A2A handler" });
    });

    it("disposes one active A2A runtime exactly once across repeated stop calls", async () => {
      process.env.LVIS_A2A = "1";
      const dispose = vi.fn(async () => {});
      await maybeStartLocalApiServer({
        services: makeServices({}),
        createA2ARouter: () => ({
          router: stubA2ARouter(),
          discovery: { protocolVersion: "1.0", agentCardPaths: [TEST_AGENT_CARD_PATH] },
          dispose,
        }),
        ...START_ARGS,
      });

      await stopLocalApiServer();
      await stopLocalApiServer();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it("starts both route families on one port", async () => {
      process.env.LVIS_LOCAL_API = "1";
      process.env.LVIS_A2A = "1";
      const result = await maybeStartLocalApiServer({
        services: makeServices({}),
        createA2ARouter: () => stubA2ARouter(),
        ...START_ARGS,
      });
      const info = readInfo(home);

      const health = await fetch(`http://127.0.0.1:${result!.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.secret}` },
      });
      const card = await fetch(`http://127.0.0.1:${result!.port}${TEST_AGENT_CARD_PATH}`);
      expect(health.status).toBe(200);
      expect(card.status).toBe(200);
      expect(info.port).toBe(result!.port);
      expect(info.a2a).toEqual({
        protocolVersion: "1.0",
        agentCardPaths: [TEST_AGENT_CARD_PATH],
      });
    });

    it("shares one single-flight consent coordinator across /v1 and A2A", async () => {
      process.env.LVIS_LOCAL_API = "1";
      process.env.LVIS_A2A = "1";
      let releaseGate!: (value: { requestId: string; choice: "allow-once" }) => void;
      const gateResult = new Promise<{ requestId: string; choice: "allow-once" }>((resolve) => {
        releaseGate = resolve;
      });
      const requestAndWait = vi.fn(async () => await gateResult);
      let approveA2A: Parameters<NonNullable<Parameters<typeof maybeStartLocalApiServer>[0]["createA2ARouter"]>>[0]["approveAgentAction"];
      const result = await maybeStartLocalApiServer({
        services: makeServices({}, "plan", { requestAndWait }),
        createA2ARouter: ({ approveAgentAction }) => {
          approveA2A = approveAgentAction;
          return stubA2ARouter();
        },
        ...START_ARGS,
      });
      const info = readInfo(home);

      const pendingA2A = approveA2A!({
        toolName: "a2a-send-message",
        args: { operation: "send-message", handlerId: "test" },
        reason: "Allow an external A2A mutation?",
        trustOrigin: "a2a-loopback",
      });
      await vi.waitFor(() => expect(requestAndWait).toHaveBeenCalledOnce());
      const localMutation = await fetch(`http://127.0.0.1:${result!.port}/v1/dispatch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${info.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: PERMISSIONS.setMode, args: { mode: "auto" } }),
      });

      expect(localMutation.status).toBe(403);
      expect(requestAndWait).toHaveBeenCalledOnce();
      releaseGate({ requestId: "shared-consent", choice: "allow-once" });
      await expect(pendingA2A).resolves.toMatchObject({ decisionId: "shared-consent" });
    });

    it("isolates A2A initialization failure while keeping /v1 available", async () => {
      process.env.LVIS_LOCAL_API = "1";
      process.env.LVIS_A2A = "1";
      const emitted = vi.fn();
      const audit = vi.fn();
      const result = await maybeStartLocalApiServer({
        services: makeServices({}, "plan", undefined, {}, audit),
        createA2ARouter: () => {
          throw new Error("secret-shaped provider detail");
        },
        ...START_ARGS,
        log: emitted,
      });
      expect(result).not.toBeNull();
      const info = readInfo(home);
      const health = await fetch(`http://127.0.0.1:${result!.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.secret}` },
      });
      expect(health.status).toBe(200);
      expect(info.a2a).toBeUndefined();
      expect(emitted).toHaveBeenCalledWith(
        "[a2a] initialization failed; route family disabled for this boot",
      );
      expect(JSON.stringify(emitted.mock.calls)).not.toContain("provider detail");
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        type: "warn",
        input: "a2a:loopback:initialization-failed",
      }));
    });

    it("rejects mismatched runtime discovery, disposes it, and keeps /v1 available", async () => {
      process.env.LVIS_LOCAL_API = "1";
      process.env.LVIS_A2A = "1";
      const dispose = vi.fn(async () => {});
      const result = await maybeStartLocalApiServer({
        services: makeServices({}),
        createA2ARouter: () => ({
          router: stubA2ARouter(),
          discovery: { protocolVersion: "1.0", agentCardPaths: ["/a2a/wrong/card"] },
          dispose,
        }),
        ...START_ARGS,
      });
      const info = readInfo(home);

      expect(result).not.toBeNull();
      expect(info.a2a).toBeUndefined();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it("retains no empty listener and does not retry when A2A has no handler", async () => {
      process.env.LVIS_A2A = "1";
      const audit = vi.fn();
      const factory = vi.fn(() => null);
      const input = {
        services: makeServices({}, "plan", undefined, {}, audit),
        createA2ARouter: factory,
        ...START_ARGS,
      };
      await expect(maybeStartLocalApiServer(input)).resolves.toBeNull();
      await expect(maybeStartLocalApiServer(input)).resolves.toBeNull();
      expect(factory).toHaveBeenCalledOnce();
      expect(existsSync(join(home, "local-api"))).toBe(false);
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        type: "warn",
        input: "a2a:loopback:no-routable-handler",
      }));
    });
  });

  describe("start via env flag", () => {
    it("starts, persists port + 64-hex secret + pid, and health responds 200", async () => {
      process.env.LVIS_LOCAL_API = "1";
      const result = await maybeStartLocalApiServer({ services: makeServices({}), ...START_ARGS });
      expect(result).not.toBeNull();
      expect(result!.port).toBeGreaterThan(0);

      const info = readInfo(home);
      expect(info.port).toBe(result!.port);
      expect(info.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(info.pid).toBe(process.pid);
      expect(info.a2a).toBeUndefined();

      // A real fetch to /v1/health with the persisted secret → 200.
      const res = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.secret}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("a wrong secret is rejected 401 (auth is enforced on the running server)", async () => {
      process.env.LVIS_LOCAL_API = "1";
      const result = await maybeStartLocalApiServer({ services: makeServices({}), ...START_ARGS });
      const res = await fetch(`http://127.0.0.1:${result!.port}/v1/health`, {
        headers: { authorization: "Bearer wrong-secret" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("start via setting", () => {
    it("starts when system.localApiServer=true", async () => {
      const result = await maybeStartLocalApiServer({
        services: makeServices({ localApiServer: true }),
        ...START_ARGS,
      });
      expect(result).not.toBeNull();
      expect(result!.port).toBeGreaterThan(0);
      expect(readInfo(home).port).toBe(result!.port);
    });
  });

  describe("chat-context wiring smoke", () => {
    it("dispatches a public read channel through the running server", async () => {
      process.env.LVIS_LOCAL_API = "1";
      const result = await maybeStartLocalApiServer({
        services: makeServices({}, "acceptEdits"),
        ...START_ARGS,
      });
      const info = readInfo(home);
      const res = await fetch(`http://127.0.0.1:${result!.port}/v1/dispatch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${info.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: "lvis:permission:get-mode" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, data: { mode: "acceptEdits" } });
    });
  });

  describe("stop", () => {
    it("stop refuses further connections and tombstones the discovery file", async () => {
      process.env.LVIS_LOCAL_API = "1";
      const result = await maybeStartLocalApiServer({ services: makeServices({}), ...START_ARGS });
      const port = result!.port;
      // Reachable before stop.
      const info = readInfo(home);
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { authorization: `Bearer ${info.secret}` },
      })).status).toBe(200);

      await stopLocalApiServer();

      // Discovery file blanked (stale secret + port must not linger).
      const tomb = readInfo(home);
      expect(tomb).toEqual({ port: 0, secret: "", pid: 0 });

      // Connection now refused.
      await expect(
        fetch(`http://127.0.0.1:${port}/v1/health`, {
          headers: { authorization: `Bearer ${info.secret}` },
        }),
      ).rejects.toThrow();
    });

    it("stopLocalApiServer is idempotent — a second call resolves", async () => {
      process.env.LVIS_LOCAL_API = "1";
      await maybeStartLocalApiServer({ services: makeServices({}), ...START_ARGS });
      await expect(stopLocalApiServer()).resolves.toBeUndefined();
      await expect(stopLocalApiServer()).resolves.toBeUndefined();
    });

    it("stopLocalApiServer resolves when nothing is running (gate was off)", async () => {
      await expect(stopLocalApiServer()).resolves.toBeUndefined();
    });
  });

  // ── #1409 approval-mediated external mutation ─────────────────────────────
  describe("external-mutation approver wiring", () => {
    it("returns undefined when no ApprovalGate is available (fail-closed default)", () => {
      expect(buildExternalMutationApprover(undefined, () => {})).toBeUndefined();
    });

    it("calls requestAndWait with category 'agent-action' + English reason; allow-once -> true", async () => {
      const requestAndWait = vi.fn(async () => ({ requestId: "r", choice: "allow-once" as const }));
      const approver = buildExternalMutationApprover(
        { requestAndWait } as unknown as ApprovalGate,
        () => {},
      );
      expect(approver).toBeDefined();

      const approved = await approver!({
        channel: PERMISSIONS.setMode,
        args: { mode: "auto" },
        origin: "local-api",
      });

      expect(approved).toBe(true);
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      const req = requestAndWait.mock.calls[0][0] as Record<string, unknown>;
      expect(req.category).toBe("agent-action");
      expect(req.kind).toBe("agent-action");
      expect(req.toolName).toBe(PERMISSIONS.setMode);
      expect(req.toolCategory).toBe("meta");
      expect(req.trustOrigin).toBe("local-api");
      expect(req.args).toEqual({ mode: "auto" });
      // Renderer-facing English reason (global default-language convention).
      expect(typeof req.reason).toBe("string");
      expect(req.reason as string).toMatch(/permission-mode change/);
      // The gate owns `requireExplicit` (derived from policy) — the caller must
      // NOT set it on the request (signature is Omit<ApprovalRequest,"requireExplicit">).
      expect(req.requireExplicit).toBeUndefined();
    });

    it("deny-once → false", async () => {
      const requestAndWait = vi.fn(async () => ({ requestId: "r", choice: "deny-once" as const }));
      const approver = buildExternalMutationApprover(
        { requestAndWait } as unknown as ApprovalGate,
        () => {},
      );
      const approved = await approver!({
        channel: PERMISSIONS.setMode,
        args: { mode: "auto" },
        origin: "cli",
      });
      expect(approved).toBe(false);
    });

    it("a thrown gate → false (fail-closed) and logs one line", async () => {
      const requestAndWait = vi.fn(async () => {
        throw new Error("secret-from-gate-must-not-be-logged");
      });
      const logs: string[] = [];
      const approver = buildExternalMutationApprover(
        { requestAndWait } as unknown as ApprovalGate,
        (m) => logs.push(m),
      );
      const approved = await approver!({
        channel: PERMISSIONS.setMode,
        args: { mode: "auto" },
        origin: "local-api",
      });
      expect(approved).toBe(false);
      expect(logs).toEqual([
        `[local-api] external-mutation approval errored channel=${PERMISSIONS.setMode} origin=local-api → denied`,
      ]);
      // No secret is ever logged — only channel + origin diagnostics.
      expect(logs.join("\n")).not.toContain("Bearer");
      expect(logs.join("\n")).not.toContain("secret-from-gate-must-not-be-logged");
    });

    // ── security MINOR-1 (#1441 cluster review): attention-DoS in-flight cap ──
    describe("in-flight cap (attention-DoS hardening, fail-closed)", () => {
      it("two concurrent asks → gate's requestAndWait called exactly once; the second resolves false immediately", async () => {
        let releaseGate!: (choice: "allow-once") => void;
        const gateResult = new Promise<{ requestId: string; choice: "allow-once" }>((resolve) => {
          releaseGate = (choice) => resolve({ requestId: "r", choice });
        });
        const requestAndWait = vi.fn(async () => gateResult);
        const logs: string[] = [];
        const approver = buildExternalMutationApprover(
          { requestAndWait } as unknown as ApprovalGate,
          (m) => logs.push(m),
        )!;

        const first = approver({
          channel: PERMISSIONS.setMode,
          args: { mode: "auto" },
          origin: "local-api",
        });
        // Let the first call reach `requestAndWait` before firing the second.
        await new Promise((resolve) => setTimeout(resolve, 0));

        const second = await approver({
          channel: PERMISSIONS.setMode,
          args: { mode: "auto" },
          origin: "cli",
        });

        expect(second).toBe(false);
        expect(requestAndWait).toHaveBeenCalledTimes(1);
        expect(
          logs.some((l) => l.includes("external mutation approval already pending — denying concurrent request")),
        ).toBe(true);
        // Log line must include channel + origin, never args/secret.
        const capLog = logs.find((l) => l.includes("already pending"));
        expect(capLog).toContain(`channel=${PERMISSIONS.setMode}`);
        expect(capLog).toContain("origin=cli");
        expect(capLog).not.toContain("Bearer");
        expect(capLog).not.toContain("auto");

        releaseGate("allow-once");
        await expect(first).resolves.toBe(true);
      });

      it("after the first ask resolves allow, a subsequent ask calls the gate again (guard released)", async () => {
        const requestAndWait = vi.fn(async () => ({ requestId: "r", choice: "allow-once" as const }));
        const approver = buildExternalMutationApprover(
          { requestAndWait } as unknown as ApprovalGate,
          () => {},
        )!;

        const firstApproved = await approver({
          channel: PERMISSIONS.setMode,
          args: { mode: "auto" },
          origin: "local-api",
        });
        const secondApproved = await approver({
          channel: PERMISSIONS.setMode,
          args: { mode: "strict" },
          origin: "local-api",
        });

        expect(firstApproved).toBe(true);
        expect(secondApproved).toBe(true);
        expect(requestAndWait).toHaveBeenCalledTimes(2);
      });

      it("the guard releases even when the gate throws, so the next ask calls the gate again", async () => {
        const requestAndWait = vi
          .fn()
          .mockRejectedValueOnce(new Error("gate exploded"))
          .mockResolvedValueOnce({ requestId: "r", choice: "allow-once" as const });
        const approver = buildExternalMutationApprover(
          { requestAndWait } as unknown as ApprovalGate,
          () => {},
        )!;

        const firstApproved = await approver({
          channel: PERMISSIONS.setMode,
          args: { mode: "auto" },
          origin: "local-api",
        });
        const secondApproved = await approver({
          channel: PERMISSIONS.setMode,
          args: { mode: "strict" },
          origin: "local-api",
        });

        expect(firstApproved).toBe(false);
        expect(secondApproved).toBe(true);
        expect(requestAndWait).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("HTTP passthrough — approval-denied set-mode", () => {
    it("POST /v1/dispatch set-mode with a stub approver-denied gate → 403 external-mutation-denied", async () => {
      process.env.LVIS_LOCAL_API = "1";
      // Stub gate that denies (deny-once) → approver resolves false.
      const requestAndWait = vi.fn(async () => ({ requestId: "r", choice: "deny-once" as const }));
      const result = await maybeStartLocalApiServer({
        services: makeServices({}, "plan", { requestAndWait }),
        ...START_ARGS,
      });
      const info = readInfo(home);

      const res = await fetch(`http://127.0.0.1:${result!.port}/v1/dispatch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${info.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: PERMISSIONS.setMode, args: { mode: "auto" } }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: EXTERNAL_MUTATION_DENIED });
      expect(requestAndWait).toHaveBeenCalledTimes(1);
    });
  });
});
