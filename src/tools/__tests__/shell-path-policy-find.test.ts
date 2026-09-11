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
    "find . 2>/dev/null -printf '%p\\n'",
    "find . -type f 2>/dev/null -printf '%p\\n'",
    "find . -printf > ./report '%p\\n'",
    "find . -printf 2>&1 '%p\\n'",
    "find . -printf >&- '%p\\n'",
    "find . -printf > 'report file' '%p\\n'",
    "find . -printf > report\\ file '%p\\n'",
    "find . -newer 2>/dev/null ./reference -printf '%p\\n'",
    "find . -printf '%p\\n' 2>/dev/null -name '*.txt'",
  ])("classifies actual argv with interleaved redirection: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.each([
    "find . -printf <&- '%p\\n'",
    "find . -printf 0<&- '%p\\n'",
    "find . -printf 3</dev/null <&3 '%p\\n'",
  ])("keeps descriptor redirection separate from read-only traversal: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.each([
    "find . -printf >&1/../../../../etc/shadow '%p\\n'",
    "find . -printf >&-/../../../../etc/shadow '%p\\n'",
    "find . -printf > /etc/shadow '%p\\n'",
    "find . -printf < /etc/shadow '%p\\n'",
    "find . -printf 3</etc/shadow <&3 '%p\\n'",
    "find . -newer > ./report /etc/shadow -printf '%p\\n'",
    "find . -newer 2>&1 /etc/shadow -printf '%p\\n'",
    "find . -printf > '/etc/shadow' '%p\\n'",
  ])("keeps interleaved redirect and reference targets checked: %s", (command) => {
    expect(check(command)?.kind).toBe("sensitive-path");
  });

  it.each([
    "find . -printf '%p\\n' >",
    "find . -printf '%p\\n' > > ./report",
    "find . -printf '%p\\n' < | cat",
  ])("does not exempt formats when redirection lacks an operand: %s", (command) => {
    expect(check(command)).not.toBeNull();
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
    "find . -unknown -printf '/etc/shadow'",
    "find . -name -printf '/etc/shadow'",
    "find . -printf '/etc/shadow' -newer",
  ])("does not guess unsupported or incomplete expression roles: %s", (command) => {
    expect(check(command)?.kind).toBe("sensitive-path");
  });
});
