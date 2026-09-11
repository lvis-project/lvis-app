import { describe, expect, it } from "vitest";
import { FILE_TRANSFER_LIMITS, validateFileTransferLimits } from "../file-transfer-policy.js";

describe("host transfer limits", () => {
  it("keeps one frozen general policy", () => {
    expect(Object.isFrozen(FILE_TRANSFER_LIMITS)).toBe(true);
    expect(FILE_TRANSFER_LIMITS).toEqual({
      bufferBytes: 65_536, maxPayloadBytes: 1_073_741_824,
      maxArchiveInputBytes: 1_073_741_824, maxDecodedArchiveBytes: 2_147_483_648,
      maxEntries: 10_000, maxDepth: 64, maxRelativePathBytes: 4096,
      maxArchiveMetaEntryBytes: 1_048_576,
    });
    expect(() => validateFileTransferLimits(FILE_TRANSFER_LIMITS)).not.toThrow();
  });

  it("accepts small positive injected limits and rejects each invalid field", () => {
    const limits = { ...FILE_TRANSFER_LIMITS };
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) limits[key] = 1;
    expect(() => validateFileTransferLimits(limits)).not.toThrow();
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined]) {
        expect(() => validateFileTransferLimits({ ...limits, [key]: value })).toThrow(key);
      }
    }
  });
});
