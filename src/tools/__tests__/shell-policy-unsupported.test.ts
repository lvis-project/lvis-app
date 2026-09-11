import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

describe("explicit shell authority limits", () => {
  const roots: string[] = [];
  const check = (command: string) => {
    const root = mkdtempSync(join(tmpdir(), "shell-unsupported-"));
    roots.push(root);
    return findShellPathPolicyViolation(command, root, root, [], false);
  };
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTmpDir(root);
  });

  it.each([
    "(( 1 << 2 ))\ncat /et\\\nc/shadow",
    'kill 123 > /etc/shadow "',
    "cat <<END\nprintf '$(cat /etc/shadow)'",
    "cat <<$END\nprintf '$(cat /etc/shadow)'\n$END",
  ])("declines unsupported or incomplete syntax without partial path authority: %s", (command) => {
    expect(check(command)?.kind).toBe("dynamic-path");
  });

  it("declines an opaque pipe program at its actual execution consumer", () => {
    const violation = check("cat <<END | sh\ncat /etc/shadow\nEND");
    expect(violation?.kind).toBe("dynamic-path");
    expect(violation?.reason).toContain("unresolved shell program from a pipe");
  });

  it("keeps a prior command's stdin separate from a later shell", () => {
    expect(check("cat <<END; sh\ncat /etc/shadow\nEND")).toBeNull();
  });
});
