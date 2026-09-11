import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { isReadOnlyCommand } from "../../permissions/reviewer/host-risk-inspector.js";
import { BashAstValidator } from "../bash-ast-validator.js";

const validator = new BashAstValidator();
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "shell-structural-"));
  for (const name of ["work", "work directory", "eval location"]) mkdirSync(join(cwd, name));
});
afterEach(async () => { await cleanupTmpDir(cwd); });
const validate = (command: string) => validator.validate("bash", { command }, {
  cwd, facts: { dialect: "bash", environment: { HOME: cwd, PWD: cwd, PATH: "/usr/bin:/bin" } },
});

describe("literal program data in complete statement scopes", () => {
  it.each([
    "python -c '# eval marker\nprint(1)'",
    "python -c \"# eval marker\nprint(1)\"",
    "python -c \"print('eval marker')\"",
    "python2 -c '# document an eval example\nprint(1)'",
    "/usr/bin/python3 -c 'message = \"an eval example\"; print(message)'",
    "python3 -c 'print(\"$LITERAL\") # eval example'",
    "python3 -c 'print(eval(\"1\")) # eval is language program text'",
    "cd work && python -c '# explain eval behavior\nprint(1)' 2>&1",
    "cd -- 'work directory'; python3 -c 'print(\"eval example\")' 12>&3",
    "python2 -c '# eval note\nprint(1)' || printf retry",
    "printf before; python3 -c '# eval note\nprint(1)'; printf after",
    "cd work &&\n# comment before the program\npython -c '# eval note\nprint(1)' 2>&1\n",
    "python -c 'print(\"eval ; | & && || ( ) $LITERAL\")' 1>&-",
    "cd work && py\\\nthon -c '# eval note\nprint(1)' 2>&1"
  ])("preserves literal data without assigning shell execution: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("allow");
  });

  it.each([
    "eval 'printf 1'",
    "python -c '# eval marker\nprint(1)'; eval 'printf 1'",
    "sh -c 'eval printf 1'",
    "command sh -c 'eval printf 1'",
    "env NAME=value bash -c 'eval printf 1'",
    "python -c \"# eval marker\nprint('$(eval printf 1)')\"",
    "python -c '# eval marker\nprint(1)' <(eval printf 1)",
    "cd work && python -c '# eval note\nprint(1)' && e\"\"val 'printf 1'"
  ])("refuses actual nested or subsequent eval execution: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("eval-untrusted");
  });

  it.each([
    "python -c '# eval marker\nprint(1)' | sh"
  ])("refuses a pipe whose shell program is unknown: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("subst-pipe-shell");
  });

  it.each([
    "$RUNNER -c '# eval marker\nprint(1)'",
    "python -c '# eval marker\nprint(1)' |",
    "python -c '# eval marker\nprint(1)",
    "cd work && python -c '# eval note\nprint(1)' 2>&1 &&",
    "cd work && python -c '# eval note\nprint(1)' 2>&1 ||\n# pending command",
    "&& python -c '# eval note\nprint(1)'",
    "cd work; && python -c '# eval note\nprint(1)'",
    "cd work && python -c '# eval note\nprint(1)' 2>&$FD",
    "cd work && python -c '# eval note\nprint(1)' && $RUNNER"
  ])("refuses missing command values or incomplete syntax: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("shell-analysis");
  });

  it.each([
    "bash -c 'python -c \"# eval marker\nprint(1)\"'",
    "python -c '# eval marker\nprint(1)' | unknown_consumer",
    "unknown_consumer -c '# eval marker\nprint(1)'",
    "python -c '# eval marker\nprint(1)' extra",
    "python --unknown -c '# eval marker\nprint(1)'",
    "python -m wrapper 'eval marker'",
    "NAME=value python -c '# eval marker\nprint(1)'",
    "env NAME=value python -c '# eval marker\nprint(1)'",
    "timeout 1s python -c '# eval marker\nprint(1)'",
    "python -c '# eval marker\nprint(1)' < input.txt",
    "python -c '# eval marker\nprint(1)' > output.txt",
    "python -c '# eval marker\nprint(1)' &",
    "( python -c '# eval marker\nprint(1)' )",
    "{ python -c '# eval marker\nprint(1)'; }",
    "python -c '# eval marker\nprint(1)' > script; sh script",
    "cd work && python -c '# eval note\nprint(1)' && sh -c 'printf 1'",
    "cd work && python -c '# eval note\nprint(1)' && unknown_consumer",
    "unknown_consumer; python -c '# eval note\nprint(1)'",
    "cd work && python -c '# eval note\nprint(1)' > output.txt",
    "cd work > output.txt && python -c '# eval note\nprint(1)'",
    "cd work && python -c '# eval note\nprint(1)' >&1report",
    "cd work && python -c '# eval note\nprint(1)' <&0",
    "cd work && command python -c '# eval note\nprint(1)' 2>&1",
    "cd work && python -c '# eval note\nprint(1)' && env NAME=value printf done",
    "cd work && python -c '# eval note\nprint(1)' && printf \"$(printf done)\"",
    "cd work && python -c '# eval note\nprint(1)' && printf '%s' <(printf done)",
    "cd work && python -c '# eval note\nprint(1)' && printf -v destination '%s' value",
    "cd 'eval location' && python -c '# eval note\nprint(1)'"
  ])("preserves literal program data through scopes and wrappers: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("allow");
  });

  it.skipIf(process.platform === "win32")("preserves native program argument bytes through a wrapper and cwd change", () => {
    const receiver = join(cwd, "argument-receiver");
    writeFileSync(receiver, "#!/bin/bash\nprintf '%s' \"$2\"\n", { mode: 0o700 });
    const command = "cd work && env NAME=value " + shellQuote(receiver) + " -c '# eval marker\nprint(1)'";
    expect(validate(command).decision).toBe("allow");
    expect(isReadOnlyCommand(command)).toBe(false);
    expect(execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd, encoding: "utf8", timeout: 3000 })).toBe("# eval marker\nprint(1)");
  });

  it("distinguishes literal examples from actual privilege commands", () => {
    expect(validate("python -c 'print(\"eval marker\"); # sudo example'").decision).toBe("allow");
    expect(validate("sudo printf example").patternId).toBe("sudo-escalation");
  });

  it("preserves warning mode and tool identity", () => {
    const warningValidator = new BashAstValidator({ mode: "warn" });
    expect(warningValidator.validate("bash", { command: "eval 'printf 1'" }).decision).toBe("warn");
    expect(warningValidator.validate("bash", { command: "python -c '# eval marker\nprint(1)'" }).decision).toBe("allow");
    expect(validator.validate("shell-runner", { command: "python -c '# eval marker\nprint(1)'" }).decision).toBe("allow");
  });
});
