import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

describe("shell path policy across logical lines", () => {
  const roots: string[] = [];
  const check = (command: string) => {
    const root = mkdtempSync(join(tmpdir(), "shell-logical-line-"));
    roots.push(root);
    return findShellPathPolicyViolation(command, root, root, [], false);
  };
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTmpDir(root);
  });

  it.each([
    'openssl req -x509 -newkey rsa:2048 \\\n -keyout ./server.key \\\n -out ./server.crt \\\n -subj "/CN=example.test" 2>&1',
    'sed \\\n -n "/^first/,/^last/p" ./input.txt',
    'printf \\\n "%s\\n" ./input.txt',
    'cat <<END\nfirst\\\nsecond\nEND\nprintf \\\n done',
    'cat <<END\nEN\\\nD\nprintf \\\n done',
  ])("preserves text operand roles: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.each([
    "ca\\\nt /etc/shadow",
    "printf value > \\\n /etc/shadow",
    "cat < /et\\\nc/shadow",
    'openssl req -subj "$\\\n(cat /etc/shadow)" -out ./cert.pem',
    'openssl req -subj "/CN=example.test" \\\n -out /etc/shadow',
    "cat <<END\nEND\ncat /et\\\nc/shadow",
    "cat <<END\nEN\\\nD\ncat /et\\\nc/shadow",
    "cat <<END\n$(cat /et\\\nc/shadow)\nEND",
  ])("retains sensitive-path checks: %s", (command) => {
    expect(check(command)?.kind).toBe("sensitive-path");
  });

  it("retains output containment", () => {
    expect(check('openssl req -subj "/CN=example.test" \\\n -out /not-authorized/cert.pem')?.kind).toBe("sandbox-boundary");
  });

  it.each([
    'cat <<E"ND"\nEND\ncat /et\\\nc/shadow',
    "cat <<\\END\nEND\ncat /et\\\nc/shadow",
    "(( 1 << 2 ))\ncat /et\\\nc/shadow",
  ])("refuses an unresolved heredoc boundary before granting path exemptions: %s", (command) => {
    expect(check(command)?.kind).toBe("invalid-path");
  });

  it.each(["cp \\\n -r ./source ./copy", "tar \\\n -xf ./archive.tar -C ./output"])(
    "retains recursive mutation restrictions: %s", (command) => {
      expect(check(command)?.kind).toBe("recursive-traversal");
    },
  );
});
