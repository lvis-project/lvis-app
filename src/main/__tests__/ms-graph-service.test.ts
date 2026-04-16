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
  mockReadFile,
  mockWriteFile,
  mockMkdir,
} = vi.hoisted(() => {
  return {
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
      decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, "")),
    },
    mockAcquireTokenInteractive: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(async () => undefined),
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
  }
  return { PublicClientApplication: MockPublicClientApplication };
});

// ─── Mock node:fs/promises ────────────────────────────────────────────────────
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
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
});
