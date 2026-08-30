import { describe, expect, it } from "vitest";
import { UUID_PATTERN } from "../uuid.js";

describe("UUID_PATTERN", () => {
  it("accepts every RFC 9562 version nibble, in either case", () => {
    expect(UUID_PATTERN.test("abcdefab-cdef-4abc-8def-abcdefabcdef")).toBe(true); // v4
    expect(UUID_PATTERN.test("018f2f7e-3b2a-7c3d-9e4f-0123456789ab")).toBe(true); // v7
    expect(UUID_PATTERN.test("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true); // v1
    expect(UUID_PATTERN.test("ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")).toBe(true);
  });

  it("rejects non-hex, a version nibble outside 1-8 and a non-RFC variant", () => {
    expect(UUID_PATTERN.test("zzzzzzzz-cdef-4abc-8def-abcdefabcdef")).toBe(false);
    expect(UUID_PATTERN.test("abcdefab-cdef-0abc-8def-abcdefabcdef")).toBe(false);
    expect(UUID_PATTERN.test("abcdefab-cdef-9abc-8def-abcdefabcdef")).toBe(false);
    expect(UUID_PATTERN.test("abcdefab-cdef-4abc-cdef-abcdefabcdef")).toBe(false);
    expect(UUID_PATTERN.test("abcdefab-cdef-4abc-8def-abcdefabcde")).toBe(false);
  });
});
