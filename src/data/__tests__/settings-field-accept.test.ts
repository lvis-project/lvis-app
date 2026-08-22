import { describe, expect, it, vi } from "vitest";
import {
  PATCHED_FIELD,
  STORED_FIELD,
  acceptField,
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
});
