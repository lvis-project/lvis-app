import { describe, it, expect } from "vitest";
import {
  extractPluginAuthErrorCode,
  sanitizePluginAuthErrorCode,
} from "../utils/plugin-auth-error.js";

describe("sanitizePluginAuthErrorCode", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ["non-corp-network", "non-corp-network"],
    ["  spaced  ", "spaced"],
    ["a.b:c-d_e", "a.b:c-d_e"],
    ["has space", null],
    ["", null],
    [null, null],
    [undefined, null],
    ["-leadingdash", null],
  ];
  it.each(cases)("sanitize(%p) -> %p", (input, expected) => {
    expect(sanitizePluginAuthErrorCode(input)).toBe(expected);
  });
});

describe("extractPluginAuthErrorCode", () => {
  it("prefers an explicit `code` field", () => {
    expect(extractPluginAuthErrorCode({ code: "token-expired" })).toBe("token-expired");
  });

  it("falls back to an `error` field when no code", () => {
    expect(extractPluginAuthErrorCode({ error: "denied" })).toBe("denied");
  });

  it("extracts a bracketed code from an Error message", () => {
    expect(extractPluginAuthErrorCode(new Error("login failed [non-corp-network]"))).toBe(
      "non-corp-network",
    );
  });

  it("extracts a bracketed code from a plain string", () => {
    expect(extractPluginAuthErrorCode("[bad-cert] handshake failed")).toBe("bad-cert");
  });

  it("returns null for an unsafe explicit code and no bracket fallback", () => {
    expect(extractPluginAuthErrorCode({ code: "has space" })).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(extractPluginAuthErrorCode(new Error("something went wrong"))).toBeNull();
    expect(extractPluginAuthErrorCode(null)).toBeNull();
    expect(extractPluginAuthErrorCode(undefined)).toBeNull();
    expect(extractPluginAuthErrorCode(42)).toBeNull();
  });
});
