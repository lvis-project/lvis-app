import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { findShellPathPolicyViolation } from "../../tools/shell-path-policy.js";
import { BashAstValidator } from "../bash-ast-validator.js";

it("keeps the original command subject to independent directory and file containment", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "eval-program-boundary-"));
  const allowed = join(fixture, "allowed");
  const other = join(fixture, "other");
  mkdirSync(allowed);
  mkdirSync(other);
  const input = join(other, "ordinary-input.txt");
  const output = join(other, "ordinary-output.txt");
  writeFileSync(input, "ordinary fixture data\n");
  const program = "python -c '# eval is program data\nprint(1)'";
  const validator = new BashAstValidator();
  const pathViolation = (command: string) => findShellPathPolicyViolation(command, allowed, allowed, [], true);
  try {
    // Only production policy functions receive these strings; none executes.
    const within = `cd '${allowed}' && ${program} 2>&1`;
    expect(validator.validate("bash", { command: within }).decision).toBe("allow");
    expect(pathViolation(within)).toBeNull();

    const outside = `cd '${other}' && ${program} 2>&1`;
    expect(validator.validate("bash", { command: outside }).decision).toBe("allow");
    expect(pathViolation(outside)).not.toBeNull();
    for (const command of [`${program} < '${input}'`, `${program} > '${output}'`]) {
      expect(validator.validate("bash", { command }).patternId).toBe("eval-untrusted");
      expect(pathViolation(command)).not.toBeNull();
    }
  } finally {
    await cleanupTmpDir(fixture);
  }
});
