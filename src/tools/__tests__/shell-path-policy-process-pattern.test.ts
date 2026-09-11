import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
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
    'pgrep -f "<(literal pattern)"',
    'kill ">(literal process name)"',
    'pgrep -f "$(printf \')\')"',
    'pgrep -f "$(printf \'<<INNER )\')"',
    'pgrep -f "$(printf \'<<<\')"',
    'pgrep -f "$(printf "<<INNER )")"',
    'pgrep -f "$(printf \\<\\<INNER)"',
    "pgrep -f '$(literal pattern)'",
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

  it.each([
    'echo "sum=$((1+2))"',
    'n=3; echo "sum=$((n + 2))"',
    'echo "${VALUE:-fallback}"',
  ])("keeps existing arithmetic and variable expansion outside new process-data exemptions: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.each([
    "printf okay # example $(unfinished",
    "printf okay # example `unfinished",
    "printf okay # example $(unfinished\nprintf later",
  ])("ignores substitution markers in actual shell comments: %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("matches actual shell argv for input descriptor closing and forwarding", () => {
    const fixture = mkdtempSync(join(tmpdir(), "input-descriptor-policy-"));
    roots.push(fixture);
    const source = join(fixture, "stdin.txt");
    writeFileSync(source, "available\n");
    for (const [redirect, state] of [["<&-", "closed"], ["3<&0 <&3", "open:available"]]) {
      const command = `capture() { printf '%s\\0' "$@"; if IFS= read -r value 2>/dev/null; then printf 'open:%s\\0' "$value"; else printf 'closed\\0'; fi; }; capture find . -printf ${redirect} '%p\\n'`;
      // A file keeps data available without racing a write to a closed pipe.
      const input = openSync(source, "r");
      try {
        const output = execFileSync("/bin/sh", ["-c", command], { stdio: [input, "pipe", "pipe"], encoding: "utf8" });
        expect(output.split("\0").slice(0, -1)).toEqual(["find", ".", "-printf", "%p\\n", state]);
      } finally {
        closeSync(input);
      }
    }
  });

  it("retains dynamic file operands for commands that open them", () => {
    expect(check('cat $(printf ./input)')).not.toBeNull();
  });

  it.each(["pgrep -f", "kill"])("does not exempt executable process substitutions: %s", (head) => {
    const fixture = mkdtempSync(join(tmpdir(), "process-substitution-policy-"));
    roots.push(fixture);
    const allowed = join(fixture, "allowed");
    const other = join(fixture, "other");
    mkdirSync(allowed);
    mkdirSync(other);
    const source = join(other, "ordinary.txt");
    writeFileSync(source, "fixture");
    for (const operator of ["<", ">"]) {
      const command = `${head} ${operator}(cat '${source}')`;
      expect(findShellPathPolicyViolation(command, allowed, allowed, [], true)?.kind).toBe("dynamic-path");
    }
    expect(findShellPathPolicyViolation(`${head} $(cat '${source}')`, allowed, allowed, [], true)).not.toBeNull();
  });

  it.each(["pgrep -f", "kill"])("inspects the complete quoted command-substitution body: %s", (head) => {
    const fixture = mkdtempSync(join(tmpdir(), "substitution-boundary-policy-"));
    roots.push(fixture);
    const allowed = join(fixture, "allowed");
    const other = join(fixture, "other");
    mkdirSync(allowed);
    mkdirSync(other);
    const source = join(other, "ordinary.txt");
    writeFileSync(source, "fixture");
    for (const body of [
      `printf ')'; cat '${source}'`,
      `printf x # )\ncat '${source}'`,
    ]) {
      expect(findShellPathPolicyViolation(`${head} "$(${body})"`, allowed, allowed, [], true)?.kind)
        .toBe("sandbox-boundary");
    }
    for (const body of [
      `printf $((1 + 1)); cat '${source}'`,
      `printf "\${VALUE:-')}"; cat '${source}'`,
      `printf <(cat '${source}')`,
      `printf $'value'; cat '${source}'`,
    ]) {
      expect(findShellPathPolicyViolation(`${head} "$(${body})"`, allowed, allowed, [], true)).not.toBeNull();
    }
    for (const body of [
      `cat <<'INNER'\n)\nINNER\ncat '${source}'`,
      `cat <<INNER\n)\nINNER\ncat '${source}'`,
      `cat <<-INNER\n\t)\n\tINNER\ncat '${source}'`,
      `cat <<< ')'; cat '${source}'`,
    ]) {
      expect(findShellPathPolicyViolation(`${head} "$(${body})"`, allowed, allowed, [], true)?.kind)
        .toBe("dynamic-path");
    }
    for (const command of [
      `printf okay # example $(unfinished\nprintf "$(cat '${source}')"`,
      `printf '%s' word\\ #$(cat '${source}')`,
      `printf "#$(cat '${source}')"`,
      `printf ''#$(cat '${source}')`,
    ]) {
      expect(findShellPathPolicyViolation(command, allowed, allowed, [], true)?.kind).toBe("sandbox-boundary");
    }
    expect(findShellPathPolicyViolation(`${head} "$(printf missing`, allowed, allowed, [], true)).not.toBeNull();
  });

  it("refuses nested execution beyond the inspection depth", () => {
    let command = "cat /etc/shadow";
    for (let i = 0; i < 8; i += 1) command = `kill $(${command})`;
    expect(check(command)?.kind).toBe("dynamic-path");
  });
});
