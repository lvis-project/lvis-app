/**
 * Two shapes classified `shell` — and so prompted — while the same operation
 * spelled slightly differently classified `read`. Neither was a containment
 * gap; both were the classifier failing to model a spelling, and an
 * inconsistent prompt teaches people that the prompt is noise.
 *
 * 1. `git log -Sneedle` prompted while `git log -S needle` did not. The short-
 *    flag cluster scan stopped at the first NON-LETTER, which ends `-U5` and
 *    `-M50%` but not an alphabetic value: the cluster read as `Sneedle`, and
 *    `d` is not an allow-listed letter.
 *
 * 2. `rg 'foo$'` prompted while `grep 'foo$' f` did not, purely because `rg`
 *    has a MUTATING_FLAGS entry and `grep` does not. The dollar guard fired on
 *    the CHARACTER `$`. It exists because expansion happens after tokenizing,
 *    so `sed $IFS-i f` can split into a `-i` the flag scan never saw — but
 *    inside `'...'` there is no expansion, so a regex anchor is not that.
 *
 * The security cases those rules exist for are asserted alongside, because a
 * widening that quietly takes them with it is the failure that matters here.
 */
import { describe, expect, it } from "vitest";

import { inspectHostRisk } from "../host-risk-inspector.js";

function categoryOf(command: string) {
  return inspectHostRisk({ source: "builtin", finalInput: { command } });
}

describe("git short flags with a glued value", () => {
  it.each([
    ["git log -Sneedle", "pickaxe search, value glued"],
    ["git log -S needle", "the same search, value separated"],
    ["git log -Gregex", "diff-content search"],
    ["git log -L10,20:file.ts", "line-range log"],
    ["git log -n5", "max count"],
    ["git diff -U5", "context lines — digits already ended the cluster"],
  ])("%s reads (%s)", (command) => {
    expect(categoryOf(command)).toBe("read");
  });

  it("still escalates an unknown flag letter", () => {
    // The value-taking rule decides where a flag ENDS. It must not decide that
    // the flag is allowed: `-X` is not in the read-only letter set.
    expect(categoryOf("git log -Xbogus")).toBe("shell");
  });

  it("still escalates a writing form of a read-only subcommand", () => {
    expect(categoryOf("git log --output=/tmp/x")).toBe("shell");
  });

  it("still escalates a mutating subcommand", () => {
    expect(categoryOf("git commit -m x")).toBe("shell");
  });
});

describe("dollar in an argument", () => {
  it.each([
    ["rg 'foo$'", "regex anchor, single-quoted"],
    ["rg 'a$' src", "same, with a path operand"],
    ["grep 'foo$' file.txt", "the verb that always allowed it"],
  ])("%s reads (%s)", (command) => {
    expect(categoryOf(command)).toBe("read");
  });

  it.each([
    ["sed $IFS-i f", "word-splits into -i after expansion"],
    ["rg $IFS--pre=evil p", "word-splits into --pre, which runs a program"],
  ])("%s stays shell (%s)", (command) => {
    expect(categoryOf(command)).toBe("shell");
  });

  it("keeps a double-quoted expansion out of read", () => {
    // Double quotes suppress word splitting but NOT expansion, and the expanded
    // value can be a flag in its entirety. Only single quotes prove the `$` is
    // literal, so only they earn the exemption.
    expect(categoryOf('rg "$FLAG" p')).toBe("shell");
  });

  it("keeps a command substitution out of read regardless of quoting", () => {
    expect(categoryOf("rg $(cat /tmp/p) f")).toBe("shell");
  });
});
