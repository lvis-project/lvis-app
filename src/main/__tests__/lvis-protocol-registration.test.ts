import { describe, expect, it, vi } from "vitest";
import {
  ensurePackagedWindowsLvisProtocolClient,
  isSameWindowsExecutablePath,
  shouldDeferPackagedWindowsProtocolRegistration,
} from "../lvis-protocol-registration.js";

const CURRENT_EXE = "C:\\Program Files\\LVIS\\LVIS.exe";

describe("packaged Windows lvis protocol registration", () => {
  it("defers only packaged Windows registration", () => {
    expect(shouldDeferPackagedWindowsProtocolRegistration(true, "win32")).toBe(
      true,
    );
    expect(shouldDeferPackagedWindowsProtocolRegistration(false, "win32")).toBe(
      false,
    );
    expect(shouldDeferPackagedWindowsProtocolRegistration(true, "darwin")).toBe(
      false,
    );
    expect(shouldDeferPackagedWindowsProtocolRegistration(true, "linux")).toBe(
      false,
    );
  });

  it("compares normalized absolute Windows executable paths", () => {
    expect(
      isSameWindowsExecutablePath(
        "c:/PROGRAM FILES/LVIS/./LVIS.exe",
        CURRENT_EXE,
      ),
    ).toBe(true);
    expect(
      isSameWindowsExecutablePath(
        "\\\\?\\C:\\Program Files\\LVIS\\LVIS.exe",
        CURRENT_EXE,
      ),
    ).toBe(true);
    expect(isSameWindowsExecutablePath("LVIS.exe", CURRENT_EXE)).toBe(false);
    expect(isSameWindowsExecutablePath(" " + CURRENT_EXE, CURRENT_EXE)).toBe(
      false,
    );
    expect(isSameWindowsExecutablePath(null, CURRENT_EXE)).toBe(false);
    expect(
      isSameWindowsExecutablePath("\\\\server\\share\\LVIS.exe", CURRENT_EXE),
    ).toBe(false);
    expect(
      isSameWindowsExecutablePath(
        "\\\\?\\UNC\\server\\share\\LVIS.exe",
        CURRENT_EXE,
      ),
    ).toBe(false);
    expect(
      isSameWindowsExecutablePath(
        "\\\\.\\C:\\Program Files\\LVIS\\LVIS.exe",
        CURRENT_EXE,
      ),
    ).toBe(false);
  });

  it("does not create an HKCU registration when HKCR resolves to this executable", async () => {
    const getApplicationInfoForProtocol = vi
      .fn()
      .mockResolvedValue({ path: "c:/PROGRAM FILES/LVIS/LVIS.exe" });
    const setAsDefaultProtocolClient = vi.fn(() => true);

    await expect(
      ensurePackagedWindowsLvisProtocolClient(
        { getApplicationInfoForProtocol, setAsDefaultProtocolClient },
        CURRENT_EXE,
      ),
    ).resolves.toBe(true);

    expect(getApplicationInfoForProtocol).toHaveBeenCalledWith("lvis://");
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it.each([
    ["missing path", {}],
    ["malformed relative path", { path: "LVIS.exe" }],
    ["mismatched executable", { path: "C:\\Other\\LVIS.exe" }],
  ])("falls back to Electron for %s", async (_name, application) => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    await expect(
      ensurePackagedWindowsLvisProtocolClient(
        {
          getApplicationInfoForProtocol: vi.fn().mockResolvedValue(application),
          setAsDefaultProtocolClient,
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(true);

    expect(setAsDefaultProtocolClient).toHaveBeenCalledOnce();
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("lvis");
  });

  it("falls back when the Windows association lookup rejects", async () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    await expect(
      ensurePackagedWindowsLvisProtocolClient(
        {
          getApplicationInfoForProtocol: vi
            .fn()
            .mockRejectedValue(new Error("missing")),
          setAsDefaultProtocolClient,
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(true);

    expect(setAsDefaultProtocolClient).toHaveBeenCalledOnce();
  });

  it("soft-fails when Electron's setter throws", async () => {
    const setAsDefaultProtocolClient = vi.fn(() => {
      throw new Error("registry denied");
    });

    await expect(
      ensurePackagedWindowsLvisProtocolClient(
        {
          getApplicationInfoForProtocol: vi.fn().mockResolvedValue(null),
          setAsDefaultProtocolClient,
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(false);

    expect(setAsDefaultProtocolClient).toHaveBeenCalledOnce();
  });

  it("propagates Electron's registration failure result", async () => {
    await expect(
      ensurePackagedWindowsLvisProtocolClient(
        {
          getApplicationInfoForProtocol: vi.fn().mockResolvedValue(null),
          setAsDefaultProtocolClient: vi.fn(() => false),
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(false);
  });
});
