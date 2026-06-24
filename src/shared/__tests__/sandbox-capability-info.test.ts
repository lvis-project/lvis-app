/**
 * Unit tests for sandboxConfinementForPlatform — the honest, no-overclaim
 * per-platform confinement profile that drives the settings toggle text.
 */
import { describe, it, expect } from "vitest";
import { sandboxConfinementForPlatform } from "../sandbox-capability-info.js";

describe("sandboxConfinementForPlatform", () => {
  it("macOS confines filesystem + process + network (Seatbelt via ASRT — egress contained by the loopback proxy + strict-union allow-list)", () => {
    expect(sandboxConfinementForPlatform("darwin", "full")).toEqual({
      filesystem: true,
      process: true,
      network: true,
    });
  });

  it("Linux confines filesystem + process + network (bubblewrap via ASRT)", () => {
    expect(sandboxConfinementForPlatform("linux", "full")).toEqual({
      filesystem: true,
      process: true,
      network: true,
    });
  });

  it("Windows confines nothing — fail-closed, no sandbox", () => {
    expect(sandboxConfinementForPlatform("win32", "none")).toEqual({
      filesystem: false,
      process: false,
      network: false,
    });
  });

  it("reports no confinement when the runner kind is none regardless of platform", () => {
    expect(sandboxConfinementForPlatform("linux", "none")).toEqual({
      filesystem: false,
      process: false,
      network: false,
    });
    expect(sandboxConfinementForPlatform("darwin", "none")).toEqual({
      filesystem: false,
      process: false,
      network: false,
    });
  });

  it("claims REAL network containment on macOS when active (ASRT loopback-proxy floor)", () => {
    expect(sandboxConfinementForPlatform("darwin", "full").network).toBe(true);
  });
});
