import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { inspectShellHeredocData, redactHeredocBodies, tokenizeShell } from "../shell-tokenizer.js";

describe("heredoc data inspection", () => {
  it.each([
    ":%s/^first$/last/\nwq",
    "printf 'path/to/data' # ordinary text",
    "unmatched ' quote and # data",
    "literal \\$(command) and \\`command\\`",
    "$'literal' and a standalone $",
  ])("omits expansion-free body data for path analysis: %s", (body) => {
    const command = `cat > ./output <<END\n${body}\nEND`;
    expect(inspectShellHeredocData(command)).toEqual({
      command: "cat > ./output <<END\n", expansionCommands: [],
    });
    // Default tokenizer/redactor contract stays quoted-only.
    expect(redactHeredocBodies(command)).toBe(command);
  });

  it.each([
    "printf '$(printf expanded)'",
    '# "$(printf expanded)"',
    "printf '`printf expanded`'",
  ])("extracts executable substitutions despite literal quotes/comments: %s", (body) => {
    const command = `cat <<END\n${body}\nEND`;
    expect(inspectShellHeredocData(command)).toEqual({ command, expansionCommands: ["printf expanded"] });
  });

  it.skipIf(process.platform === "win32")("matches actual expansion beneath literal quotes and comments", () => {
    const command = "cat <<END\nprintf '$(printf first)' # $(printf second)\nEND";
    expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("printf 'first' # second\n");
    expect(inspectShellHeredocData(command)?.expansionCommands).toEqual(["printf first", "printf second"]);
  });

  it("does not truncate a substitution at an escaped or quoted parenthesis", () => {
    for (const body of ["printf \\); printf later", "printf ')'; printf later"]) {
      const command = `cat <<END\n'$(${body})'\nEND`;
      expect(inspectShellHeredocData(command)?.expansionCommands).toEqual([body]);
    }
  });

  it("keeps variable bodies in the conservative scan", () => {
    const command = "cat <<END\n$VALUE\nEND";
    expect(inspectShellHeredocData(command)).toEqual({ command, expansionCommands: [] });
  });

  it.skipIf(process.platform === "win32")("inspects expansions when EOF supplies a body without its terminator", () => {
    const command = "cat <<END\nprintf '$(printf witnessed)'";
    expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }))
      .toBe("printf 'witnessed'\n");
    expect(inspectShellHeredocData(command)).toEqual({ command, expansionCommands: ["printf witnessed"] });
  });

  it.skipIf(process.platform === "win32")("treats dollar signs in a bare delimiter as literal word bytes", () => {
    const command = "cat <<$END\nprintf '$(printf witnessed)'\n$END";
    expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("printf 'witnessed'\n");
    expect(inspectShellHeredocData(command)).toEqual({ command, expansionCommands: ["printf witnessed"] });
  });

  it.each(["sh", "python3 -", "cat | sh", "env cat"])("retains bodies for execution or opaque consumers: %s", (header) => {
    const command = `${header} <<END\ncat /etc/shadow\nEND`;
    expect(inspectShellHeredocData(command)?.command).toBe(command);
    expect(tokenizeShell(command, { heredocBodies: "preserve", literalDataProof: true }).parseError).toBe(true);
  });

  it.each(["|", "||", "&&", ";", "&"])("retains bodies when the header ends with a control operator: %s", (operator) => {
    const command = `cat <<END ${operator}\nprintf witnessed\nEND\nsh`;
    expect(inspectShellHeredocData(command)?.command).toBe(command);
  });

  it.skipIf(process.platform === "win32")("keeps the body of a pipeline that resumes after its heredoc", () => {
    const command = "cat <<END |\nprintf witnessed\nEND\nsh";
    expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("witnessed");
    expect(inspectShellHeredocData(command)?.command).toBe(command);
  });

  it("does not treat a quoted pipe argument as a control operator", () => {
    const command = "cat '|' <<END\nordinary / data\nEND";
    expect(inspectShellHeredocData(command)?.command).toBe("cat '|' <<END\n");
  });

  it.skipIf(process.platform === "win32")("retains bodies whose enclosing group feeds an execution consumer", () => {
    for (const [open, close] of [["{", "}"], ["(", ")"]]) {
      const command = `${open}\ncat <<END\nprintf witnessed\nEND\n${close} | sh`;
      expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("witnessed");
      expect(inspectShellHeredocData(command)?.command).toBe(command);
    }
  });

  it.each(["${VALUE:-other}", "$((VALUE + 1))", "$[VALUE]", "$(unclosed", "`unclosed", "`printf \\`nested\\``"])(
    "refuses an unresolved expansion: %s", (body) => {
      expect(inspectShellHeredocData(`cat <<END\n${body}\nEND`)).toBeNull();
    },
  );

  it("preserves the consuming redirect and does not open a heredoc from body text", () => {
    const command = "cat <<FIRST <<'SECOND'\n<<'FALSE'\nFIRST\nother\nSECOND";
    expect(redactHeredocBodies(command)).toBe("cat <<FIRST <<'SECOND'\n<<'FALSE'\nFIRST\n");
    expect(inspectShellHeredocData(command)?.command).toBe("cat <<FIRST <<'SECOND'\n");
    expect(tokenizeShell(inspectShellHeredocData(command)!.command).leaves[0]!.hasInputRedirect).toBe(true);
  });
});
