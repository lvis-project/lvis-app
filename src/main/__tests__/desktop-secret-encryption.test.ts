import { afterEach, describe, expect, it, vi } from "vitest";

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString()),
}));
vi.mock("electron", () => ({ safeStorage }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("desktop encryption capability", () => {
  it("does not call the Linux-only backend API on macOS or Windows", async () => {
    for (const platform of ["darwin", "win32"]) {
      vi.stubGlobal("process", { ...process, platform });
      const { desktopSecretEncryption } = await import("../desktop-secret-encryption.js");
      expect(desktopSecretEncryption.getSelectedStorageBackend()).toBe("unknown");
      expect(desktopSecretEncryption.isEncryptionAvailable()).toBe(true);
      expect(desktopSecretEncryption.decryptString(desktopSecretEncryption.encryptString("fixture"))).toBe("fixture");
    }
  });
});
