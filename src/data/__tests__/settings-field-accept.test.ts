import { describe, expect, it, vi } from "vitest";
import {
  PATCHED_FIELD,
  STORED_FIELD,
  acceptField,
  acceptNormalizedField,
  isBooleanValue,
} from "../settings-field-accept.js";

const warn = vi.fn();
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ warn: (...args: unknown[]) => warn(...args) }),
}));

describe("acceptField", () => {
  it("takes a value of the right shape", () => {
    const target = { hardwareAcceleration: true };

    acceptField(target, "hardwareAcceleration", false, isBooleanValue, "system", STORED_FIELD);

    expect(target.hardwareAcceleration).toBe(false);
  });

  it("leaves what stands in place when the shape is wrong", () => {
    const target = { hardwareAcceleration: true };

    acceptField(target, "hardwareAcceleration", "yes", isBooleanValue, "system", STORED_FIELD);

    expect(target.hardwareAcceleration).toBe(true);
  });

  it("says nothing about a field nobody has written", () => {
    // Absent is the ordinary case of an unset setting; warning about it would
    // make a clean profile look broken.
    warn.mockClear();
    const target = { hardwareAcceleration: true };

    acceptField(target, "hardwareAcceleration", undefined, isBooleanValue, "system", STORED_FIELD);

    expect(warn).not.toHaveBeenCalled();
  });

  it("names the field it rejected and the value that stands instead", () => {
    warn.mockClear();
    const target = { corpCaEnabled: true };

    acceptField(target, "corpCaEnabled", 1, isBooleanValue, "system", STORED_FIELD);

    expect(warn).toHaveBeenCalledWith(
      "system.corpCaEnabled invalid (received 1), using default %s",
      true,
    );
  });

  it("distinguishes a bad stored value from a rejected patch", () => {
    warn.mockClear();
    const target = { corpCaEnabled: false };

    acceptField(target, "corpCaEnabled", "no", isBooleanValue, "system", PATCHED_FIELD);

    expect(warn).toHaveBeenCalledWith(
      'system.corpCaEnabled patch ignored (received "no"), keeping %s',
      false,
    );
  });

  it("stores what a transform returned, not the raw value it was given", () => {
    warn.mockClear();
    const target = { sidebarWidth: 232 };

    acceptNormalizedField(
      target, "sidebarWidth", 10_000,
      (value) => (typeof value === "number" ? Math.min(480, value) : undefined),
      "system", STORED_FIELD,
    );

    expect(target.sidebarWidth).toBe(480);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a transform's undefined as a rejection and keeps what stands", () => {
    warn.mockClear();
    const target = { sidebarWidth: 232 };

    acceptNormalizedField(target, "sidebarWidth", "wide", () => undefined, "system", STORED_FIELD);

    expect(target.sidebarWidth).toBe(232);
    expect(warn).toHaveBeenCalledWith(
      'system.sidebarWidth invalid (received "wide"), using default %s',
      232,
    );
  });

  it("stays silent for an absent field even when the transform rejects it", () => {
    warn.mockClear();
    const target = { sidebarWidth: 232 };

    acceptNormalizedField(target, "sidebarWidth", undefined, () => undefined, "system", STORED_FIELD);

    expect(warn).not.toHaveBeenCalled();
  });
});
