import { describe, expect, it } from "vitest";
import {
  isAwayAuthorityArmInput,
  isAwayAuthorityIntentOnlyInput,
  parseAwayAuthorityMutationResult,
  parseAwayAuthorityStatusResult,
} from "../away-authority-arm.js";

const intent = { inputOrigin: "user-keyboard" as const, userActivation: true as const };

/**
 * The one payload every case starts from. A frozen constant rather than a
 * builder: a case that wants a different value spreads it inline, which keeps
 * the spoiled field visible in the case itself.
 */
const VALID: Readonly<Record<string, unknown>> = Object.freeze({
  intent,
  mode: "read-only",
  directories: ["/home/owner/project"],
  duration: "1h",
  budget: 10,
});

function without(field: string): Record<string, unknown> {
  const payload = { ...VALID };
  delete payload[field];
  return payload;
}

function liveStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    writable: false,
    directories: ["/home/owner/project"],
    expiresAt: 1_800_000_000_000,
    remaining: 5,
    ...overrides,
  };
}

describe("away authority arm wire contract", () => {
  it("accepts a payload the desk can actually produce", () => {
    expect(isAwayAuthorityArmInput({ ...VALID })).toBe(true);
    expect(isAwayAuthorityArmInput({ ...VALID, mode: "read-write", duration: "4h", budget: 50 }))
      .toBe(true);
  });

  it("accepts an empty directory list, leaving the refusal to the grant parser", () => {
    // A read-only grant with no directory is refused by
    // `parseAwayAuthorityGrant`, not here: this guard checks shape, and putting
    // the scope rule in two places is how the two stop agreeing.
    expect(isAwayAuthorityArmInput({ ...VALID, directories: [] })).toBe(true);
  });

  it.each([
    ["a missing intent", without("intent")],
    ["a missing field", without("budget")],
    ["a stale gesture", { ...VALID, intent: { inputOrigin: "user-keyboard", userActivation: false } }],
    ["a non-keyboard origin", { ...VALID, intent: { inputOrigin: "plugin", userActivation: true } }],
    ["an unarmable mode", { ...VALID, mode: "shell" }],
    ["a duration off the menu", { ...VALID, duration: "8h" }],
    ["a budget off the menu", { ...VALID, budget: 51 }],
    ["a budget that is a numeric string", { ...VALID, budget: "10" }],
    ["a directory list that is a string", { ...VALID, directories: "/home/owner" }],
    ["a directory that is not a string", { ...VALID, directories: [42] }],
    ["an empty-string directory", { ...VALID, directories: ["/home/owner", ""] }],
    ["more directories than the wire allows", {
      ...VALID,
      directories: Array.from({ length: 17 }, (_unused, i) => `/p${i}`),
    }],
    ["a conversation the caller tried to name", { ...VALID, conversationId: "conv-1" }],
    ["a raw ttl the caller tried to smuggle in", { ...VALID, ttlMs: 999 }],
    ["an array", []],
    ["null", null],
  ])("refuses %s", (_label, payload) => {
    expect(isAwayAuthorityArmInput(payload)).toBe(false);
  });

  it("accepts an intent-only payload and refuses one carrying anything else", () => {
    expect(isAwayAuthorityIntentOnlyInput({ intent })).toBe(true);
    expect(isAwayAuthorityIntentOnlyInput({ intent, mode: "read-write" })).toBe(false);
    expect(isAwayAuthorityIntentOnlyInput({})).toBe(false);
  });

  it("rebuilds a mutation result and drops unknown fields by refusing them", () => {
    expect(parseAwayAuthorityMutationResult({ ok: true })).toEqual({ ok: true });
    expect(parseAwayAuthorityMutationResult({ ok: false, error: "away-authority-disabled" }))
      .toEqual({ ok: false, error: "away-authority-disabled" });
    expect(parseAwayAuthorityMutationResult({ ok: true, grant: "secret" })).toBeNull();
    expect(parseAwayAuthorityMutationResult({ ok: false, error: "made-up-code" })).toBeNull();
  });

  it("rebuilds a status result rather than forwarding the wire object", () => {
    const wire = { ok: true, status: liveStatus() };
    const parsed = parseAwayAuthorityStatusResult(wire);

    expect(parsed).toEqual({ ok: true, status: liveStatus() });
    expect(parsed).not.toBe(wire);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("carries the nothing-armed answer through as itself", () => {
    expect(parseAwayAuthorityStatusResult({ ok: true, status: null }))
      .toEqual({ ok: true, status: null });
  });

  it.each([
    ["a conversation id main must never send", { ok: true, status: liveStatus({ conversationId: "c" }) }],
    ["a spent grant reported as armed", { ok: true, status: liveStatus({ remaining: 0 }) }],
    ["a negative expiry", { ok: true, status: liveStatus({ expiresAt: -1 }) }],
    ["a non-boolean writable", { ok: true, status: liveStatus({ writable: "yes" }) }],
    ["a directory that is not a string", { ok: true, status: liveStatus({ directories: [7] }) }],
  ])("refuses a status carrying %s", (_label, wire) => {
    expect(parseAwayAuthorityStatusResult(wire)).toBeNull();
  });
});
