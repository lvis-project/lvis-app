import { describe, expect, it } from "vitest";
import { tokenizeShell } from "../shell-tokenizer.js";

describe("tokenizeShell strict simple command lists", () => {
  it.each([
    "printf one",
    "\n# leading comment\ncd work && printf one 2>&1\n",
    "printf one; printf two;",
    "printf one\nprintf two\n",
    "printf one && printf two || printf three",
    "printf one &&\n# continuation comment\n\nprintf two",
    "printf one ||\n# continuation comment\nprintf two",
    "printf one;\n# trailing comment",
    "printf one # trailing comment",
    "printf '%s' 'literal && || ; | & ( ) { } $VALUE'",
    "cd work && py\\\nthon -c 'print(1)' 2>&1",
    "printf one 12>&3 1>&-",
  ])("proves complete static command lists: %s", (command) => {
    expect(tokenizeShell(command, { simpleCommandList: true }).parseError).toBe(false);
  });

  it.each([
    "&& printf one",
    "|| printf one",
    "; printf one",
    "printf one &&",
    "printf one ||",
    "printf one &&\n# still waiting for a command\n",
    "printf one ||\n# still waiting for a command",
    "printf one && && printf two",
    "printf one; && printf two",
    "printf one;; printf two",
    "printf one;\n; printf two",
    "printf one | printf two",
    "printf one |",
    "printf one &",
    "printf one & printf two",
    "( printf one )",
    "{ printf one; }",
    "printf one >",
    "printf 'one",
    "printf word\\ # this is not a comment",
    "cat <<END\nbody\nEND",
    "cat <<< data",
  ])("refuses incomplete or unsupported lists: %s", (command) => {
    expect(tokenizeShell(command, { simpleCommandList: true }).parseError).toBe(true);
  });

  it("keeps the source mapping and descriptor/file target evidence", () => {
    const command = "cd work && py\\\nthon -c 'print(1)' 2>&1";
    const result = tokenizeShell(command, { simpleCommandList: true });
    expect(result.leaves[1]).toMatchObject({
      argv: ["python", "-c", "print(1)"],
      raw: "py\\\nthon -c 'print(1)' 2>&1",
      hasOutputRedirect: true,
      redirectTargets: [],
    });
    expect(tokenizeShell("printf one >&1report", { simpleCommandList: true }).leaves[0])
      .toMatchObject({ hasOutputRedirect: true, redirectTargets: ["1report"] });
    expect(tokenizeShell("printf one > output", { simpleCommandList: true }).leaves[0])
      .toMatchObject({ hasOutputRedirect: true, redirectTargets: ["output"] });
    expect(tokenizeShell("printf one < input", { simpleCommandList: true }).leaves[0])
      .toMatchObject({ hasInputRedirect: true, inputRedirectTargets: ["input"] });
  });

  it.each(["printf one |", "printf one &&", "printf one &", "( printf one )"])(
    "does not change the default or earlier literal-proof grammar: %s", (command) => {
      expect(tokenizeShell(command).parseError).toBe(false);
      expect(tokenizeShell(command, { literalDataProof: true }).parseError).toBe(false);
    },
  );
});
