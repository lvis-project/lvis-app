import { describe, expect, it } from "vitest";
import { analyzeShell, literalWord, shellWordHasSingleField, type ShellWord } from "../shell-analysis.js";
import { analyzeShellTestExpression, parseProvenShellInteger, type ShellTestForm } from "../shell-test-expression.js";

const source = { start: 0, end: 1, raw: "word" };
const literal = (value: string): ShellWord => literalWord(value, source);
const unknown = (quoted = true): ShellWord => ({
  source,
  parts: [{ kind: "parameter", name: "UNKNOWN", quoted }],
  preservesEmpty: quoted,
});
const analyze = (form: ShellTestForm, argv: readonly (string | undefined)[], words: readonly ShellWord[] = argv.map((value) => value === undefined ? unknown() : literal(value))) =>
  analyzeShellTestExpression(form, words, argv, "bash");
const expression = (form: ShellTestForm, argv: readonly (string | undefined)[], words?: readonly ShellWord[]) => {
  const result = analyze(form, argv, words);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.reason);
  return {
    status: result.expression.status,
    data: [...result.expression.dataIndices].sort((a, b) => a - b),
    paths: [...result.expression.pathIndices].sort((a, b) => a - b),
  };
};

describe("shell test expression contract", () => {
  it("preserves double-bracket origin in the shared command AST", () => {
    const analysis = analyzeShell("[[ foo = f* ]]");
    expect(analysis.ok).toBe(true);
    if (!analysis.ok || analysis.program.kind !== "sequence") throw new Error("missing sequence");
    expect(analysis.program.statements[0]).toMatchObject({ kind: "command", testForm: "double-bracket" });
  });

  it("keeps the argv index space while classifying a bracket string comparison", () => {
    expect(expression("bracket", ["[", undefined, "=", "ready", "]"])).toEqual({
      status: "unknown",
      data: [1, 2, 3, 4],
      paths: [],
    });
  });

  it("classifies double-bracket regex operands as data without evaluating them", () => {
    expect(expression("double-bracket", ["test", "value", "=~", "^v.*$"])).toEqual({
      status: "unknown", data: [1, 2, 3], paths: [],
    });
  });

  it("does not infer Bash extension status in a POSIX nested shell", () => {
    const argv = ["test", "value", "==", "value"];
    const result = analyzeShellTestExpression("test", argv.map(literal), argv, "posix");
    expect(result).toMatchObject({ ok: true, expression: { status: "unknown" } });
  });

  it.each([
    [["test"], "failure"],
    [["test", ""], "failure"],
    [["test", "value"], "success"],
    [["test", "-n", "value"], "success"],
    [["test", "-z", "value"], "failure"],
    [["test", "left", "=", "left"], "success"],
    [["test", "left", "!=", "left"], "failure"],
    [["test", "!", "left", "=", "right"], "success"],
  ] as const)("evaluates a bounded known primary: %j", (argv, status) => {
    expect(expression("test", argv).status).toBe(status);
  });

  it("uses exact integer arithmetic only inside the proven signed range", () => {
    expect(expression("test", ["test", "9007199254740993", "-gt", "9007199254740992"]).status).toBe("success");
    expect(expression("test", ["test", "9223372036854775807", "-eq", "9223372036854775807"]).status).toBe("success");
    expect(expression("test", ["test", "-9223372036854775808", "-lt", "0"]).status).toBe("success");
    expect(expression("test", ["test", "9223372036854775808", "-eq", "9223372036854775808"]).status).toBe("unknown");
    expect(expression("test", ["test", "-9223372036854775809", "-eq", "-9223372036854775809"]).status).toBe("unknown");
    expect(expression("test", ["test", "9".repeat(2_000), "-eq", "1"]).status).toBe("unknown");
    expect(parseProvenShellInteger("+0001")).toBe(1n);
  });

  it("retains data roles when numeric truth is unknown", () => {
    expect(expression("test", ["test", undefined, "-ge", "200"])).toEqual({
      status: "unknown", data: [1, 2, 3], paths: [],
    });
  });

  it.each([
    [["test", "-e", undefined], [2]],
    [["test", undefined, "-nt", "./other"], [1, 3]],
  ] as const)("retains filesystem roles: %j", (argv, paths) => {
    expect(expression("test", argv).paths).toEqual(paths);
  });

  it.each([
    ["-t", undefined],
    ["-o", undefined],
    ["-v", "SIMPLE_NAME"],
    ["-R", "SIMPLE_NAME"],
  ] as const)("classifies a constrained scalar unary role: %s", (operator, value) => {
    expect(expression("test", ["test", operator, value])).toMatchObject({ paths: [] });
  });

  it("does not grant dynamic or subscripted variable-name interpretation", () => {
    expect(analyze("test", ["test", "-v", undefined])).toMatchObject({ ok: false, error: { reason: "unsupported test variable name" } });
    expect(analyze("test", ["test", "-v", "array[0]"])).toMatchObject({ ok: false, error: { reason: "unsupported test variable name" } });
  });

  it("rejects an unresolved field count before assigning a data role", () => {
    const words = [literal("test"), unknown(false), literal("="), literal("ready")];
    expect(analyze("test", ["test", undefined, "=", "ready"], words)).toMatchObject({
      ok: false, error: { reason: "unresolved test argument count", operandIndex: 1 },
    });
    expect(shellWordHasSingleField(words[1]!)).toBe(false);
  });

  it.each([
    ["test", ["test", "x", "-unknown", "y"], "unsupported test binary operator"],
    ["test", ["test", "x", "-a", "y"], "ambiguous test logical operator"],
    ["test", ["test", "x", "-o", "y"], "ambiguous test logical operator"],
    ["test", ["test", "x", "y", "z", "w"], "ambiguous test expression arity"],
    ["bracket", ["[", "x"], "missing or unresolved closing ]"],
    ["bracket", ["[", "x", "]", "]"], "unsupported test unary operator"],
  ] as const)("fails closed for unsupported shape: %s %j", (form, argv, reason) => {
    expect(analyze(form, argv)).toMatchObject({ ok: false, error: { reason } });
  });

  it("allows an interior ] only as ordinary string data", () => {
    expect(expression("bracket", ["[", "]", "=", "]", "]"])).toEqual({
      status: "success", data: [1, 2, 3, 4], paths: [],
    });
  });

  it("never infers double-bracket truth from scalar test semantics", () => {
    expect(expression("test", ["test", "foo", "=", "f*"]).status).toBe("failure");
    expect(expression("double-bracket", ["test", "foo", "=", "f*"]).status).toBe("unknown");
  });
});
