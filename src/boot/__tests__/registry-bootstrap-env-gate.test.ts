import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryMocks = vi.hoisted(() => ({
  whitelistInit: vi.fn(async () => undefined),
  whitelistSetPublicKeys: vi.fn(),
  revocationInit: vi.fn(async () => undefined),
  admissionInit: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/whitelist/whitelist-registry.js", () => ({
  whitelistRegistry: {
    init: registryMocks.whitelistInit,
    isNoCacheOffline: () => false,
    setPublicKeysForTesting: registryMocks.whitelistSetPublicKeys,
  },
}));

vi.mock("../../plugins/revocation/revocation-registry.js", () => ({
  revocationRegistry: { init: registryMocks.revocationInit },
}));

vi.mock("../../plugins/admission/admission-registry.js", () => ({
  admissionRegistry: { init: registryMocks.admissionInit },
}));

import { _resetForTest } from "../dev-flags.js";
import { wireAdmissionRegistry } from "../steps/admission-bootstrap.js";
import { wireRevocationRegistry } from "../steps/revocation-bootstrap.js";
import { wireWhitelistRegistry } from "../steps/whitelist-bootstrap.js";

const OFFLINE_NAMES = [
  "LVIS_WHITELIST_OFFLINE",
  "LVIS_REVOCATION_OFFLINE",
  "LVIS_ADMISSION_OFFLINE",
] as const;

const savedValues = new Map<string, string | undefined>();

async function wireAll(packaged: boolean): Promise<void> {
  const common = {
    userDataPath: "/tmp/lvis-registry-env-gate",
    bootAuditLogger: { log: vi.fn() } as never,
    networkFetch: vi.fn() as unknown as typeof fetch,
    packaged,
  };
  await wireWhitelistRegistry(common);
  await wireRevocationRegistry(common);
  await wireAdmissionRegistry(common);
}

describe("registry bootstrap development env gate", () => {
  beforeEach(() => {
    _resetForTest();
    registryMocks.whitelistInit.mockClear();
    registryMocks.whitelistSetPublicKeys.mockClear();
    registryMocks.revocationInit.mockClear();
    registryMocks.admissionInit.mockClear();
    for (const name of OFFLINE_NAMES) {
      savedValues.set(name, process.env[name]);
      process.env[name] = "1";
    }
  });

  afterEach(() => {
    _resetForTest();
    for (const name of OFFLINE_NAMES) {
      const saved = savedValues.get(name);
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
    savedValues.clear();
  });

  it("ignores all three offline flags in packaged mode even without an env scrub", async () => {
    await wireAll(true);

    expect(registryMocks.whitelistInit).toHaveBeenCalledWith(expect.objectContaining({ online: true }));
    expect(registryMocks.revocationInit).toHaveBeenCalledWith(expect.objectContaining({ online: true }));
    expect(registryMocks.admissionInit).toHaveBeenCalledWith(expect.objectContaining({ online: true }));
  });

  it("retains the offline flags for unpackaged source and E2E runs", async () => {
    await wireAll(false);

    expect(registryMocks.whitelistInit).toHaveBeenCalledWith(expect.objectContaining({ online: false }));
    expect(registryMocks.revocationInit).toHaveBeenCalledWith(expect.objectContaining({ online: false }));
    expect(registryMocks.admissionInit).toHaveBeenCalledWith(expect.objectContaining({ online: false }));
  });

  it("never replaces the whitelist trust key in packaged mode", async () => {
    const savedE2e = process.env.LVIS_E2E;
    const savedNodeEnv = process.env.NODE_ENV;
    const savedKey = process.env.LVIS_E2E_WHITELIST_PUBLIC_KEY;
    try {
      process.env.LVIS_E2E = "1";
      process.env.NODE_ENV = "test";
      process.env.LVIS_E2E_WHITELIST_PUBLIC_KEY = "synthetic-test-key";

      await wireAll(true);

      expect(registryMocks.whitelistSetPublicKeys).not.toHaveBeenCalled();
    } finally {
      if (savedE2e === undefined) delete process.env.LVIS_E2E;
      else process.env.LVIS_E2E = savedE2e;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedKey === undefined) delete process.env.LVIS_E2E_WHITELIST_PUBLIC_KEY;
      else process.env.LVIS_E2E_WHITELIST_PUBLIC_KEY = savedKey;
    }
  });
});
