/**
 * Shell Tokenizer unit tests — pins the single-source-of-truth leaf grammar the
 * host risk inspector and the bash AST validator both consume.
 *
 * Coverage: quote-awareness (whitespace inside quotes is not a separator),
 * command/process substitution flags, output-vs-input redirect target
 * collection, compound-separator leaf boundaries, wrapper/assignment stripping,
 * and fail-closed parse errors on unbalanced quotes/parens.
 */
import { describe, it, expect } from "vitest";
import { tokenizeShell } from "../shell-tokenizer.js";

describe("tokenizeShell — quoting", () => {
  it("keeps whitespace inside single quotes as one argv token", () => {
    const { leaves, parseError } = tokenizeShell("grep 'a b c' file");
    expect(parseError).toBe(false);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.argv).toEqual(["grep", "a b c", "file"]);
  });

  it("keeps whitespace inside double quotes as one argv token", () => {
    const { leaves } = tokenizeShell('grep "a b" .');
    expect(leaves[0]!.argv).toEqual(["grep", "a b", "."]);
  });

  it("does not treat separators inside quotes as leaf boundaries", () => {
    const { leaves } = tokenizeShell("echo 'a && b | c'");
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.argv).toEqual(["echo", "a && b | c"]);
  });

  it("handles escaped quote inside double quotes", () => {
    const { leaves, parseError } = tokenizeShell('echo "a \\" b"');
    expect(parseError).toBe(false);
    expect(leaves[0]!.argv).toEqual(["echo", 'a " b']);
  });
});

describe("tokenizeShell — substitution flags", () => {
  it("flags $(...) command substitution", () => {
    const { leaves } = tokenizeShell("echo $(rm -rf /)");
    expect(leaves[0]!.hasCommandSubstitution).toBe(true);
    expect(leaves[0]!.hasProcessSubstitution).toBe(false);
  });

  it("flags backtick command substitution", () => {
    const { leaves } = tokenizeShell("echo `rm -rf /`");
    expect(leaves[0]!.hasCommandSubstitution).toBe(true);
  });

  it("flags command substitution inside double quotes", () => {
    const { leaves } = tokenizeShell('echo "$(whoami)"');
    expect(leaves[0]!.hasCommandSubstitution).toBe(true);
  });

  it("flags <(...) and >(...) process substitution", () => {
    expect(tokenizeShell("diff <(ls a) <(ls b)").leaves[0]!.hasProcessSubstitution).toBe(true);
    expect(tokenizeShell("tee >(cat) < in").leaves[0]!.hasProcessSubstitution).toBe(true);
  });

  it("does NOT flag bare parameter expansion as command substitution", () => {
    const { leaves } = tokenizeShell("ls ${HOME}");
    expect(leaves[0]!.hasCommandSubstitution).toBe(false);
    expect(leaves[0]!.argv).toEqual(["ls", "${HOME}"]);
  });
});

describe("tokenizeShell — redirects", () => {
  it("collects an output redirect target and keeps it out of argv", () => {
    const { leaves } = tokenizeShell("echo hi > out.txt");
    expect(leaves[0]!.argv).toEqual(["echo", "hi"]);
    expect(leaves[0]!.redirectTargets).toEqual(["out.txt"]);
  });

  it("collects append (>>) and clobber (>|) targets", () => {
    expect(tokenizeShell("cat a >> log").leaves[0]!.redirectTargets).toEqual(["log"]);
    expect(tokenizeShell("cat a >| log").leaves[0]!.redirectTargets).toEqual(["log"]);
  });

  it("collects numbered fd (2>) and combined (&>) redirect targets", () => {
    expect(tokenizeShell("cmd 2> err").leaves[0]!.redirectTargets).toEqual(["err"]);
    expect(tokenizeShell("cmd &> both").leaves[0]!.redirectTargets).toEqual(["both"]);
  });

  it("treats input redirect (<) as a read — no output target, flags hasInputRedirect", () => {
    const { leaves } = tokenizeShell("cat < in.txt");
    expect(leaves[0]!.argv).toEqual(["cat"]);
    expect(leaves[0]!.redirectTargets).toEqual([]);
    expect(leaves[0]!.hasInputRedirect).toBe(true);
  });

  it("does not flag hasInputRedirect on an output-only redirect", () => {
    expect(tokenizeShell("echo hi > out").leaves[0]!.hasInputRedirect).toBe(false);
  });
});

describe("tokenizeShell — compound separators", () => {
  it("splits on &&, ||, ;, |, & and newline", () => {
    expect(tokenizeShell("ls && cat foo").leaves.map((l) => l.argv[0])).toEqual(["ls", "cat"]);
    expect(tokenizeShell("ls || pwd").leaves.map((l) => l.argv[0])).toEqual(["ls", "pwd"]);
    expect(tokenizeShell("ls; pwd; whoami").leaves.map((l) => l.argv[0])).toEqual(["ls", "pwd", "whoami"]);
    expect(tokenizeShell("ls | grep foo").leaves.map((l) => l.argv[0])).toEqual(["ls", "grep"]);
    expect(tokenizeShell("ls &\ncat f").leaves.map((l) => l.argv[0])).toEqual(["ls", "cat"]);
  });

  it("splits a pipeline into per-leaf argv", () => {
    const { leaves } = tokenizeShell("cat foo | tee out");
    expect(leaves).toHaveLength(2);
    expect(leaves[0]!.argv).toEqual(["cat", "foo"]);
    expect(leaves[1]!.argv).toEqual(["tee", "out"]);
  });
});

describe("tokenizeShell — wrapper & assignment stripping", () => {
  it("strips a leading VAR=value assignment", () => {
    expect(tokenizeShell("FOO=bar ls").leaves[0]!.argv).toEqual(["ls"]);
    expect(tokenizeShell("env X=1 ls").leaves[0]!.argv).toEqual(["ls"]);
  });

  it("strips a quoted assignment value with spaces", () => {
    const { leaves } = tokenizeShell('FOO="a b c" ls -la');
    expect(leaves[0]!.argv).toEqual(["ls", "-la"]);
  });

  it("strips wrapper commands and their option/duration operands", () => {
    expect(tokenizeShell("timeout 5s ls").leaves[0]!.argv).toEqual(["ls"]);
    expect(tokenizeShell("nice -n 5 cat foo").leaves[0]!.argv).toEqual(["cat", "foo"]);
    expect(tokenizeShell("nohup ls -la").leaves[0]!.argv).toEqual(["ls", "-la"]);
  });

  it("a bare wrapper leaves an empty argv but records the wrapper verb", () => {
    const leaf = tokenizeShell("timeout").leaves[0]!;
    expect(leaf.argv).toEqual([]);
    expect(leaf.strippedWrappers).toEqual(["timeout"]);
  });

  it("records a stripped wrapper basename even when argv is present", () => {
    expect(tokenizeShell("/usr/bin/timeout 5s ls").leaves[0]!.strippedWrappers).toEqual(["timeout"]);
  });

  it("reduces an absolute command path to its basename in argv[0] check via stripPath consumers", () => {
    // The tokenizer preserves the raw path; basename reduction is the caller's job.
    expect(tokenizeShell("/usr/bin/ls -la").leaves[0]!.argv).toEqual(["/usr/bin/ls", "-la"]);
  });
});

describe("tokenizeShell — fail closed", () => {
  it("reports parseError on an unbalanced single quote", () => {
    expect(tokenizeShell("echo 'unterminated").parseError).toBe(true);
  });

  it("reports parseError on an unbalanced double quote", () => {
    expect(tokenizeShell('echo "unterminated').parseError).toBe(true);
  });

  it("reports parseError on an unbalanced command substitution paren", () => {
    expect(tokenizeShell("echo $(rm -rf /").parseError).toBe(true);
  });

  it("reports parseError on an unbalanced backtick", () => {
    expect(tokenizeShell("echo `whoami").parseError).toBe(true);
  });

  it("returns no leaves on parse error so callers fail closed", () => {
    expect(tokenizeShell("echo 'x").leaves).toEqual([]);
  });
});
