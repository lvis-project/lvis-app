/**
 * Away Authority — grant validation and per-call eligibility.
 *
 * These tests drive the answerer directly rather than through the gate,
 * because several of its conditions are not reachable through
 * `requestAndWait` today: the gate rejects a host-shell binding whose request
 * is not `toolCategory === "shell"` before the answerer is consulted, and the
 * one-shot choice contract already forces `durableApprovalRecordAllowed` to
 * false. Those checks exist so that a later change to either fact fails closed
 * here instead of silently handing the answerer a capability, and a guard that
 * no test can make fire is not a guard. The gate-level tests in
 * `approval-gate.test.ts` cover the injection point and the audit rows.
 */
import { describe, it, expect } from "vitest";
import {
  AwayAuthority,
  parseAwayAuthorityGrant,
  type AwayAuthorityArmInput,
  type AwayAuthorityCandidate,
} from "../away-authority.js";
import type { RemoteControllerAuthority } from "../../shared/chat-origin.js";
import { makePlatformBridgeAuthority } from "./test-helpers.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "../sensitive-paths.js";

const CONVERSATION = "conv-away-1";
const SCOPE_DIR = "/srv/away-scope";
const IN_SCOPE_FILE = "/srv/away-scope/notes.md";
const OUT_OF_SCOPE_FILE = "/srv/other-scope/notes.md";
/** Matches the Layer 0 dot-ssh sensitive-path pattern on every platform. */
const SENSITIVE_DIR = "/srv/away-scope/.ssh/keys";
const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

function makeArmInput(
  overrides: Partial<AwayAuthorityArmInput> = {},
): AwayAuthorityArmInput {
  return {
    conversationId: CONVERSATION,
    categories: ["read", "write"],
    directories: [SCOPE_DIR],
    ttlMs: HOUR_MS,
    budget: 5,
    ...overrides,
  };
}

/** A turn that is remote but not a paired platform: never away-answerable. */
const TAILNET_AUTHORITY: RemoteControllerAuthority = {
  kind: "tailnet-controller",
  actorId: "tailnet:actor",
};

/** The baseline every eligibility test flips exactly one field of. */
function makeCandidate(
  overrides: Partial<AwayAuthorityCandidate> = {},
): AwayAuthorityCandidate {
  return {
    remoteControllerOrigin: "platform-bridge",
    remoteControllerAuthority: makePlatformBridgeAuthority(),
    sessionId: CONVERSATION,
    source: "builtin",
    kind: undefined,
    category: "tool",
    toolCategory: "write",
    allowedChoices: ["allow-once", "deny-once"],
    durableApprovalRecordAllowed: false,
    hostShellExecutionPermitBound: false,
    targetFilePath: IN_SCOPE_FILE,
    ...overrides,
  };
}

function armed(input: Partial<AwayAuthorityArmInput> = {}): AwayAuthority {
  const authority = new AwayAuthority();
  const grant = parseAwayAuthorityGrant(makeArmInput(input), NOW);
  if (grant === null) throw new Error("test fixture produced an invalid grant");
  authority.arm(grant);
  return authority;
}

describe("parseAwayAuthorityGrant", () => {
  it("mints a grant from a well-formed desk gesture", () => {
    const grant = parseAwayAuthorityGrant(makeArmInput(), NOW);

    expect(grant).not.toBeNull();
    expect(grant?.conversationId).toBe(CONVERSATION);
    expect(grant?.categories).toEqual(["read", "write"]);
    expect(grant?.expiresAt).toBe(NOW + HOUR_MS);
    expect(grant?.budget).toBe(5);
    // The exact Layer 1 form, because that is what `isPathAllowed` compares
    // against. Asserting the stored value rather than "it changed": on a
    // case-sensitive POSIX host this input is already canonical, so a
    // difference test would be vacuous there and only bite on win32/darwin.
    expect(grant?.directories).toEqual([
      caseFoldForMatch(canonicalizePathForMatch(SCOPE_DIR)),
    ]);
  });

  it("canonicalizes the armed scope instead of storing what it was handed", () => {
    // A `..` segment is collapsed by `pathResolve` on every platform, so an
    // implementation that echoed the raw string fails this everywhere — which
    // the assertion above cannot claim on its own.
    const grant = parseAwayAuthorityGrant(
      makeArmInput({ directories: [`${SCOPE_DIR}/nested/..`] }),
      NOW,
    );

    expect(grant?.directories).toEqual([
      caseFoldForMatch(canonicalizePathForMatch(SCOPE_DIR)),
    ]);
    expect(grant?.directories[0]).not.toContain("..");
  });

  it("de-duplicates a repeated category rather than double-counting it", () => {
    const grant = parseAwayAuthorityGrant(
      makeArmInput({ categories: ["read", "read", "write"] }),
      NOW,
    );

    expect(grant?.categories).toEqual(["read", "write"]);
  });

  it("arms a read-only grant with no directory scope", () => {
    const grant = parseAwayAuthorityGrant(
      makeArmInput({ categories: ["read"], directories: [] }),
      NOW,
    );

    expect(grant).not.toBeNull();
    expect(grant?.directories).toEqual([]);
  });

  // Each row names a gesture the desk may not make. A category outside the
  // armable set is the security-critical one: `shell` and `network` are the two
  // that would turn an armed read into arbitrary execution or exfiltration.
  it.each<[string, Partial<AwayAuthorityArmInput>]>([
    ["shell is not armable", { categories: ["shell"] }],
    ["network is not armable", { categories: ["network"] }],
    ["meta is not armable", { categories: ["meta"] }],
    ["an unknown category is not armable", { categories: ["read", "nonsense"] }],
    ["no category at all", { categories: [] }],
    ["an empty conversation", { conversationId: "" }],
    ["a zero ttl", { ttlMs: 0 }],
    ["a negative ttl", { ttlMs: -1 }],
    ["a non-finite ttl", { ttlMs: Number.POSITIVE_INFINITY }],
    ["a ttl past the ceiling", { ttlMs: 4 * HOUR_MS + 1 }],
    ["a zero budget", { budget: 0 }],
    ["a fractional budget", { budget: 2.5 }],
    ["a budget past the ceiling", { budget: 51 }],
    ["a write grant with no directories", { categories: ["write"], directories: [] }],
    [
      "a sensitive directory the Layer 1 sanitizer drops",
      { directories: [SCOPE_DIR, SENSITIVE_DIR] },
    ],
    ["the filesystem root", { directories: ["/"] }],
  ])("refuses to arm: %s", (_name, overrides) => {
    expect(parseAwayAuthorityGrant(makeArmInput(overrides), NOW)).toBeNull();
  });

  it("arms the whole scope or none of it", () => {
    // The sensitive entry is dropped by the sanitizer, which would otherwise
    // leave a grant over the surviving subset — a scope the owner never agreed
    // to, silently narrower than the one they were shown.
    expect(
      parseAwayAuthorityGrant(
        makeArmInput({ directories: [SCOPE_DIR, SENSITIVE_DIR] }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseAwayAuthorityGrant(makeArmInput({ directories: [SCOPE_DIR] }), NOW),
    ).not.toBeNull();
  });

  it("bounds the ttl at the ceiling rather than just below it", () => {
    expect(
      parseAwayAuthorityGrant(makeArmInput({ ttlMs: 4 * HOUR_MS }), NOW),
    ).not.toBeNull();
    expect(
      parseAwayAuthorityGrant(makeArmInput({ ttlMs: 4 * HOUR_MS + 1 }), NOW),
    ).toBeNull();
  });
});

describe("AwayAuthority eligibility", () => {
  it("answers a paired-platform write inside the armed scope", () => {
    expect(armed().consume(makeCandidate(), NOW)).toEqual({
      answer: true,
      remaining: 4,
    });
  });

  it("answers a paired-platform read with no target path", () => {
    expect(
      armed().consume(
        makeCandidate({ toolCategory: "read", targetFilePath: undefined }),
        NOW,
      ),
    ).toMatchObject({ answer: true });
  });

  it("answers nothing at all before a desk gesture arms it", () => {
    // The in-memory default. A fresh process is a disarmed process; there is
    // no persisted grant for a restart to restore.
    const evaluation = new AwayAuthority().consume(makeCandidate(), NOW);

    expect(evaluation).toEqual({
      answer: false,
      refusal: "not-armed",
      reportable: false,
    });
    expect(new AwayAuthority().snapshot()).toBeNull();
  });

  // One row per eligibility condition. Every row is the eligible baseline with
  // exactly one field flipped, so a row that stops failing is a condition that
  // has stopped being load-bearing.
  it.each<[string, Partial<AwayAuthorityCandidate>, string]>([
    [
      "a Tailnet turn is not a paired-platform turn",
      { remoteControllerAuthority: TAILNET_AUTHORITY, remoteControllerOrigin: "tailnet-controller" },
      "not-platform-bridge",
    ],
    [
      "a desk turn carries no authority",
      { remoteControllerAuthority: undefined, remoteControllerOrigin: undefined },
      "not-platform-bridge",
    ],
    [
      "the audited marker must agree with the authority it was projected from",
      { remoteControllerOrigin: "tailnet-controller" },
      "not-platform-bridge",
    ],
    [
      "a missing marker would make the row read as desk-originated",
      { remoteControllerOrigin: undefined },
      "not-platform-bridge",
    ],
    [
      "the authority is re-checked at answer time",
      { remoteControllerAuthority: makePlatformBridgeAuthority(false) },
      "authority-not-current",
    ],
    [
      "another conversation is not the armed one",
      { sessionId: "conv-other" },
      "conversation-mismatch",
    ],
    [
      "an unattributed request matches no conversation",
      { sessionId: undefined },
      "conversation-mismatch",
    ],
    ["a plugin tool is not builtin", { source: "plugin" }, "not-builtin-source"],
    ["an MCP tool is not builtin", { source: "mcp" }, "not-builtin-source"],
    [
      "an absent source is not builtin",
      { source: undefined },
      "not-builtin-source",
    ],
    [
      "a directory-scope confirm would widen the grant's own bound",
      { kind: "out-of-allowed-dir" },
      "not-tool-request",
    ],
    [
      "a rationale card needs a human to read it",
      { kind: "rationale" },
      "not-tool-request",
    ],
    [
      "an agent-action kind is plugin-origin",
      { kind: "agent-action" },
      "not-tool-request",
    ],
    [
      "an agent-action category is plugin-origin",
      { category: "agent-action" },
      "not-tool-request",
    ],
    [
      "shell is never armable",
      { toolCategory: "shell", targetFilePath: undefined },
      "category-not-armed",
    ],
    [
      "network is never armable",
      { toolCategory: "network", targetFilePath: undefined },
      "category-not-armed",
    ],
    [
      "meta is never armable",
      { toolCategory: "meta", targetFilePath: undefined },
      "category-not-armed",
    ],
    [
      "an absent category cannot be matched against the armed set",
      { toolCategory: undefined },
      "category-not-armed",
    ],
    [
      "a durable choice set is not the one-shot contract",
      { allowedChoices: ["allow-once", "allow-always", "deny-once"] },
      "not-one-shot-contract",
    ],
    [
      "a session choice is not the one-shot contract",
      { allowedChoices: ["allow-once", "allow-session"] },
      "not-one-shot-contract",
    ],
    [
      "an unconstrained choice set is not the one-shot contract",
      { allowedChoices: undefined },
      "not-one-shot-contract",
    ],
    [
      "a durable record capability is refused even with one-shot choices",
      { durableApprovalRecordAllowed: true },
      "durable-record-allowed",
    ],
    [
      "a host-shell permit binding must never be minted by an away answer",
      { hostShellExecutionPermitBound: true },
      "host-shell-permit-bound",
    ],
    [
      "a write with no resolvable target has an uncheckable scope",
      { targetFilePath: undefined },
      "write-target-unresolved",
    ],
    [
      "a write outside the armed directories",
      { targetFilePath: OUT_OF_SCOPE_FILE },
      "target-out-of-scope",
    ],
    [
      "a write that traverses out of the armed directories",
      { targetFilePath: `${SCOPE_DIR}/../other-scope/notes.md` },
      "target-out-of-scope",
    ],
    [
      "a read outside the armed directories",
      { toolCategory: "read", targetFilePath: OUT_OF_SCOPE_FILE },
      "target-out-of-scope",
    ],
  ])("refuses %s", (_name, overrides, refusal) => {
    const evaluation = armed().consume(makeCandidate(overrides), NOW);

    expect(evaluation.answer).toBe(false);
    expect(evaluation).toMatchObject({ refusal });
  });

  it("refuses a category the desk did not arm, even though it is armable", () => {
    // Not "write is unarmable" — write is in the armable set. This is the grant
    // saying it covers reads only.
    const readOnly = armed({ categories: ["read"], directories: [SCOPE_DIR] });

    expect(readOnly.consume(makeCandidate({ toolCategory: "write" }), NOW))
      .toMatchObject({ refusal: "category-not-armed" });
    expect(readOnly.consume(makeCandidate({ toolCategory: "read" }), NOW))
      .toMatchObject({ answer: true });
  });

  it("reports refusals about an armed grant and stays quiet about the rest", () => {
    const authority = armed();

    // Nobody's business: an ordinary desk approval, and a Tailnet turn. If
    // these were reportable, every approval in the app would write a row.
    expect(
      authority.consume(
        makeCandidate({ remoteControllerAuthority: undefined, remoteControllerOrigin: undefined }),
        NOW,
      ),
    ).toMatchObject({ reportable: false });
    // This grant's business: it saw a paired-platform ask and declined it.
    expect(
      authority.consume(makeCandidate({ sessionId: "conv-other" }), NOW),
    ).toMatchObject({ reportable: true });
  });
});

describe("AwayAuthority lifecycle", () => {
  it("spends budget on an answer and not on a refusal", () => {
    const authority = armed({ budget: 3 });

    authority.consume(makeCandidate({ sessionId: "conv-other" }), NOW);
    expect(authority.snapshot()?.remaining).toBe(3);

    expect(authority.consume(makeCandidate(), NOW)).toMatchObject({ answer: true });
    expect(authority.snapshot()?.remaining).toBe(2);
  });

  it("retires itself the moment the budget runs out", () => {
    const authority = armed({ budget: 2 });

    expect(authority.consume(makeCandidate(), NOW)).toEqual({
      answer: true,
      remaining: 1,
    });
    // The answer that spends the last unit reports the exhaustion, because
    // after it there is no grant left to report anything.
    expect(authority.consume(makeCandidate(), NOW)).toEqual({
      answer: true,
      remaining: 0,
    });
    // Not "0 remaining and still armed": the grant is gone, so a later ask is
    // not this grant's business any more.
    expect(authority.snapshot()).toBeNull();
    expect(authority.consume(makeCandidate(), NOW)).toMatchObject({
      refusal: "not-armed",
    });
  });

  it("retires itself on expiry", () => {
    const authority = armed({ ttlMs: HOUR_MS });

    expect(authority.consume(makeCandidate(), NOW + HOUR_MS - 1)).toMatchObject({
      answer: true,
    });
    expect(authority.consume(makeCandidate(), NOW + HOUR_MS)).toMatchObject({
      refusal: "expired",
      reportable: true,
    });
    expect(authority.snapshot()).toBeNull();
  });

  it("retires everything on a share lifecycle change", () => {
    const authority = armed();

    expect(authority.retireAll()).toBe(true);
    expect(authority.snapshot()).toBeNull();
    // A re-pair mints a fresh, perfectly current authority. The per-call check
    // cannot tell it apart from the one the desk armed for; this is what does.
    expect(
      authority.consume(
        makeCandidate({ remoteControllerAuthority: makePlatformBridgeAuthority(true) }),
        NOW,
      ),
    ).toMatchObject({ refusal: "not-armed" });
    // Idempotent: a second lifecycle event has nothing left to retire.
    expect(authority.retireAll()).toBe(false);
  });

  it("replaces a previous grant rather than accumulating grants", () => {
    const authority = armed({ budget: 5 });
    authority.consume(makeCandidate(), NOW);
    expect(authority.snapshot()?.remaining).toBe(4);

    const replacement = parseAwayAuthorityGrant(
      makeArmInput({ categories: ["read"], directories: [], budget: 2 }),
      NOW,
    );
    if (replacement === null) throw new Error("test fixture produced an invalid grant");
    authority.arm(replacement);

    expect(authority.snapshot()?.remaining).toBe(2);
    expect(authority.snapshot()?.categories).toEqual(["read"]);
    expect(authority.consume(makeCandidate(), NOW)).toMatchObject({
      refusal: "category-not-armed",
    });
  });
});
