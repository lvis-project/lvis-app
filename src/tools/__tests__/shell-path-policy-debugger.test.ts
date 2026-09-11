import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { isReadOnlyCommand } from "../../permissions/reviewer/host-risk-inspector.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

describe("debugger command operand roles", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lvis-debugger-operands-")); });
  afterEach(async () => { await cleanupTmpDir(root); });

  it.each([
    "gdb -ex /etc/shadow ./program",
    "gdb -q -batch -ex 'x/4xw $sp' ./program",
    "gdb -ex 'x/-3uh 0x54320' ./program",
    "gdb -ex 'print/x $pc' ./program",
    "gdb -eval-command 'x/8i $pc-12' ./program",
    "gdb --eval-command='x/2gx $sp' ./program",
    "gdb -iex 'set $limit = 4' ./program",
    "gdb --init-eval-command='set $limit = 4' ./program",
    "gdb -eiex 'set data-directory /usr/share/debugger' ./program",
    "gdb --early-init-eval-command='set data-directory /usr/share/debugger' ./program",
    "gdb -ex 'x/4xw $sp' ./program > ./report",
  ])("classifies documented command values as program text: %s", (command) => {
    expect(findShellPathPolicyViolation(command, root, root, [], false)).toBeNull();
    expect(isReadOnlyCommand(command)).toBe(false);
  });

  it.each([
    "gdb -x /etc/shadow ./program",
    "gdb --command=/etc/shadow ./program",
    "gdb -ix /etc/shadow ./program",
    "gdb --early-init-command=/etc/shadow ./program",
    "gdb --exec=/etc/shadow -ex 'x/4xw $sp'",
    "gdb --symbols=/etc/shadow -ex 'x/4xw $sp'",
    "gdb --core=/etc/shadow -ex 'x/4xw $sp'",
    "gdb --directory=/etc/shadow -ex 'x/4xw $sp'",
    "gdb -ex 'x/4xw $sp' /etc/shadow",
    "gdb -ex 'x/4xw $sp' ./program > /etc/shadow",
    'gdb -ex "$(cat /etc/shadow)" ./program',
  ])("continues checking files, redirects and shell substitutions: %s", (command) => {
    expect(findShellPathPolicyViolation(command, root, root, [], false)?.kind).toBe("sensitive-path");
  });

  it.each(["--args", "-args", "--arg", "--no-escape-args", "-no-escape-args", "--no-escape-a", "--"])(
    "does not apply debugger option roles to forwarded arguments after %s", (separator) => {
      expect(findShellPathPolicyViolation(`gdb ${separator} ./program -ex "$UNRESOLVED_INPUT/file"`, root, root, [], false)).not.toBeNull();
    },
  );

  it.each(["-x", "--command", "--comm", "-ix", "--init-command", "-eix", "--early-init-command", "--eval", "--init-eval-comm", "--tt"])(
    "consumes the file operand before reading later options: %s", (option) => {
      expect(findShellPathPolicyViolation(`gdb ${option} -ex "$UNRESOLVED_INPUT/file"`, root, root, [], false)).not.toBeNull();
    },
  );
});
