import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

describe("heredoc data path policy", () => {
  const roots: string[] = [];
  const check = (command: string) => {
    const root = mkdtempSync(join(tmpdir(), "heredoc-data-policy-"));
    roots.push(root);
    return findShellPathPolicyViolation(command, root, root, [], false);
  };
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTmpDir(root);
  });

  it.each([
    "cat > ./commands.vim <<END\n:%s/^first$/last/\nwq\nEND",
    "cat > ./text <<END\n'path/to/data' # text\nEND\nprintf done",
    "cat > ./text <<END\nnot shell syntax: ' and /\nEN\\\nD",
    "cat > ./text <<END\n\\$(cat /etc/shadow)\nEND",
  ])("accepts expansion-free stdin data inside the allowed scope: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.each([
    "cat <<END\nprintf '$(cat /etc/shadow)'\nEND",
    "cat <<END\nprintf '$(cat /etc/shadow)'",
    "cat <<$END\nprintf '$(cat /etc/shadow)'\n$END",
    "cat <<END\r\nEND\nprintf '$(cat /etc/shadow)'\nEND\r",
    "cat <<END\nprintf '$(cat /et\\\nc/shadow)'\nEND",
    "cat <<END\n# $(cat /etc/shadow)\nEND",
    "cat <<END\n'$(cat /etc/shadow)'\nEND",
    "cat <<END\nprintf '`cat /etc/shadow`'\nEND",
    "cat <<END\n'$(printf \\); cat /etc/shadow)'\nEND",
    "cat <<END\n'$(printf ')'; cat /etc/shadow)'\nEND",
    "cat <<END\ntext\nEN\\\nD\ncat /et\\\nc/shadow",
    "cat > /etc/shadow <<END\ntext/path\nEND",
    "cat < /etc/shadow <<END\ntext/path\nEND",
    "sh <<END\ncat /etc/shadow\nEND",
    "command bash <<END\ncat /etc/shadow\nEND",
    "cat <<END | sh\ncat /etc/shadow\nEND",
    "cat <<END; sh\ncat /etc/shadow\nEND",
  ])("inspects real expansions and redirections: %s", (command) => {
    expect(check(command)?.kind).toBe("sensitive-path");
  });

  it("does not skip executable bodies beyond the recursion bound", () => {
    let nested = "cat /etc/shadow";
    for (let i = 0; i < 8; i += 1) nested = `printf "$(${nested})"`;
    expect(check(`cat <<END\n'${nested}'\nEND`)?.kind).toBe("dynamic-path");
  });

  it.each(["|", "||", "&&", ";", "&"])("retains the body when a control operator leaves the header incomplete: %s", (operator) => {
    expect(check(`cat <<END ${operator}\ncat /etc/shadow\nEND\nsh`)).not.toBeNull();
  });

  it.each([["{", "}"], ["(", ")"]])("retains bodies whose enclosing group can feed an execution consumer: %s", (open, close) => {
    expect(check(`${open}\ncat <<END\ncat /etc/shadow\nEND\n${close} | sh`)).not.toBeNull();
  });

  it.each([
    "cat <<END\nprintf '$(printf x # )\ncat /etc/shadow\n)'\nEND",
    "cat <<END\nprintf '$(case x in x) cat /etc/shadow;; esac)'\nEND",
    "cat <<END\nprintf '$(printf `printf ')'`; cat /etc/shadow)'\nEND",
  ])("does not grant a path exemption to unresolved nested syntax: %s", (command) => {
    expect(check(command)).not.toBeNull();
  });

  it("refuses a delimiter word whose syntax cannot be inspected", () => {
    expect(check("cat <<$(printf END)\nprintf '$(cat /etc/shadow)'\n$(printf END)")).not.toBeNull();
  });

  it("retains outside writes after a here-string or literal delimiter text", () => {
    const fixture = mkdtempSync(join(tmpdir(), "here-string-policy-"));
    roots.push(fixture);
    const allowed = join(fixture, "allowed");
    const other = join(fixture, "other");
    mkdirSync(allowed);
    mkdirSync(other);
    const output = join(other, "ordinary-output.txt");
    writeFileSync(output, "fixture");
    for (const header of ["cat <<< END", "cat <<< 'END'", "printf '<<< END'", "printf \\<\\<\\< END"]) {
      const command = `${header}\nprintf harmless > '${output}'\nEND`;
      expect(findShellPathPolicyViolation(command, allowed, allowed, [], false)?.kind).toBe("sandbox-boundary");
    }
  });
});
