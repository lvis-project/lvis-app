import { describe, expect, it } from "vitest";

import {
  initialToolTrustOrigin,
  rationaleProvenanceFor,
  summarizePermissionUserIntent,
} from "../trust-origin.js";

describe("routine turn trust origin", () => {
  it("keeps scheduled prompts non-user for tool trust, permission intent, and rationale audit provenance", () => {
    const trustOrigin = initialToolTrustOrigin("routine", "scheduled pre-prompt");

    expect(trustOrigin).toBe("routine");
    expect(summarizePermissionUserIntent("routine", "scheduled pre-prompt")).toBeUndefined();
    expect(rationaleProvenanceFor(false, trustOrigin)).toEqual({
      startedFromUserKeyboard: false,
      taint: "routine",
    });
  });
});
