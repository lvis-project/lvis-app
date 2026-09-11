import { describe, expect, it } from "vitest";
import { BashAstValidator } from "../bash-ast-validator.js";

const validator = new BashAstValidator();

// Every command is validator input only; no fixture starts a shell or interpreter.
describe("eval in a literal program operand", () => {
  it.each([
    "python -c '# eval marker\nprint(1)'",
    'python -c "# eval marker\nprint(1)"',
    'python -c "print(\'eval marker\')"',
    "python2 -c '# document an eval example\nprint(1)'",
    "/usr/bin/python3 -c 'message = \"an eval example\"; print(message)'",
    "python3 -c 'print(\"$LITERAL\") # eval example'",
    "python3 -c 'print(eval(\"1\")) # eval is language program text'",
  ])("keeps another language's literal code out of shell eval detection: %s", (command) => {
    expect(validator.validate("bash", { command }).decision).toBe("allow");
  });

  it.each([
    "eval 'printf 1'",
    "python -c '# eval marker\nprint(1)'; eval 'printf 1'",
    "sh -c 'eval printf 1'",
    "bash -c 'python -c \"# eval marker\nprint(1)\"'",
    "command sh -c 'eval printf 1'",
    "env NAME=value bash -c 'eval printf 1'",
    'python -c "# eval marker\nprint(\'$(eval printf 1)\')"',
    "python -c '# eval marker\nprint(1)' <(eval printf 1)",
    "python -c '# eval marker\nprint(1)' | sh",
    "python -c '# eval marker\nprint(1)' | unknown_consumer",
    "unknown_consumer -c '# eval marker\nprint(1)'",
    "$RUNNER -c '# eval marker\nprint(1)'",
    "python -c '# eval marker\nprint(1)' extra",
    "python --unknown -c '# eval marker\nprint(1)'",
    "python -m wrapper 'eval marker'",
    "NAME=value python -c '# eval marker\nprint(1)'",
    "env NAME=value python -c '# eval marker\nprint(1)'",
    "timeout 1s python -c '# eval marker\nprint(1)'",
    "python -c '# eval marker\nprint(1)' < input.txt",
    "python -c '# eval marker\nprint(1)' > output.txt",
    "python -c '# eval marker\nprint(1)' |",
    "python -c '# eval marker\nprint(1)' &",
    "( python -c '# eval marker\nprint(1)' )",
    "{ python -c '# eval marker\nprint(1)'; }",
    "python -c '# eval marker\nprint(1)' > script; sh script",
    "python -c '# eval marker\nprint(1)",
  ])("retains executable or unresolved shell contexts: %s", (command) => {
    const result = validator.validate("bash", { command });
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("eval-untrusted");
  });

  it("still applies the other structural patterns inside literal program text", () => {
    expect(validator.validate("bash", { command: "python -c 'print(\"eval marker\"); # sudo example'" }).patternId)
      .toBe("sudo-escalation");
  });

  it("preserves warning mode and tool identity", () => {
    const warningValidator = new BashAstValidator({ mode: "warn" });
    expect(warningValidator.validate("bash", { command: "eval 'printf 1'" }).decision).toBe("warn");
    expect(warningValidator.validate("bash", { command: "python -c '# eval marker\nprint(1)'" }).decision).toBe("allow");
    expect(validator.validate("shell-runner", { command: "python -c '# eval marker\nprint(1)'" }).decision).toBe("allow");
  });
});
