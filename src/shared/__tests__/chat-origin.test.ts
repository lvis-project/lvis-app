import { describe, expect, it } from "vitest";

import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../chat-origin.js";

describe("USER_KEYBOARD_REQUIRED", () => {
  it("is the one frozen refusal every mutation domain returns", () => {
    expect(USER_KEYBOARD_REQUIRED).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(Object.isFrozen(USER_KEYBOARD_REQUIRED)).toBe(true);
  });
});

describe("hasUserKeyboardIntentPayload", () => {
  it("accepts a payload whose intent is a user-keyboard activation", () => {
    expect(hasUserKeyboardIntentPayload({ intent: { inputOrigin: "user-keyboard", userActivation: true } })).toBe(true);
  });

  it("rejects non-objects, missing intent, and non-keyboard intent", () => {
    expect(hasUserKeyboardIntentPayload(null)).toBe(false);
    expect(hasUserKeyboardIntentPayload("intent")).toBe(false);
    expect(hasUserKeyboardIntentPayload({})).toBe(false);
    expect(hasUserKeyboardIntentPayload({ intent: { inputOrigin: "user-keyboard", userActivation: false } })).toBe(false);
    expect(hasUserKeyboardIntentPayload({ intent: { inputOrigin: "programmatic", userActivation: true } })).toBe(false);
  });
});
