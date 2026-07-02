/**
 * trust-origin.ts — isExternalOrigin truth table (3-agent cluster review of
 * PR #1441, critic MAJOR-1).
 *
 * `isExternalOrigin` is the narrowing gate that decides whether a
 * {@link TrustOrigin} may participate in the #1409 external-mutation approval
 * bypass (see `src/ipc/handlers/permissions.ts` resolveApprovalBypass). Pin
 * the full truth table so a future TrustOrigin addition cannot silently
 * change which origins are treated as external without a test failing.
 */
import { describe, expect, it } from "vitest";

import { EXTERNAL_ORIGINS, isExternalOrigin, type TrustOrigin } from "../trust-origin.js";

describe("isExternalOrigin", () => {
  it.each(["local-api", "cli", "plugin-frame"] as const)(
    "%s is external (true)",
    (origin) => {
      expect(isExternalOrigin(origin)).toBe(true);
    },
  );

  it.each(["renderer"] as const)("%s is NOT external (false)", (origin) => {
    expect(isExternalOrigin(origin)).toBe(false);
  });

  it("rejects an unrecognized/garbage origin string", () => {
    expect(isExternalOrigin("garbage-origin" as TrustOrigin)).toBe(false);
  });

  it("EXTERNAL_ORIGINS stays byte-identical to the truth table above", () => {
    expect([...EXTERNAL_ORIGINS].sort()).toEqual(["cli", "local-api", "plugin-frame"].sort());
  });
});
