import { describe, expect, it } from "vitest";
import { tokenizeShell } from "../shell-tokenizer.js";

describe("canonical complete command projection", () => {
  it.each([
    "printf one", "\n# leading comment\ncd work && printf one 2>&1\n",
    "printf one; printf two;", "printf one\nprintf two\n", "printf one && printf two || printf three",
    "printf one &&\n# continuation comment\n\nprintf two", "printf one ||\n# continuation comment\nprintf two",
    "printf one;\n# trailing comment", "printf one # trailing comment",
    "printf '%s' 'literal && || ; | & ( ) { } $VALUE'", "cd work && py\\\nthon -c 'print(1)' 2>&1",
    "printf one 12>&3 1>&-", "printf one | printf two", "printf one &", "printf one & printf two",
    "( printf one )", "{ printf one; }", "printf word\\ # this is not a comment",
    "cat <<END\nbody\nEND", "cat <<< data",
  ])("projects complete grammar without a second simple-list mode: %s", command => {
    expect(tokenizeShell(command).parseError).toBe(false);
  });
  it.each([
    "&& printf one", "|| printf one", "; printf one", "printf one &&", "printf one ||",
    "printf one &&\n# still waiting for a command\n", "printf one ||\n# still waiting for a command",
    "printf one && && printf two", "printf one; && printf two", "printf one;; printf two",
    "printf one;\n; printf two", "printf one |", "printf one >", "printf 'one",
  ])("returns no partial command for incomplete syntax: %s", command => {
    expect(tokenizeShell(command)).toEqual({leaves:[],parseError:true});
  });
  it("retains original command bytes and separates descriptor redirects from files", () => {
    const command="cd work && py\\\nthon -c 'print(1)' 2>&1";
    expect(tokenizeShell(command).leaves[1]).toMatchObject({argv:["python","-c","print(1)"],raw:"py\\\nthon -c 'print(1)' 2>&1",hasOutputRedirect:true,redirectTargets:[]});
    expect(tokenizeShell("printf one >&1report").leaves[0]).toMatchObject({hasOutputRedirect:true,redirectTargets:["1report"]});
    expect(tokenizeShell("printf one > output").leaves[0]).toMatchObject({redirectTargets:["output"]});
    expect(tokenizeShell("printf one < input").leaves[0]).toMatchObject({inputRedirectTargets:["input"]});
  });
});
