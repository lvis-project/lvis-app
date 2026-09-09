import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

describe("find expression operand roles", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lvis-find-operands-")); });
  afterEach(async () => { await cleanupTmpDir(root); });
  const check = (command: string) => findShellPathPolicyViolation(command, root, root, [], false);

  it("does not treat a file-information format as a path in a compound command", () => {
    expect(check(`printf ready; find '${root}' -type f -printf '%s\\t%p\\n' | sort -n`)).toBeNull();
  });

  it.each([
    `find . -name '/etc/shadow'`,
    `find . -path '/etc/shadow'`,
    `find . -regex '^.*/file\\.txt$'`,
    `find . -iname '$HOME/*.txt' -printf '%p\\n'`,
    `find . '(' -name '*.txt' -o -iname '*.log' ')' -printf '%p\\n'`,
    `find -L . -maxdepth 2 -type f -printf '%s\\t%p\\n'`,
    `find . -newermt '2026/01/01' -printf '%p\\n'`,
    `find . -name -printf -printf '%p\\n'`,
  ])("treats documented expression values as text: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.each([
    "find /etc/shadow -printf '%p\\n'",
    "find . -newer /etc/shadow -printf '%p\\n'",
    "find . -samefile /etc/shadow -printf '%p\\n'",
    "find . -newercc /etc/shadow -printf '%p\\n'",
    "find . -files0-from /etc/shadow -printf '%p\\n'",
    "find . -printf '%p\\n' < /etc/shadow",
    "find . > ./report -newer /etc/shadow",
    "find . -printf '%p\\n' > ./report -newer /etc/shadow",
    'find . -printf "$(cat /etc/shadow)"',
    'find . -name "$(cat /etc/shadow)" -print',
    'find . -printf <(cat /etc/shadow)',
  ])("continues checking actual paths and executable substitutions: %s", (command) => {
    expect(check(command)).not.toBeNull();
  });

  it("retains the output-file slot before an fprintf format in keyword-led leaves", () => {
    expect(check("if true; then find . -fprintf /etc/shadow '%p\\n'; fi")?.kind).toBe("sensitive-path");
  });

  it("keeps redirection targets separate from formats", () => {
    expect(check(`find . -printf '%p\\n' > '${root}/report'`)).toBeNull();
    expect(check("find . -printf '%p\\n' > /etc/shadow")).not.toBeNull();
  });

  it.each([
    "find . -fprintf /etc/shadow '%p\\n'",
    "find . -fprintf ./report '%p\\n'",
    "find . -fprint /etc/shadow",
    "find . -exec cat /etc/shadow ';'",
    "find . -execdir cat /etc/shadow '+'",
    "find . -delete",
  ])("preserves recursive mutation and execution refusal: %s", (command) => {
    expect(check(command)?.kind).toBe("recursive-traversal");
  });

  it.each([
    "find . -unknown -printf '%p\\n'",
    "find . -name -printf '%p\\n'",
    "find . -printf '%p\\n' -newer",
  ])("does not guess unsupported or incomplete expression roles: %s", (command) => {
    expect(check(command)).not.toBeNull();
  });
});
