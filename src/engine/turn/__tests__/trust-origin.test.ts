import { describe, expect, it } from "vitest";
import {
  initialToolTrustOrigin,
  rationaleProvenanceFor,
  summarizePermissionUserIntent,
} from "../trust-origin.js";

describe("surface-user trust origin", () => {
  it("keeps external-surface input in its own tool-review cache and rationale partition", () => {
    const origin = initialToolTrustOrigin("surface-user", "run this task");

    expect(origin).toBe("surface-user");
    expect(rationaleProvenanceFor(false, origin)).toEqual({
      startedFromUserKeyboard: false,
      taint: "surface-user",
    });
  });

  it("never derives user intent for an externally submitted message", () => {
    expect(summarizePermissionUserIntent(
      "surface-user",
      "delete the deployment output",
    )).toBeUndefined();
  });

  it("keeps Tailnet controller input in a distinct untrusted partition", () => {
    const origin = initialToolTrustOrigin("tailnet-surface", "run this task");

    expect(origin).toBe("tailnet-surface");
    expect(rationaleProvenanceFor(false, origin)).toEqual({
      startedFromUserKeyboard: false,
      taint: "tailnet-surface",
    });
    expect(summarizePermissionUserIntent(
      "tailnet-surface",
      "delete the deployment output",
    )).toBeUndefined();
  });

});
