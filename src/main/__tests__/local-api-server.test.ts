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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isLocalApiEnabled,
  maybeStartLocalApiServer,
  stopLocalApiServer,
  LOCAL_API_INFO_FILE,
  type LocalApiServerInfoFile,
} from "../local-api-server.js";
import { makeDeepProxy } from "../../testing/deep-proxy.js";
import type { AppServices } from "../../boot.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { SystemSettings } from "../../data/settings-store.js";

/** Minimal SettingsService stub — only `get("system")` is consulted by the gate. */
function stubSettings(system: Partial<SystemSettings>): SettingsService {
  const resolved: SystemSettings = {
    closeBehavior: "hide-to-tray",
    appMode: "work",
    localApiServer: false,
    ...system,
  };
  return {
    get: (key: string) => (key === "system" ? { ...resolved } : undefined),
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
function makeServices(system: Partial<SystemSettings>, getMode = "plan"): AppServices {
  const base = makeDeepProxy(SERVICE_KEYS) as Record<string, unknown>;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "settingsService") return stubSettings(system);
      if (prop === "conversationLoop") {
        return {
          getSessionId: () => "test-session-id",
          permissionManager: { getMode: () => getMode },
        };
      }
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

function readInfo(home: string): LocalApiServerInfoFile {
  const path = join(home, "local-api", LOCAL_API_INFO_FILE);
  return JSON.parse(readFileSync(path, "utf-8")) as LocalApiServerInfoFile;
}

describe("local-api-server", () => {
  let prevLvisHome: string | undefined;
  let prevEnvFlag: string | undefined;
  let home: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    prevEnvFlag = process.env.LVIS_LOCAL_API;
    delete process.env.LVIS_LOCAL_API;
    home = mkdtempSync(join(tmpdir(), "lvis-local-api-"));
    process.env.LVIS_HOME = home;
  });

  afterEach(async () => {
    // Always stop so a started server never leaks past a test.
    await stopLocalApiServer();
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    if (prevEnvFlag === undefined) delete process.env.LVIS_LOCAL_API;
    else process.env.LVIS_LOCAL_API = prevEnvFlag;
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

    it("default-off: maybeStart returns null and writes NO discovery file", async () => {
      const result = await maybeStartLocalApiServer({ services: makeServices({}), ...START_ARGS });
      expect(result).toBeNull();
      expect(existsSync(join(home, "local-api", LOCAL_API_INFO_FILE))).toBe(false);
      expect(existsSync(join(home, "local-api"))).toBe(false);
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
});
