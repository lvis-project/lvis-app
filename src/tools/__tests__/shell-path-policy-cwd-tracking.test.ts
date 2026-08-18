/**
 * A relative operand is only meaningful together with the directory it
 * resolves against, and `cd` changes that directory partway through a command.
 *
 * The policy used to resolve every operand against the session cwd, so
 * `cd /tmp && cat ../../etc/passwd` read as `<session cwd>/../../etc/passwd` —
 * inside the boundary — while the shell, standing in `/tmp`, read
 * `/etc/passwd`. The `cd` target itself was checked, which is why the escape
 * needed a directory that was ALLOWED but shallower than the session cwd; from
 * there `..` reaches places the static resolution never looks at.
 *
 * The fix walks leaves in order using the shared tokenizer SOT — the same
 * splitting the risk classifier uses — and resolves each leaf's operands
 * against the directory in effect for that leaf.
 */
import { describe, expect, it } from "vitest";

import { findShellPathPolicyViolation } from "../shell-path-policy.js";

// A session cwd deliberately DEEPER than the extra allowed directory, which is
// the shape the escape needs: `..` from the shallow one climbs out, `..` from
// the deep one does not.
const ROOT = "/private/tmp/lvis-cwd-tracking";
const CWD = `${ROOT}/src/deep/nested`;
const EXTRAS = ["/tmp"];

function check(command: string) {
  return findShellPathPolicyViolation(command, CWD, ROOT, EXTRAS);
}

describe("shell path policy — working directory tracking", () => {
  it("blocks climbing out of a shallow allowed directory reached by cd", () => {
    const violation = check("cd /tmp && cat ../../etc/passwd");
    expect(violation).not.toBeNull();
    expect(violation!.kind).toBe("sandbox-boundary");
  });

  it.each([
    ["cd /tmp && cat ../etc/passwd", "one level up"],
    ["cd /tmp; cat ./x/../../etc/passwd", "climb hidden mid-path"],
    ["cd /tmp && head -1 ../../../etc/shadow", "a sensitive file above"],
  ])("blocks %s (%s)", (command) => {
    expect(check(command)).not.toBeNull();
  });

  it("still resolves against the session cwd when no cd is present", () => {
    // The historical behaviour, unchanged: this is the check that was always
    // here, and it must keep catching what it caught.
    expect(check("cat ../../../../../etc/passwd")).not.toBeNull();
  });

  it.each([
    ["cd /tmp && cat notes.txt"],
    ["cd .. && ls"],
    ["cd /tmp"],
    ["ls -la"],
    ["cat notes.txt"],
  ])("allows %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it("resolves a later operand against the directory cd moved to, not the session cwd", () => {
    // `../notes.txt` from `<cwd>/sub` is `<cwd>/notes.txt`. Both readings stay
    // inside the boundary here — the point is that the walk uses the moved-to
    // directory, which the escape cases above prove by being caught.
    expect(check("cd sub && cat ../notes.txt")).toBeNull();
  });

  describe("a cd whose destination argv does not decide", () => {
    it.each([
      ["cd $DIR && cat foo", "an unexpanded variable"],
      ["cd - && cat foo", "OLDPWD"],
    ])("stops the command: %s (%s)", (command) => {
      const violation = check(command);
      expect(violation).not.toBeNull();
      expect(violation!.kind).toBe("dynamic-path");
    });

    it("says what to do instead", () => {
      // The message is shown to the user, so it has to name a way forward.
      expect(check("cd $DIR && cat foo")!.reason).toMatch(/absolute path|working directory/i);
    });

    it("treats a bare cd as decidable — it goes home, which is then checked", () => {
      // Home is outside the sandbox root, so this is a boundary violation
      // rather than an indeterminate one. Distinguishing them matters: only the
      // indeterminate case is unanalysable.
      //
      // This one needs the RESOLVED destination to be checked: a bare `cd` has
      // no operand to check, and `foo` is not a path candidate, so an
      // operand-only walk let the whole thing through.
      const violation = check("cd && cat foo");
      expect(violation).not.toBeNull();
      expect(violation!.kind).toBe("sandbox-boundary");
    });

    it("does not mistake -L/-P for the destination", () => {
      expect(check("cd -P /tmp && cat notes.txt")).toBeNull();
    });
  });
});
