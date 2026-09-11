import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeShellLineContinuations, tokenizeShell } from "../shell-tokenizer.js";

describe("shell logical lines", () => {
  it.skipIf(process.platform === "win32")("matches real shell argv without introducing whitespace", () => {
    for (const operands of [
      "first\\\nsecond",
      "first \\\n second",
      "'first'\\\n'second'",
      '"first\\\nsecond"',
      "'first\\\nsecond'",
      '"first\\\\\nsecond"',
    ]) {
      const command = `printf '%s\\0' ${operands}`;
      const actual = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).split("\0").slice(0, -1);
      const parsed = tokenizeShell(command);
      expect(parsed.parseError, command).toBe(false);
      expect(parsed.leaves, command).toHaveLength(1);
      expect(parsed.leaves[0]!.argv.slice(2), command).toEqual(actual);
      expect(parsed.leaves[0]!.raw, command).toBe(command);
    }
  });

  it("recognizes an operator formed across a continued line", () => {
    const command = "printf first &\\\n& printf second";
    const parsed = tokenizeShell(command);
    expect(parsed.parseError).toBe(false);
    expect(parsed.leaves.map((leaf) => leaf.argv)).toEqual([
      ["printf", "first"], ["printf", "second"],
    ]);
    expect(parsed.leaves.map((leaf) => leaf.raw)).toEqual(["printf first", "printf second"]);
  });

  it("recognizes command substitution formed across a continued line", () => {
    for (const command of [
      "printf $\\\n(printf value)",
      'printf "$\\\n(printf value)"',
    ]) {
      const leaf = tokenizeShell(command).leaves[0]!;
      expect(leaf.hasCommandSubstitution, command).toBe(true);
      expect(leaf.argv[1], command).toBe("$(printf value)");
    }
  });

  it("keeps nested single-quoted substitution input literal", () => {
    const command = 'printf "$(printf \'first\\\nsecond\')" \\\n tail';
    expect(normalizeShellLineContinuations(command)).toBe('printf "$(printf \'first\\\nsecond\')"  tail');
    expect(tokenizeShell(command).leaves[0]!.hasCommandSubstitution).toBe(true);
  });

  it("retains parameter expansion flags after a continued word", () => {
    const leaf = tokenizeShell("grep \\\n \"$PATTERN\" ./file").leaves[0]!;
    expect(leaf.argv).toEqual(["grep", "$PATTERN", "./file"]);
    expect(leaf.argvHasExpandableDollar).toEqual([false, true, false]);
  });

  it("does not join a newline behind an escaped backslash", () => {
    const command = "printf first \\\\\nprintf second";
    expect(normalizeShellLineContinuations(command)).toBe(command);
    expect(tokenizeShell(command).leaves).toHaveLength(2);
  });

  it("does not treat backslash CRLF as a backslash LF continuation", () => {
    const command = "printf first \\\r\nprintf second";
    expect(normalizeShellLineContinuations(command)).toBe(command);
    expect(tokenizeShell(command).leaves).toHaveLength(2);
  });

  it("keeps comment newlines as boundaries", () => {
    const command = "printf first # comment \\\nprintf second";
    expect(normalizeShellLineContinuations(command)).toBe(command);
    expect(tokenizeShell(command).leaves.map((leaf) => leaf.argv)).toEqual([
      ["printf", "first"], ["printf", "second"],
    ]);
    expect(normalizeShellLineContinuations("printf word\\ #part\\\njoined")).toBe("printf word\\ #partjoined");
  });

  it("does not normalize quoted heredoc data", () => {
    const command = "cat <<'END'\nfirst\\\nsecond\nEND\nprintf \\\n done";
    expect(normalizeShellLineContinuations(command)).toBe("cat <<'END'\nfirst\\\nsecond\nEND\nprintf  done");
    const parsed = tokenizeShell(command);
    expect(parsed.parseError).toBe(false);
    expect(parsed.leaves.map((leaf) => leaf.argv)).toEqual([["cat"], ["printf", "done"]]);
    expect(parsed.leaves.map((leaf) => leaf.raw)).toEqual(["cat <<'END'", "printf \\\n done"]);
  });

  it.skipIf(process.platform === "win32")("resumes after a continued unquoted heredoc terminator", () => {
    const command = "cat >/dev/null << END\nEN\\\nD\nprintf witnessed";
    expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("witnessed");
    expect(normalizeShellLineContinuations(command)).toBe("cat >/dev/null << END\nEND\nprintf witnessed");
    expect(tokenizeShell(command).parseError).toBe(false);
  });

  it.skipIf(process.platform === "win32")("joins expandable body lines without treating quotes or comments as shell syntax", () => {
    const command = "cat <<END\n'first\\\nsecond' # data\\\ncontinued\nEND\nprintf \\\n later";
    expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe("'firstsecond' # datacontinued\nlater");
    expect(normalizeShellLineContinuations(command)).toBe("cat <<END\n'firstsecond' # datacontinued\nEND\nprintf  later");
  });

  it("joins continuation lines inside expandable body substitutions", () => {
    const command = "cat << END\n$(printf \\\n value)\nEND\nprintf \\\n later";
    expect(normalizeShellLineContinuations(command)).toBe("cat << END\n$(printf  value)\nEND\nprintf  later");
  });

  it("preserves escaped backslashes in expandable bodies", () => {
    const command = "cat <<-END\nbody\\\\\n\tEND\nprintf \\\n later";
    expect(normalizeShellLineContinuations(command)).toBe("cat <<-END\nbody\\\\\n\tEND\nprintf  later");
  });

  it.each([
    "cat <<END\nstill open\\\n",
    'cat <<E"ND"\nEND\ncat /et\\\nc/shadow',
    "cat <<\\END\nEND\ncat /et\\\nc/shadow",
    "(( 1 << 2 ))\ncat /et\\\nc/shadow",
  ])("rejects a continued command when its heredoc boundary is unresolved: %s", (command) => {
    expect(normalizeShellLineContinuations(command)).toBeNull();
    expect(tokenizeShell(command)).toEqual({ leaves: [], parseError: true });
  });
});
