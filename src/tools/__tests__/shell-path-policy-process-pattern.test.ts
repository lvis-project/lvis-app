import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { isReadOnlyCommand } from "../../permissions/reviewer/host-risk-inspector.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

describe("process-selection pattern operands", () => {
  const roots: string[] = [];
  const check = (command: string, blockReadsOutsideWorkingDirectories = false) => {
    const root = mkdtempSync(join(tmpdir(), "process-pattern-policy-"));
    roots.push(root);
    return findShellPathPolicyViolation(command, root, root, [], blockReadsOutsideWorkingDirectories);
  };
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTmpDir(root);
  });

  it.each([
    'pgrep -f "^/fixture/worker$"',
    'kill $(pgrep -f "^/fixture/worker$")',
    'pgrep -af "^/fixture/worker$"',
    'pgrep --full -- "^/fixture/worker$"',
    'pgrep -u 1000 -f "^/fixture/worker$"',
    'pgrep -d "\\n" -F ./worker.pid "^/fixture/worker$"',
    'pgrep -fF./worker.pid "^/fixture/worker$"',
    'pgrep --pidfile=./worker.pid "^/fixture/worker$"',
    'pgrep -F > ./output ./worker.pid "^/fixture/worker$"',
    'pgrep -f <&- "^/fixture/worker$"',
    'pgrep -f 0<&3 "^/fixture/worker$"',
    'kill -TERM $(pgrep -f "^/fixture/worker$") > ./output',
    'kill --signal TERM -- $(pgrep --full "^/fixture/worker$")',
  ])("does not treat the regex as a filesystem operand: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.each([
    'pgrep -F /etc/shadow "worker"',
    'pgrep -fF/etc/shadow "worker"',
    'pgrep --pidfile=/etc/shadow "worker"',
    'pgrep --pidf /etc/shadow "worker"',
    'pgrep --unknown /etc/shadow "worker"',
    'pgrep -f "$(cat /etc/shadow)"',
    'pgrep -f "worker" > /etc/shadow',
    'pgrep -f "worker" < /etc/shadow',
    'kill $(cat /etc/shadow)',
    'kill $(pgrep -F /etc/shadow "worker")',
    'kill $(pgrep -f "$(cat /etc/shadow)")',
    'kill 123 > /etc/shadow',
    'kill 123 < /etc/shadow',
    'kill 123 > /etc/shadow "',
  ])("retains file and expansion checks: %s", (command) => {
    expect(check(command)?.kind).toBe("sensitive-path");
  });

  it.each([
    'pgrep -F /not-authorized/pids "worker"',
    'pgrep -f "worker" > /not-authorized/output',
    'kill $(pgrep -f "worker") > /not-authorized/output',
  ])("retains containment: %s", (command) => {
    expect(check(command, true)?.kind).toBe("sandbox-boundary");
  });

  it("does not make process mutation read-only", () => {
    expect(isReadOnlyCommand('kill $(pgrep -f "worker")')).toBe(false);
  });

  it("retains dynamic file operands for commands that open them", () => {
    expect(check('cat $(printf ./input)')).not.toBeNull();
  });

  it("refuses nested execution beyond the inspection depth", () => {
    let command = "cat /etc/shadow";
    for (let i = 0; i < 8; i += 1) command = `kill $(${command})`;
    expect(check(command)?.kind).toBe("dynamic-path");
  });
});
