/**
 * MsGraphService unit tests
 *
 * Verifies:
 *  1) loadSavedToken with a valid plain-prefixed token → in-memory state set, isAuthenticated() true
 *  2) loadSavedToken with an expired token → state not set, isAuthenticated() false
 *  3) loadSavedToken with invalid JSON → no throw, isAuthenticated() false
 *  4) loadSavedToken with encrypted token + safeStorage available → decrypts correctly
 *  5) loadSavedToken with encrypted token + safeStorage unavailable → skips, isAuthenticated() false
 *  6) persistToken encrypts when safeStorage available (plain: prefix absent)
 *  7) persistToken uses plain: prefix when safeStorage unavailable
 *  8) persistToken writes file with mode 0o600
 *  9) startInteractiveAuth with null result → does not persist, notifyChange not called
 * 10) startInteractiveAuth with result.expiresOn === null → throws, does not persist
 * 11) startInteractiveAuth with valid result → persists and notifies
 * 12) isAuthenticated() returns false when no token loaded
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock references (accessible in vi.mock factories) ────────────────
const {
  mockSafeStorage,
  mockAcquireTokenInteractive,
  mockAcquireTokenSilent,
  mockGetAccountByUsername,
  mockGetAllAccounts,
  mockRemoveAccount,
  mockReadFile,
  mockWriteFile,
  mockMkdir,
  mockRename,
  mockExistsSync,
} = vi.hoisted(() => {
  return {
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
      decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, "")),
    },
    mockAcquireTokenInteractive: vi.fn(),
    mockAcquireTokenSilent: vi.fn(),
    mockGetAccountByUsername: vi.fn(),
    mockGetAllAccounts: vi.fn(),
    mockRemoveAccount: vi.fn(async () => undefined),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(async () => undefined),
    mockRename: vi.fn(async () => undefined),
    mockExistsSync: vi.fn(() => false),
  };
});

// ─── Mock electron ────────────────────────────────────────────────────────────
vi.mock("electron", () => ({
  safeStorage: mockSafeStorage,
}));

// ─── Mock @azure/msal-node ────────────────────────────────────────────────────
vi.mock("@azure/msal-node", () => {
  class MockPublicClientApplication {
    acquireTokenInteractive = mockAcquireTokenInteractive;
    acquireTokenSilent = mockAcquireTokenSilent;
    getTokenCache() {
      return {
        getAccountByUsername: mockGetAccountByUsername,
        getAllAccounts: mockGetAllAccounts,
        removeAccount: mockRemoveAccount,
      };
    }
  }
  return { PublicClientApplication: MockPublicClientApplication };
});

// ─── Mock node:fs/promises ────────────────────────────────────────────────────
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
}));

// ─── Mock node:fs (existsSync for legacy token migration) ────────────────────
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// ─── Import SUT (after mocks) ─────────────────────────────────────────────────
import { MsGraphService } from "../ms-graph-service.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function futureExpiry(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function pastExpiry(offsetMs = 3_600_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

function makeSavedJson(overrides: Partial<{ accessToken: string; expiry: string; account: string }> = {}) {
  return JSON.stringify({
    accessToken: "plain:test-token",
    expiry: futureExpiry(),
    account: "user@example.com",
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MsGraphService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockSafeStorage.encryptString.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
    mockSafeStorage.decryptString.mockImplementation((b: Buffer) => b.toString().replace(/^enc:/, ""));
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockGetAccountByUsername.mockResolvedValue(null);
    mockGetAllAccounts.mockResolvedValue([]);
  });

  // ── 1: valid plain-prefixed token ──────────────────────────────────────────
  it("loadSavedToken: valid plain token → isAuthenticated() true", async () => {
    mockReadFile.mockResolvedValue(makeSavedJson({ accessToken: "plain:valid-token" }));

    const svc = new MsGraphService("/tmp/test-userData");
    await svc.loadSavedToken();

    expect(svc.isAuthenticated()).toBe(true);
    expect(svc.getAccountName()).toBe("user@example.com");
    expect(await svc.getAccessToken()).toBe("valid-token");
  });

  // ── 2: expired token ───────────────────────────────────────────────────────
  it("loadSavedToken: expired token → isAuthenticated() false", async () => {
    mockReadFile.mockResolvedValue(
      makeSavedJson({ accessToken: "plain:old-token", expiry: pastExpiry() }),
    );

    const svc = new MsGraphService("/tmp/test-userData");
    await svc.loadSavedToken();

    expect(svc.isAuthenticated()).toBe(false);
    expect(await svc.getAccessToken()).toBeNull();
  });

  // ── 3: invalid JSON ────────────────────────────────────────────────────────
  it("loadSavedToken: invalid JSON → no throw, isAuthenticated() false", async () => {
    mockReadFile.mockResolvedValue("NOT_JSON{{{{");

    const svc = new MsGraphService("/tmp/test-userData");
    await expect(svc.loadSavedToken()).resolves.toBeUndefined();
    expect(svc.isAuthenticated()).toBe(false);
  });

  // ── 4: encrypted token with safeStorage available ─────────────────────────
  it("loadSavedToken: encrypted token + safeStorage available → decrypts and authenticates", async () => {
    const encryptedToken = Buffer.from("enc:secret-token").toString("base64");
    mockReadFile.mockResolvedValue(
      makeSavedJson({ accessToken: encryptedToken }),
    );
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockSafeStorage.decryptString.mockImplementation((b: Buffer) =>
      b.toString().replace(/^enc:/, ""),
    );

    const svc = new MsGraphService("/tmp/test-userData");
    await svc.loadSavedToken();

    expect(svc.isAuthenticated()).toBe(true);
    expect(await svc.getAccessToken()).toBe("secret-token");
  });

  // ── 5: encrypted token with safeStorage unavailable ──────────────────────
  it("loadSavedToken: encrypted token + safeStorage unavailable → skips, isAuthenticated() false", async () => {
    const encryptedToken = Buffer.from("enc:secret-token").toString("base64");
    mockReadFile.mockResolvedValue(
      makeSavedJson({ accessToken: encryptedToken }),
    );
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

    const svc = new MsGraphService("/tmp/test-userData");
    await svc.loadSavedToken();

    expect(svc.isAuthenticated()).toBe(false);
  });

  // ── 6: persistToken encrypts when safeStorage available ───────────────────
  it("persistToken: encrypts token when safeStorage is available", async () => {
    mockAcquireTokenInteractive.mockReturnValue(
      Promise.resolve({
        accessToken: "raw-token",
        expiresOn: new Date(Date.now() + 3_600_000),
        account: { username: "user@example.com" },
      }),
    );
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockSafeStorage.encryptString.mockImplementation((s: string) => Buffer.from(`enc:${s}`));

    const svc = new MsGraphService("/tmp/test-userData");
    await svc.startInteractiveAuth(async () => {});

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    // Should NOT start with "plain:" when encryption is available
    expect(written.accessToken).not.toMatch(/^plain:/);
    // Should be base64-encoded encrypted data
    const decoded = Buffer.from(written.accessToken, "base64").toString();
    expect(decoded).toMatch(/^enc:/);
  });

  // ── 7: persistToken uses plain: prefix when safeStorage unavailable ───────
  it("persistToken: uses plain: prefix when safeStorage unavailable", async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
    mockAcquireTokenInteractive.mockReturnValue(
      Promise.resolve({
        accessToken: "raw-token",
        expiresOn: new Date(Date.now() + 3_600_000),
        account: { username: "user@example.com" },
      }),
    );

    const svc = new MsGraphService("/tmp/test-userData");
    await svc.startInteractiveAuth(async () => {});

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.accessToken).toBe("plain:raw-token");
  });

  // ── 8: persistToken writes with mode 0o600 ────────────────────────────────
  it("persistToken: writes token file with mode 0o600", async () => {
    mockAcquireTokenInteractive.mockReturnValue(
      Promise.resolve({
        accessToken: "raw-token",
        expiresOn: new Date(Date.now() + 3_600_000),
        account: { username: "user@example.com" },
      }),
    );

    const svc = new MsGraphService("/tmp/test-userData");
    await svc.startInteractiveAuth(async () => {});

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const options = mockWriteFile.mock.calls[0][2] as { encoding: string; mode: number };
    expect(options.mode).toBe(0o600);
  });

  // ── 9: null acquireToken result → no persist, no notifyChange ─────────────
  it("startInteractiveAuth: null result → does not persist or notify", async () => {
    mockAcquireTokenInteractive.mockReturnValue(Promise.resolve(null));

    const handler = vi.fn();
    const svc = new MsGraphService("/tmp/test-userData");
    svc.onAuthChange(handler);
    await svc.startInteractiveAuth(async () => {});

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(svc.isAuthenticated()).toBe(false);
  });

  // ── 10: result with expiresOn === null → throws ───────────────────────────
  it("startInteractiveAuth: expiresOn null → throws and does not persist", async () => {
    mockAcquireTokenInteractive.mockReturnValue(
      Promise.resolve({
        accessToken: "raw-token",
        expiresOn: null,
        account: { username: "user@example.com" },
      }),
    );

    const svc = new MsGraphService("/tmp/test-userData");
    await expect(svc.startInteractiveAuth(async () => {})).rejects.toThrow(
      "Interactive authentication did not return a token expiry.",
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(svc.isAuthenticated()).toBe(false);
  });

  // ── 11: valid result → persists and notifies ──────────────────────────────
  it("startInteractiveAuth: valid result → persists token and calls onAuthChange", async () => {
    const expiry = new Date(Date.now() + 3_600_000);
    mockAcquireTokenInteractive.mockReturnValue(
      Promise.resolve({
        accessToken: "valid-token",
        expiresOn: expiry,
        account: { username: "user@example.com" },
      }),
    );

    const handler = vi.fn();
    const svc = new MsGraphService("/tmp/test-userData");
    svc.onAuthChange(handler);
    await svc.startInteractiveAuth(async () => {});

    expect(svc.isAuthenticated()).toBe(true);
    expect(svc.getAccountName()).toBe("user@example.com");
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  // ── 12: isAuthenticated() without any token ───────────────────────────────
  it("isAuthenticated(): false when no token loaded", () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const svc = new MsGraphService("/tmp/test-userData");
    expect(svc.isAuthenticated()).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Sprint 4-D T1 — Silent refresh
  // ══════════════════════════════════════════════════════════════════════════

  describe("silent refresh (Sprint 4-D T1)", () => {
    const mockAccount = { username: "user@example.com", name: "User" };

    it("expired token → acquireTokenSilent called → returns fresh token", async () => {
      // Start with an expired token
      mockReadFile.mockResolvedValue(
        makeSavedJson({ accessToken: "plain:old-token", expiry: pastExpiry() }),
      );
      mockGetAllAccounts.mockResolvedValue([mockAccount]);
      const newExpiry = new Date(Date.now() + 3_600_000);
      mockAcquireTokenSilent.mockResolvedValue({
        accessToken: "refreshed-token",
        expiresOn: newExpiry,
        account: mockAccount,
      });

      const svc = new MsGraphService("/tmp/test-userData");
      await svc.loadSavedToken(); // expired so nothing loaded
      const token = await svc.getAccessToken();

      expect(mockAcquireTokenSilent).toHaveBeenCalledOnce();
      expect(mockAcquireTokenSilent.mock.calls[0][0]).toMatchObject({ account: mockAccount });
      expect(token).toBe("refreshed-token");
      expect(svc.isAuthenticated()).toBe(true);
    });

    it("silent refresh InteractionRequired → returns null + fires onAuthExpired", async () => {
      mockGetAllAccounts.mockResolvedValue([mockAccount]);
      const err = Object.assign(new Error("interaction_required"), {
        name: "InteractionRequiredAuthError",
      });
      mockAcquireTokenSilent.mockRejectedValue(err);

      const svc = new MsGraphService("/tmp/test-userData");
      const expiredHandler = vi.fn();
      svc.onAuthExpired(expiredHandler);

      const token = await svc.getAccessToken();
      expect(token).toBeNull();
      expect(expiredHandler).toHaveBeenCalledOnce();
      expect(svc.isAuthenticated()).toBe(false);
    });

    it("silent refresh transient error → returns null, does NOT fire onAuthExpired", async () => {
      mockGetAllAccounts.mockResolvedValue([mockAccount]);
      mockAcquireTokenSilent.mockRejectedValue(new Error("ETIMEDOUT"));

      const svc = new MsGraphService("/tmp/test-userData");
      const expiredHandler = vi.fn();
      svc.onAuthExpired(expiredHandler);

      const token = await svc.getAccessToken();
      expect(token).toBeNull();
      expect(expiredHandler).not.toHaveBeenCalled();
    });

    it("no cached account → returns null without calling acquireTokenSilent", async () => {
      mockGetAllAccounts.mockResolvedValue([]);
      mockGetAccountByUsername.mockResolvedValue(null);

      const svc = new MsGraphService("/tmp/test-userData");
      const token = await svc.getAccessToken();

      expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
      expect(token).toBeNull();
    });

    it("concurrent getAccessToken calls share a single in-flight refresh promise", async () => {
      mockGetAllAccounts.mockResolvedValue([mockAccount]);
      let resolveSilent!: (v: unknown) => void;
      mockAcquireTokenSilent.mockReturnValue(
        new Promise((r) => {
          resolveSilent = r;
        }),
      );

      const svc = new MsGraphService("/tmp/test-userData");
      const p1 = svc.getAccessToken();
      const p2 = svc.getAccessToken();
      const p3 = svc.getAccessToken();

      // Flush microtasks so silentRefresh() gets past the `getAllAccounts` await
      // and reaches `acquireTokenSilent`, but does not resolve yet (promise held).
      await Promise.resolve();
      await Promise.resolve();

      // All three should be awaiting the same refresh
      expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

      resolveSilent({
        accessToken: "shared-refresh-token",
        expiresOn: new Date(Date.now() + 3_600_000),
        account: mockAccount,
      });

      const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
      expect(t1).toBe("shared-refresh-token");
      expect(t2).toBe("shared-refresh-token");
      expect(t3).toBe("shared-refresh-token");
      expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
    });

    it("cached valid token → short-circuits, no silent refresh call", async () => {
      mockReadFile.mockResolvedValue(makeSavedJson({ accessToken: "plain:fresh-token" }));

      const svc = new MsGraphService("/tmp/test-userData");
      await svc.loadSavedToken();
      const token = await svc.getAccessToken();

      expect(token).toBe("fresh-token");
      expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
    });
  });

  // ── dual-environment switch / sign-out / legacy migration ──────────────────
  describe("dual-environment (switchEnvironment / signOut / legacy migration)", () => {
    it("legacy migration: external init with ms-graph-token.json present but -external missing → renames", async () => {
      // loadSavedToken checks existsSync(tokenPath) then existsSync(legacyPath).
      // Simulate: new file missing, legacy present.
      mockExistsSync.mockImplementation((p: string) =>
        p.endsWith("ms-graph-token.json"),
      );
      mockReadFile.mockResolvedValue(makeSavedJson());

      const svc = new MsGraphService("/tmp/test-userData", "external");
      await svc.loadSavedToken();

      expect(mockRename).toHaveBeenCalledTimes(1);
      const [fromPath, toPath] = (mockRename.mock.calls[0] ?? []) as [string, string];
      expect(fromPath).toMatch(/ms-graph-token\.json$/);
      expect(toPath).toMatch(/ms-graph-token-external\.json$/);
      expect(svc.isAuthenticated()).toBe(true);
    });

    it("legacy migration: corporate env does NOT migrate legacy file", async () => {
      mockExistsSync.mockImplementation((p: string) =>
        p.endsWith("ms-graph-token.json"),
      );
      mockReadFile.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const svc = new MsGraphService("/tmp/test-userData", "corporate");
      await svc.loadSavedToken();

      expect(mockRename).not.toHaveBeenCalled();
    });

    it("switchEnvironment: resets in-memory state + reloads new env token + notifies", async () => {
      // Start in external with loaded token
      mockReadFile.mockResolvedValue(makeSavedJson({ account: "ext@example.com" }));
      const svc = new MsGraphService("/tmp/test-userData", "external");
      await svc.loadSavedToken();
      expect(svc.getEnvironment()).toBe("external");
      expect(svc.isAuthenticated()).toBe(true);

      const changeSpy = vi.fn();
      svc.onAuthChange(changeSpy);

      // Switch to corporate — file for corporate env does not exist
      mockReadFile.mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
      mockExistsSync.mockReturnValue(false);
      await svc.switchEnvironment("corporate");

      expect(svc.getEnvironment()).toBe("corporate");
      expect(svc.isAuthenticated()).toBe(false);
      expect(svc.getAccountName()).toBeNull();
      expect(changeSpy).toHaveBeenCalled();
    });

    it("switchEnvironment: same env is no-op", async () => {
      mockReadFile.mockResolvedValue(makeSavedJson());
      const svc = new MsGraphService("/tmp/test-userData", "external");
      await svc.loadSavedToken();
      const changeSpy = vi.fn();
      svc.onAuthChange(changeSpy);

      await svc.switchEnvironment("external");

      expect(changeSpy).not.toHaveBeenCalled();
      expect(svc.isAuthenticated()).toBe(true);
    });

    it("signOut: clears in-memory state + removes MSAL accounts + notifies", async () => {
      mockReadFile.mockResolvedValue(makeSavedJson());
      mockGetAllAccounts.mockResolvedValue([{ username: "user@example.com" }]);
      const svc = new MsGraphService("/tmp/test-userData", "external");
      await svc.loadSavedToken();
      expect(svc.isAuthenticated()).toBe(true);

      const changeSpy = vi.fn();
      svc.onAuthChange(changeSpy);
      await svc.signOut();

      expect(svc.isAuthenticated()).toBe(false);
      expect(svc.getAccountName()).toBeNull();
      expect(mockRemoveAccount).toHaveBeenCalledTimes(1);
      expect(changeSpy).toHaveBeenCalled();
    });

    it("race guard: switchEnvironment mid-refresh discards stale token (does not persist)", async () => {
      // Start: external with account present
      mockReadFile.mockResolvedValue(makeSavedJson({ accessToken: "plain:expired" }));
      mockGetAllAccounts.mockResolvedValue([{ username: "user@example.com" }]);
      const svc = new MsGraphService("/tmp/test-userData", "external");
      await svc.loadSavedToken();
      // Force invalidation by pretending loaded token is expired via direct getAccessToken trigger
      (svc as unknown as { tokenExpiry: Date }).tokenExpiry = new Date(Date.now() - 1);

      // Craft acquireTokenSilent to resolve AFTER switchEnvironment runs
      let resolveSilent: (v: unknown) => void = () => {};
      mockAcquireTokenSilent.mockImplementation(
        () =>
          new Promise((res) => {
            resolveSilent = res;
          }),
      );

      const refreshPromise = svc.getAccessToken();

      // Switch env while silent is in-flight
      mockReadFile.mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
      mockExistsSync.mockReturnValue(false);
      await svc.switchEnvironment("corporate");

      // Now resolve the stale silent refresh with a token
      resolveSilent({
        accessToken: "stale-external-token",
        expiresOn: new Date(Date.now() + 60_000),
        account: { username: "user@example.com" },
      });
      const result = await refreshPromise;

      // Stale token must be discarded, not persisted
      expect(result).toBeNull();
      expect(svc.isAuthenticated()).toBe(false);
      // writeFile must not have been called post-switch (no persist from stale path)
      const postSwitchWrites = mockWriteFile.mock.calls.filter((call) => {
        const path = call[0] as string;
        return path.endsWith("ms-graph-token-corporate.json");
      });
      expect(postSwitchWrites.length).toBe(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Sprint 4-D T1 — withMsGraphRetry helper
// ══════════════════════════════════════════════════════════════════════════

import { withMsGraphRetry, is401, MsGraphAuthRequiredError } from "../ms-graph-retry.js";

describe("withMsGraphRetry (Sprint 4-D T1)", () => {
  it("happy path: single call, returns result", async () => {
    const getToken = vi.fn<[], Promise<string | null>>().mockResolvedValue("tok-1");
    const fn = vi.fn(async (_t: string) => "ok");
    const result = await withMsGraphRetry(fn, getToken);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith("tok-1");
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("401 on first attempt → refetches token → retries once → success", async () => {
    const getToken = vi
      .fn<[], Promise<string | null>>()
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("fresh");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }))
      .mockResolvedValueOnce("ok");

    const result = await withMsGraphRetry(fn, getToken);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "stale");
    expect(fn).toHaveBeenNthCalledWith(2, "fresh");
  });

  it("401 twice → throws original error", async () => {
    const firstErr = Object.assign(new Error("first 401"), { status: 401 });
    const secondErr = Object.assign(new Error("second 401"), { status: 401 });
    const getToken = vi
      .fn<[], Promise<string | null>>()
      .mockResolvedValue("tok");
    const fn = vi.fn().mockRejectedValueOnce(firstErr).mockRejectedValueOnce(secondErr);

    await expect(withMsGraphRetry(fn, getToken)).rejects.toBe(firstErr);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("non-401 error → does NOT retry, propagates immediately", async () => {
    const err = Object.assign(new Error("Server error"), { status: 500 });
    const getToken = vi.fn<[], Promise<string | null>>().mockResolvedValue("tok");
    const fn = vi.fn().mockRejectedValueOnce(err);

    await expect(withMsGraphRetry(fn, getToken)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("getToken returns null on first call → throws MsGraphAuthRequiredError", async () => {
    const getToken = vi.fn<[], Promise<string | null>>().mockResolvedValue(null);
    const fn = vi.fn();
    await expect(withMsGraphRetry(fn, getToken)).rejects.toBeInstanceOf(
      MsGraphAuthRequiredError,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("401 then getToken returns null on retry → rethrows original 401", async () => {
    const firstErr = Object.assign(new Error("first 401"), { status: 401 });
    const getToken = vi
      .fn<[], Promise<string | null>>()
      .mockResolvedValueOnce("tok")
      .mockResolvedValueOnce(null);
    const fn = vi.fn().mockRejectedValueOnce(firstErr);

    await expect(withMsGraphRetry(fn, getToken)).rejects.toBe(firstErr);
  });

  it("is401 detects various 401 shapes", () => {
    expect(is401({ status: 401 })).toBe(true);
    expect(is401({ statusCode: 401 })).toBe(true);
    expect(is401({ response: { status: 401 } })).toBe(true);
    expect(is401(new Error("Graph API 오류 401"))).toBe(true);
    expect(is401({ status: 500 })).toBe(false);
    expect(is401(null)).toBe(false);
    expect(is401(undefined)).toBe(false);
  });
});
