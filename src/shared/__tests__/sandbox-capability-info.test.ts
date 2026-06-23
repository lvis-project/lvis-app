/**
 * Unit tests for sandboxConfinementForPlatform — the honest, no-overclaim
 * per-platform confinement profile that drives the settings toggle text.
 */
import { describe, it, expect } from "vitest";
import { sandboxConfinementForPlatform } from "../sandbox-capability-info.js";

describe("sandboxConfinementForPlatform", () => {
  it("macOS confines filesystem + process but NOT network (Seatbelt is PARTIAL)", () => {
    expect(sandboxConfinementForPlatform("darwin", "partial")).toEqual({
      filesystem: true,
      process: true,
      network: false,
    });
  });

  it("Linux confines filesystem + process + network (bubblewrap --unshare-net)", () => {
    expect(sandboxConfinementForPlatform("linux", "full")).toEqual({
      filesystem: true,
      process: true,
      network: true,
    });
  });

  it("Windows confines nothing — no runner available", () => {
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

  it("never claims network containment on macOS even when active", () => {
    expect(sandboxConfinementForPlatform("darwin", "partial").network).toBe(false);
  });
});
