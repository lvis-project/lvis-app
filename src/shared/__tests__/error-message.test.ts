import { describe, expect, it } from "vitest";

import {
  errorMessage,
  errorMessageOrSerialized,
  errorMessageWithCauseCode,
} from "../error-message.js";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new RangeError("out of range"))).toBe("out of range");
  });

  it("stringifies anything that is not an Error", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ message: "not an Error" })).toBe("[object Object]");
  });
});

describe("errorMessageOrSerialized", () => {
  it("agrees with errorMessage for Errors and strings", () => {
    expect(errorMessageOrSerialized(new Error("boom"))).toBe("boom");
    expect(errorMessageOrSerialized("plain")).toBe("plain");
  });

  it("reads the message off a record that carries one", () => {
    expect(errorMessageOrSerialized({ message: "from body", code: 429 })).toBe("from body");
  });

  it("serialises records without a string message instead of printing [object Object]", () => {
    expect(errorMessageOrSerialized({ code: 429 })).toBe('{"code":429}');
    expect(errorMessageOrSerialized([1, 2])).toBe("[1,2]");
  });

  it("falls back to String() when the value cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(errorMessageOrSerialized(cyclic)).toBe("[object Object]");
    expect(errorMessageOrSerialized(10n)).toBe("10");
  });

  it("appends the transport code a fetch failure hides on cause", () => {
    const err = new TypeError("fetch failed", {
      cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    });
    expect(errorMessageWithCauseCode(err)).toBe(
      "fetch failed (SELF_SIGNED_CERT_IN_CHAIN)",
    );
  });

  it("keeps the cause's own message out of the diagnostic", () => {
    const err = new TypeError("fetch failed", {
      cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host.example" },
    });
    expect(errorMessageWithCauseCode(err)).toBe("fetch failed (ENOTFOUND)");
  });

  it("returns the plain message when there is no cause code to add", () => {
    expect(errorMessageWithCauseCode(new Error("boom"))).toBe("boom");
    expect(errorMessageWithCauseCode(new TypeError("x", { cause: {} }))).toBe("x");
    expect(errorMessageWithCauseCode("plain")).toBe("plain");
  });
});
