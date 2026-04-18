/**
 * AP-1 FU Task B — dispatcher wiring tests.
 *
 * Three cases:
 *   1. Flag ON + happy path  → installFromMarketplace called, npm NOT called
 *   2. Flag ON + marketplace throws + fallback enabled → falls back to npm
 *   3. Flag OFF              → npm called directly, marketplace NOT called
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginMarketplaceItem } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them.
// ---------------------------------------------------------------------------

vi.mock("../marketplace-installer.js", () => ({
  isMarketplaceDirectPreferred: vi.fn(() => false),
  isNpmFallbackEnabled: vi.fn(() => true),
  installFromMarketplace: vi.fn(async () => ({
    slug: "test-plugin",
    version: "1.2.3",
    tarballPath: "/tmp/test-plugin/1.2.3.tar.gz",
    sha256: "abc123",
    signerKeyId: "poc-v1",
  })),
  MarketplaceInstallerError: class MarketplaceInstallerError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "MarketplaceInstallerError";
    }
  },
}));

vi.mock("../publisher-keys.js", () => ({
  getBundledPublicKeys: vi.fn(() => ({ "poc-v1": Buffer.alloc(32) })),
}));

// Mock registry helpers so no filesystem is needed.
vi.mock("../registry.js", () => ({
  readPluginRegistry: vi.fn(async () => ({ plugins: [] })),
  updatePluginRegistry: vi.fn(async () => {}),
  withRegistryLock: vi.fn(async (_path: string, fn: () => Promise<unknown>) => fn()),
  writePluginRegistry: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are hoisted by vitest)
// ---------------------------------------------------------------------------
import {
  isMarketplaceDirectPreferred,
  isNpmFallbackEnabled,
  installFromMarketplace,
  MarketplaceInstallerError,
} from "../marketplace-installer.js";
import { PluginMarketplaceService } from "../marketplace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PLUGIN: PluginMarketplaceItem = {
  id: "test-plugin",
  name: "Test Plugin",
  description: "A test plugin",
  packageSpec: "@lvis/test-plugin@1.2.3",
  packageName: "@lvis/test-plugin",
  tools: [],
};

function makeService() {
  const service = new PluginMarketplaceService("/fake/approot");

  // Stub fetcher so no filesystem is needed.
  (service as unknown as { fetcher: { listPlugins: () => Promise<PluginMarketplaceItem[]>; downloadVersion: () => Promise<{ zipBuffer: Buffer; sha256: string }> } }).fetcher = {
    listPlugins: vi.fn(async () => [TEST_PLUGIN]),
    downloadVersion: vi.fn(async () => ({
      zipBuffer: Buffer.from("fake-tarball"),
      sha256: "deadbeef",
    })),
  };

  // Stub npm helper so no child_process is spawned.
  const npmInstallMock = vi.fn(async () => {});
  (service as unknown as { runNpmInstall: typeof npmInstallMock }).runNpmInstall = npmInstallMock;

  // Stub manifest write + cache helpers so no fs writes happen.
  (service as unknown as { writeInstalledManifest: () => Promise<string> }).writeInstalledManifest = vi.fn(async () => "installed/test-plugin/plugin.json");
  (service as unknown as { cacheCurrentVersion: () => Promise<void> }).cacheCurrentVersion = vi.fn(async () => {});
  (service as unknown as { cacheVersionFromManifest: () => Promise<void> }).cacheVersionFromManifest = vi.fn(async () => {});

  return { service, npmInstallMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("install() dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Flag ON + happy path: calls installFromMarketplace, does NOT call npm", async () => {
    vi.mocked(isMarketplaceDirectPreferred).mockReturnValue(true);
    vi.mocked(isNpmFallbackEnabled).mockReturnValue(true);
    vi.mocked(installFromMarketplace).mockResolvedValue({
      slug: "test-plugin",
      version: "1.2.3",
      tarballPath: "/tmp/test-plugin/1.2.3.tar.gz",
      sha256: "abc123",
      signerKeyId: "poc-v1",
    });

    const { service, npmInstallMock } = makeService();
    await service.install("test-plugin");

    expect(installFromMarketplace).toHaveBeenCalledOnce();
    expect(installFromMarketplace).toHaveBeenCalledWith(
      "test-plugin",
      "1.2.3",
      expect.objectContaining({ publicKeys: expect.any(Object) }),
    );
    expect(npmInstallMock).not.toHaveBeenCalled();
  });

  it("Flag ON + marketplace throws + fallback enabled: falls back to npm", async () => {
    vi.mocked(isMarketplaceDirectPreferred).mockReturnValue(true);
    vi.mocked(isNpmFallbackEnabled).mockReturnValue(true);
    vi.mocked(installFromMarketplace).mockRejectedValue(
      new MarketplaceInstallerError("SIGNATURE_INVALID", "bad sig"),
    );

    const { service, npmInstallMock } = makeService();
    await service.install("test-plugin");

    expect(installFromMarketplace).toHaveBeenCalledOnce();
    expect(npmInstallMock).toHaveBeenCalledOnce();
    expect(npmInstallMock).toHaveBeenCalledWith("@lvis/test-plugin@1.2.3");
  });

  it("Flag OFF: calls npm directly, does NOT call installFromMarketplace", async () => {
    vi.mocked(isMarketplaceDirectPreferred).mockReturnValue(false);

    const { service, npmInstallMock } = makeService();
    await service.install("test-plugin");

    expect(installFromMarketplace).not.toHaveBeenCalled();
    expect(npmInstallMock).toHaveBeenCalledOnce();
    expect(npmInstallMock).toHaveBeenCalledWith("@lvis/test-plugin@1.2.3");
  });
});
