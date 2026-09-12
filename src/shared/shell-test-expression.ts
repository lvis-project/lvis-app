import { shellWordHasSingleField, type ShellWord } from "./shell-analysis.js";

type ShellTestStatus = "success" | "failure" | "unknown";
export type ShellTestForm = "test" | "bracket" | "double-bracket";
export interface ShellTestExpression {
  status: ShellTestStatus;
  /** Syntactic tokens and operands that cannot name filesystem paths. */
  dataIndices: ReadonlySet<number>;
  /** Operands that retain the host's ordinary filesystem path checks. */
  pathIndices: ReadonlySet<number>;
}
interface ShellTestExpressionFailure {
  reason: string;
  operandIndex?: number;
}
export type ShellTestExpressionResult =
  | { ok: true; expression: ShellTestExpression }
  | { ok: false; error: ShellTestExpressionFailure };

const PATH_UNARY = new Set([
  "-a", "-b", "-c", "-d", "-e", "-f", "-g", "-G", "-h", "-k",
  "-L", "-N", "-O", "-p", "-r", "-S", "-s", "-u", "-w", "-x",
]);
const STRING_UNARY = new Set(["-n", "-z"]);
const STRING_BINARY = new Set(["=", "==", "!=", "<", ">"]);
const INTEGER_BINARY = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const PATH_BINARY = new Set(["-ef", "-nt", "-ot"]);
const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PROVEN_INTEGER = 9_223_372_036_854_775_807n;
const MIN_PROVEN_INTEGER = -9_223_372_036_854_775_808n;

/**
 * Use BigInt so JavaScript never rounds a condition. The real-shell contract
 * tests pin this signed 64-bit subset; values outside it remain unknown.
 */
export function parseProvenShellInteger(value: string | undefined): bigint | undefined {
  if (value === undefined || !/^[+-]?[0-9]+$/.test(value)) return undefined;
  const unsigned = value.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
  if (unsigned.length > 19) return undefined;
  const parsed = BigInt(`${value.startsWith("-") ? "-" : ""}${unsigned}`);
  return parsed >= MIN_PROVEN_INTEGER && parsed <= MAX_PROVEN_INTEGER ? parsed : undefined;
}

function merge(...expressions: readonly ShellTestExpression[]): ShellTestExpression {
  const dataIndices = new Set<number>();
  const pathIndices = new Set<number>();
  for (const expression of expressions) {
    for (const index of expression.dataIndices) dataIndices.add(index);
    for (const index of expression.pathIndices) pathIndices.add(index);
  }
  return { status: expressions.at(-1)?.status ?? "unknown", dataIndices, pathIndices };
}

function negate(status: ShellTestStatus): ShellTestStatus {
  return status === "success" ? "failure" : status === "failure" ? "success" : "unknown";
}

function compareIntegers(left: bigint, operator: string, right: bigint): boolean {
  if (operator === "-eq") return left === right;
  if (operator === "-ne") return left !== right;
  if (operator === "-lt") return left < right;
  if (operator === "-le") return left <= right;
  if (operator === "-gt") return left > right;
  return left >= right;
}

/** Analyze only the bounded, single-primary forms shared by `test` and `[`. */
export function analyzeShellTestExpression(
  form: ShellTestForm,
  words: readonly ShellWord[],
  argv: readonly (string | undefined)[],
  dialect: "bash" | "posix",
): ShellTestExpressionResult {
  const fail = (reason: string, operandIndex?: number): ShellTestExpressionResult => ({
    ok: false,
    error: { reason, ...(operandIndex === undefined ? {} : { operandIndex }) },
  });
  const verb = form === "bracket" ? "[" : "test";
  if (words.length !== argv.length || argv[0] !== verb) return fail("invalid test command shape", 0);
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === undefined && !shellWordHasSingleField(words[index]!)) {
      return fail("unresolved test argument count", index);
    }
  }

  const dataIndices = new Set<number>();
  const expressionIndices = Array.from({ length: argv.length - 1 }, (_, index) => index + 1);
  if (form === "bracket") {
    const closer = expressionIndices.pop();
    if (closer === undefined || argv[closer] !== "]") return fail("missing or unresolved closing ]", closer);
    dataIndices.add(closer);
  }

  const parse = (indices: readonly number[]): ShellTestExpressionResult => {
    if (indices.length === 0) return { ok: true, expression: { status: "failure", dataIndices: new Set(), pathIndices: new Set() } };
    if (indices.length === 1) {
      const index = indices[0]!;
      const value = argv[index];
      return { ok: true, expression: {
        status: value === undefined ? "unknown" : value === "" ? "failure" : "success",
        dataIndices: new Set([index]), pathIndices: new Set(),
      } };
    }
    if (indices.length === 2) {
      const [operatorIndex, operandIndex] = indices as readonly [number, number];
      const operator = argv[operatorIndex];
      if (operator === "!") {
        const inner = parse([operandIndex]);
        if (!inner.ok) return inner;
        const expression = merge(inner.expression);
        expression.dataIndices = new Set([...expression.dataIndices, operatorIndex]);
        expression.status = negate(expression.status);
        return { ok: true, expression };
      }
      if (operator === undefined) return fail("unresolved test unary operator", operatorIndex);
      const value = argv[operandIndex];
      let status: ShellTestStatus = "unknown";
      let role: "data" | "path";
      if (PATH_UNARY.has(operator)) role = "path";
      else if (STRING_UNARY.has(operator)) {
        role = "data";
        if (value !== undefined) status = (operator === "-n" ? value.length > 0 : value.length === 0) ? "success" : "failure";
      } else if (operator === "-t" || operator === "-o") role = "data";
      else if (operator === "-v" || operator === "-R") {
        if (value === undefined || !SIMPLE_IDENTIFIER.test(value)) return fail("unsupported test variable name", operandIndex);
        role = "data";
      } else return fail("unsupported test unary operator", operatorIndex);
      return { ok: true, expression: {
        status,
        dataIndices: new Set(role === "data" ? [operatorIndex, operandIndex] : [operatorIndex]),
        pathIndices: new Set(role === "path" ? [operandIndex] : []),
      } };
    }
    if (indices.length === 3) {
      const [leftIndex, operatorIndex, rightIndex] = indices as readonly [number, number, number];
      const operator = argv[operatorIndex];
      if (operator === "-a" || operator === "-o") return fail("ambiguous test logical operator", operatorIndex);
      const doubleBracketPattern = form === "double-bracket" && operator === "=~";
      if (operator !== undefined && (STRING_BINARY.has(operator) || INTEGER_BINARY.has(operator) || PATH_BINARY.has(operator) || doubleBracketPattern)) {
        const left = argv[leftIndex];
        const right = argv[rightIndex];
        let status: ShellTestStatus = "unknown";
        const paths = PATH_BINARY.has(operator);
        if (STRING_BINARY.has(operator) && left !== undefined && right !== undefined) {
          if (operator === "=" || operator === "!=") {
            const equal = left === right;
            status = (operator === "=" ? equal : !equal) ? "success" : "failure";
          } else if (operator === "==" && dialect === "bash") {
            status = left === right ? "success" : "failure";
          }
        } else if (INTEGER_BINARY.has(operator)) {
          const leftInteger = parseProvenShellInteger(left);
          const rightInteger = parseProvenShellInteger(right);
          if (leftInteger !== undefined && rightInteger !== undefined) {
            status = compareIntegers(leftInteger, operator, rightInteger) ? "success" : "failure";
          }
        }
        return { ok: true, expression: {
          status,
          dataIndices: new Set(paths ? [operatorIndex] : [leftIndex, operatorIndex, rightIndex]),
          pathIndices: new Set(paths ? [leftIndex, rightIndex] : []),
        } };
      }
      if (argv[leftIndex] === "!") {
        const inner = parse([operatorIndex, rightIndex]);
        if (!inner.ok) return inner;
        const expression = merge(inner.expression);
        expression.dataIndices = new Set([...expression.dataIndices, leftIndex]);
        expression.status = negate(expression.status);
        return { ok: true, expression };
      }
      return fail(operator === undefined ? "unresolved test binary operator" : "unsupported test binary operator", operatorIndex);
    }
    if (indices.length === 4 && argv[indices[0]!] === "!") {
      const inner = parse(indices.slice(1));
      if (!inner.ok) return inner;
      const expression = merge(inner.expression);
      expression.dataIndices = new Set([...expression.dataIndices, indices[0]!]);
      expression.status = negate(expression.status);
      return { ok: true, expression };
    }
    return fail("ambiguous test expression arity", indices[0]);
  };

  const parsed = parse(expressionIndices);
  if (!parsed.ok) return parsed;
  const expression = merge(parsed.expression, { status: parsed.expression.status, dataIndices, pathIndices: new Set() });
  // `[[` has pattern and expression semantics distinct from scalar `test`.
  // Its origin is retained for role classification, but v1 never prunes a
  // branch from a flattened double-bracket expression.
  if (form === "double-bracket") expression.status = "unknown";
  return { ok: true, expression };
}
