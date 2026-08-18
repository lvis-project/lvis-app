/**
 * A push that updates no ref was refused as a parse error.
 *
 * `readPrePushInput` returned a bare string, so "git sent an empty list" and
 * "we could not read git's list" were the same value. The parser then treated
 * an empty list as incomplete, and the caller refuses an incomplete parse —
 * correctly, since nothing is known about the push.
 *
 * Both readings cannot be right. Refusing an unreadable input is the fail-
 * closed behaviour to keep; refusing a genuine no-op push is not, and it
 * surfaces as a failed push even though the branch is already on the remote at
 * the right commit — a confusing way to learn there was nothing to do.
 */
import { describe, expect, it } from "vitest";

import { parsePrePushUpdates } from "../../scripts/hooks/pre-push-ref-updates.mjs";

const ZERO = "0".repeat(40);
const SHA = "5e544ff8f30aa915be9e0d9e66db564cf1e192f4";
const UPDATE = `refs/heads/topic ${SHA} refs/heads/topic ${ZERO}`;

describe("pre-push ref updates", () => {
  it("accepts a push that updates no ref", () => {
    // git had nothing to send. A push that changes no ref cannot violate a
    // branch policy, so there is nothing for the caller to refuse.
    const result = parsePrePushUpdates({ readable: true, text: "" });
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([]);
  });

  it("refuses an input it could not read", () => {
    // Same empty text, opposite verdict — this is the distinction the single
    // string could not carry.
    expect(parsePrePushUpdates({ readable: false, text: "" }).complete).toBe(false);
  });

  it("parses a real update", () => {
    const result = parsePrePushUpdates({ readable: true, text: UPDATE });
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([
      { localRef: "refs/heads/topic", localSha: SHA, remoteRef: "refs/heads/topic", remoteSha: ZERO },
    ]);
  });

  it("parses several updates and ignores blank lines", () => {
    const result = parsePrePushUpdates({ readable: true, text: `${UPDATE}\n\n${UPDATE}\n` });
    expect(result.complete).toBe(true);
    expect(result.updates).toHaveLength(2);
  });

  it.each([
    ["refs/heads/topic " + SHA + " refs/heads/topic", "too few fields"],
    ["refs/heads/topic " + SHA + " refs/heads/topic " + ZERO + " extra", "too many fields"],
    ["refs/heads/topic nothex refs/heads/topic " + ZERO, "a non-hex object id"],
    ["refs/heads/topic " + SHA.slice(0, 20) + " refs/heads/topic " + ZERO, "a truncated object id"],
  ])("refuses a line with %s (%s)", (line) => {
    // One unreadable line makes the whole set unusable: the caller cannot
    // enforce a branch policy against a list it only partly understands.
    expect(parsePrePushUpdates({ readable: true, text: line }).complete).toBe(false);
  });

  it("refuses the whole set when one line of several is malformed", () => {
    const result = parsePrePushUpdates({ readable: true, text: `${UPDATE}\ngarbage line here` });
    expect(result.complete).toBe(false);
  });

  it("accepts sha256 object ids", () => {
    const sha256 = "a".repeat(64);
    const line = `refs/heads/topic ${sha256} refs/heads/topic ${"0".repeat(64)}`;
    expect(parsePrePushUpdates({ readable: true, text: line }).complete).toBe(true);
  });
});
