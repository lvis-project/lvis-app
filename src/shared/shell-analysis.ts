import { ShellAnalysisError, parseShellSyntax, type ShellSyntaxNode } from "./shell-parser.js";

export interface ShellSpan { start: number; end: number; raw: string }
export type ShellWordPart =
  | { kind: "literal"; value: string }
  | { kind: "unicode-escaped"; value: string }
  | { kind: "parameter"; name: string; quoted: boolean; index?: number | "@" }
  | { kind: "parameter-choice"; name: string; operator: "-" | ":-" | "+" | ":+"; operand: ShellWord; quoted: boolean }
  | { kind: "arithmetic-data"; variables: readonly string[] }
  | { kind: "pattern"; value: string }
  | { kind: "substitution"; body: ShellStatement; process: boolean; backquotes: boolean }
  | { kind: "unknown"; reason: string };
export interface ShellWord { source: ShellSpan; parts: readonly ShellWordPart[]; preservesEmpty: boolean }
export interface ShellAssignment { name: string; value: ShellWord; elements?: readonly ShellWord[]; append: boolean; declarationOnly?: boolean; source: ShellSpan }
interface ShellRedirect {
  source: ShellSpan;
  effect: "read" | "write";
  target?: ShellWord;
  data?: ShellWord;
  descriptor: boolean;
}
export interface ShellCommand {
  kind: "command";
  source: ShellSpan;
  words: readonly ShellWord[];
  assignments: readonly ShellAssignment[];
  assignmentScope: "current" | "command";
  redirects: readonly ShellRedirect[];
}
export type ShellStatement =
  | ShellCommand
  | { kind: "sequence"; source: ShellSpan; statements: readonly ShellStatement[] }
  | { kind: "and" | "or"; source: ShellSpan; left: ShellStatement; right: ShellStatement }
  | { kind: "subshell" | "background" | "negate"; source: ShellSpan; body: ShellStatement }
  | { kind: "pipeline"; source: ShellSpan; statements: readonly ShellStatement[] }
  | { kind: "for"; source: ShellSpan; name: string; values: readonly ShellWord[] | null; body: ShellStatement }
  | { kind: "if"; source: ShellSpan; condition: ShellStatement; consequent: ShellStatement; alternate: ShellStatement }
  | { kind: "while"; source: ShellSpan; condition: ShellStatement; body: ShellStatement; until: boolean }
  | { kind: "function"; source: ShellSpan; name: string; body: ShellStatement }
  | { kind: "unsupported"; source: ShellSpan; reason: string };

export type ShellAnalysis = { ok: true; program: ShellStatement } | { ok: false; reason: string };

export function literalWord(value: string, source: ShellSpan): ShellWord {
  return { source, parts: [{ kind: "literal", value }], preservesEmpty: true };
}
export function staticShellWord(word: ShellWord): string | undefined {
  return word.parts.every((part) => part.kind === "literal") ? word.parts.map((part) => part.kind === "literal" ? part.value : "").join("") : undefined;
}
export function displayShellWord(word: ShellWord): string {
  if (word.parts.some((part) => part.kind === "unknown" || part.kind === "substitution" || part.kind === "unicode-escaped" || part.kind === "parameter-choice" || part.kind === "arithmetic-data")) return word.source.raw;
  return word.parts.map((part) => part.kind === "literal" || part.kind === "pattern" ? part.value : part.kind === "parameter" ? `$${part.name}` : "").join("");
}
function decodeLiteral(text: string, context: WordContext): ShellWordPart[] {
  const parts: ShellWordPart[] = [];
  let value = "";
  const flush = (): void => { if (value) parts.push({ kind: "literal", value }); value = ""; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length) {
      const next = text[index + 1]!;
      const escaped = context === "unquoted" || context === "assignment"
        || (context === "heredoc" ? "$`\\\n" : "$`\"\\\n").includes(next);
      if (escaped) { if (next !== "\n") value += next; index += 1; continue; }
    }
    if (context === "unquoted" && "*?[".includes(char)) { flush(); parts.push({ kind: "pattern", value: char }); }
    else value += char;
  }
  flush();
  return parts.length ? parts : [{ kind: "literal", value: "" }];
}

interface ShellSource { text: string; bytes: Buffer; dialect: "bash" | "posix"; braceWords: ReadonlySet<string>; escapedStrings: Readonly<Record<string, string>> }
function object(value: unknown): ShellSyntaxNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing typed shell syntax node");
  return value as ShellSyntaxNode;
}
function children(node: ShellSyntaxNode, key: string): ShellSyntaxNode[] {
  const value = node[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid shell syntax collection: ${key}`);
  return value.map(object);
}
function child(node: ShellSyntaxNode, key: string): ShellSyntaxNode { return object(node[key]); }
function value(node: ShellSyntaxNode, key: string): string {
  const result = node[key];
  if (typeof result !== "string") throw new Error(`Invalid shell syntax string: ${key}`);
  return result;
}
function span(node: ShellSyntaxNode, source: ShellSource): ShellSpan {
  const start = node.Pos?.Offset ?? 0;
  const end = node.End?.Offset ?? start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.bytes.length) throw new Error("Invalid shell syntax source span");
  return { start, end, raw: source.bytes.subarray(start, end).toString("utf8") };
}
function unsupported(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  return { kind: "unsupported", source: span(node, source), reason: `Unsupported shell syntax: ${node.Type ?? "statement"}` };
}
export function analyzeShell(command: string, dialect: "bash" | "posix" = "bash"): ShellAnalysis {
  try {
    const file = parseShellSyntax(command);
    const braceWords = file.BraceWords;
    if (!Array.isArray(braceWords) || braceWords.some((range) => !Array.isArray(range)
      || range.length !== 2 || !range.every((offset) => Number.isSafeInteger(offset)))) throw new Error("Invalid shell brace annotations");
    const escapedStrings = file.EscapedStrings;
    if (!escapedStrings || typeof escapedStrings !== "object" || Array.isArray(escapedStrings)
      || Object.values(escapedStrings).some((item) => typeof item !== "string")) throw new Error("Invalid shell string annotations");
    const source = { text: command, bytes: Buffer.from(command, "utf8"), dialect, braceWords: new Set(braceWords.map((range) => `${range[0]}:${range[1]}`)), escapedStrings: escapedStrings as Record<string, string> };
    return { ok: true, program: sequence(children(file, "Stmts"), source, { start: 0, end: source.bytes.length, raw: command }) };
  } catch (error) {
    if (error instanceof ShellAnalysisError) return { ok: false, reason: error.message };
    throw error;
  }
}
function sequence(nodes: readonly ShellSyntaxNode[], source: ShellSource, location: ShellSpan): ShellStatement {
  return { kind: "sequence", source: location, statements: nodes.map((node) => lowerStatement(node, source)) };
}
function lowerStatement(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  const location = span(node, source);
  if (node.Coprocess) return unsupported(node, source);
  const raw = node.Cmd ? child(node, "Cmd") : undefined;
  let statement: ShellStatement = raw ? lowerCommandNode(raw, source) : { kind: "command", source: location, words: [], assignments: [], assignmentScope: "current", redirects: [] };
  const redirects = children(node, "Redirs");
  if (redirects.length > 0) {
    if (statement.kind !== "command") return unsupported(node, source);
    statement = { ...statement, source: location, redirects: redirects.map((redirect) => lowerRedirect(redirect, source)) };
  }
  if (node.Negated) statement = { kind: "negate", source: location, body: statement };
  if (node.Background) statement = { kind: "background", source: location, body: statement };
  return statement;
}
function lowerCommandNode(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  const location = span(node, source);
  switch (node.Type) {
    case "CallExpr":
      return { kind: "command", source: location, words: children(node, "Args").map((word) => lowerWord(word, source)),
        assignments: children(node, "Assigns").map((assignment) => lowerAssignment(assignment, source)),
        assignmentScope: children(node, "Args").length ? "command" : "current", redirects: [] };
    case "Block": return sequence(children(node, "Stmts"), source, location);
    case "Subshell": return { kind: "subshell", source: location, body: sequence(children(node, "Stmts"), source, location) };
    case "BinaryCmd": {
      const left = lowerStatement(child(node, "X"), source);
      const right = lowerStatement(child(node, "Y"), source);
      const operator = value(node, "Op");
      if (operator === "|&" && source.dialect !== "bash") return unsupported(node, source);
      if (operator === "&&" || operator === "||") return { kind: operator === "&&" ? "and" : "or", source: location, left, right };
      if (operator === "|" || operator === "|&") return { kind: "pipeline", source: location, statements: [...(left.kind === "pipeline" ? left.statements : [left]), ...(right.kind === "pipeline" ? right.statements : [right])] };
      return unsupported(node, source);
    }
    case "ForClause": {
      const loop = child(node, "Loop");
      if (node.Select || loop.Type !== "WordIter") return unsupported(node, source);
      return { kind: "for", source: location, name: value(child(loop, "Name"), "Value"),
        values: loop.InPos ? children(loop, "Items").map((word) => lowerWord(word, source)) : null,
        body: sequence(children(node, "Do"), source, location) };
    }
    case "IfClause": return lowerConditional(node, source);
    case "WhileClause": return { kind: "while", source: location, until: node.Until === true,
      condition: sequence(children(node, "Cond"), source, location), body: sequence(children(node, "Do"), source, location) };
    case "FuncDecl":
      if (node.RsrvWord && source.dialect !== "bash") return unsupported(node, source);
      return { kind: "function", source: location, name: value(child(node, "Name"), "Value"), body: lowerStatement(child(node, "Body"), source) };
    case "DeclClause": {
      const variant = value(child(node, "Variant"), "Value");
      if (!["export", "readonly"].includes(variant)) return unsupported(node, source);
      const assignments = children(node, "Args");
      if (assignments.some((assignment) => !assignment.Name || (assignment.Naked && assignment.Value))) return unsupported(node, source);
      return { kind: "command", source: location, words: [literalWord(variant, location)],
        assignments: assignments.map((assignment) => assignment.Naked
          ? { name: value(child(assignment, "Name"), "Value"), value: literalWord("", span(assignment, source)), append: false, declarationOnly: true, source: span(assignment, source) }
          : lowerAssignment(assignment, source)), assignmentScope: "current", redirects: [] };
    }
    case "TestClause": {
      if (source.dialect !== "bash") return unsupported(node, source);
      const words: ShellWord[] = [literalWord("test", location)];
      const lowerTest = (part: ShellSyntaxNode): void => {
        switch (part.Type) {
          case "Word": words.push(lowerWord(part, source, "assignment")); return;
          case "UnaryTest": words.push(literalWord(value(part, "Op"), span(part, source))); lowerTest(child(part, "X")); return;
          case "BinaryTest": lowerTest(child(part, "X")); words.push(literalWord(value(part, "Op"), span(part, source))); lowerTest(child(part, "Y")); return;
          case "ParenTest": lowerTest(child(part, "X")); return;
          default: throw new ShellAnalysisError("Unsupported shell test expression");
        }
      };
      lowerTest(child(node, "X"));
      return { kind: "command", source: location, words, assignments: [], assignmentScope: "current", redirects: [] };
    }
    case "TimeClause": return lowerStatement(child(node, "Stmt"), source);
    default: return unsupported(node, source);
  }
}
function lowerConditional(node: ShellSyntaxNode, source: ShellSource): ShellStatement {
  const location = span(node, source);
  if (!node.Cond) return sequence(children(node, "Then"), source, location);
  return { kind: "if", source: location, condition: sequence(children(node, "Cond"), source, location),
    consequent: sequence(children(node, "Then"), source, location),
    alternate: node.Else ? lowerConditional(child(node, "Else"), source) : sequence([], source, location) };
}
function lowerAssignment(node: ShellSyntaxNode, source: ShellSource): ShellAssignment {
  if (source.dialect !== "bash" && (node.Array || node.Append)) throw new ShellAnalysisError("Unsupported non-POSIX assignment");
  if (node.Index || node.Naked) throw new ShellAnalysisError("Unsupported indexed or attribute assignment");
  const elements = node.Array ? children(child(node, "Array"), "Elems").map((element) => {
    if (element.Index) throw new ShellAnalysisError("Unsupported indexed array assignment");
    return lowerWord(child(element, "Value"), source);
  }) : undefined;
  return { name: value(child(node, "Name"), "Value"), append: node.Append === true, source: span(node, source),
    ...(elements ? { elements } : {}),
    value: node.Value ? lowerWord(child(node, "Value"), source, "assignment") : literalWord("", span(node, source)) };
}
function lowerRedirect(node: ShellSyntaxNode, source: ShellSource): ShellRedirect {
  const location = span(node, source);
  const operator = value(node, "Op");
  const word = lowerWord(child(node, "Word"), source);
  if (node.Hdoc) {
    const quoted = children(child(node, "Word"), "Parts").some((part) => part.Type !== "Lit" || value(part, "Value").includes("\\"));
    return { source: location, effect: "read", descriptor: false,
      data: lowerWord(child(node, "Hdoc"), source, quoted ? "literal" : "heredoc") };
  }
  if (operator === "<<<") {
    if (source.dialect !== "bash") throw new ShellAnalysisError("Unsupported non-POSIX here-string");
    return { source: location, effect: "read", descriptor: false, data: word };
  }
  const target = staticShellWord(word);
  const descriptor = [">&", "<&"].includes(operator) && target !== undefined && /^(?:\d+-?|-)$/.test(target);
  if ([">&", "<&"].includes(operator) && target === undefined) throw new ShellAnalysisError("Unresolved descriptor redirect");
  return { source: location, effect: operator.startsWith("<") && operator !== "<>" ? "read" : "write",
    descriptor, ...(descriptor ? {} : { target: word }) };
}
type WordContext = "unquoted" | "double" | "assignment" | "heredoc" | "literal";
function lowerWord(node: ShellSyntaxNode, source: ShellSource, context: WordContext = "unquoted"): ShellWord {
  const location = span(node, source);
  if (context === "unquoted" && source.braceWords.has(`${location.start}:${location.end}`)) {
    return { source: location, parts: [{ kind: "unknown", reason: "Unsupported brace expansion" }], preservesEmpty: true };
  }
  const syntaxParts = children(node, "Parts");
  const parts = syntaxParts.flatMap((part, index) => lowerWordPart(part, source, context, index === 0));
  const preservesEmpty = context !== "unquoted" || syntaxParts.some((part) => part.Type === "SglQuoted" || part.Type === "DblQuoted");
  return { source: location, parts: parts.length ? parts : [{ kind: "literal", value: "" }], preservesEmpty };
}
function lowerWordPart(node: ShellSyntaxNode, source: ShellSource, context: WordContext, first: boolean): ShellWordPart[] {
  switch (node.Type) {
    case "Lit": {
      const text = typeof node.Value === "string" ? node.Value : "";
      if (context === "literal") return [{ kind: "literal", value: text }];
      if (first && (context === "unquoted" || context === "assignment") && text.startsWith("~")) {
        if (text === "~" || text.startsWith("~/")) return [{ kind: "parameter", name: "HOME", quoted: true }, ...decodeLiteral(text.slice(1), context)];
        return [{ kind: "unknown", reason: "Unsupported named-home expansion" }];
      }
      return decodeLiteral(text, context);
    }
    case "SglQuoted": {
      if (!node.Dollar) return [{ kind: "literal", value: node.Value === undefined ? "" : value(node, "Value") }];
      if (source.dialect !== "bash") return [{ kind: "unknown", reason: "Escaped-string semantics are not established for the nested shell" }];
      const location = span(node, source);
      const cooked = source.escapedStrings[JSON.stringify([location.start, location.end])];
      if (cooked === undefined) return [{ kind: "unknown", reason: "Unsupported escaped-string bytes" }];
      // The grammar owns the complete quoted string and its static expansion.
      // These two escape families require an additional native contract:
      // Unicode depends on the selected interpreter/locale, while control
      // escapes are not implemented by the upstream static expander.
      const raw = node.Value === undefined ? "" : value(node, "Value");
      let unicode = false;
      for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] !== "\\") continue;
        const escape = raw[++index];
        if (escape === "c") return [{ kind: "unknown", reason: "Unsupported control-character escape" }];
        if (escape === "u" || escape === "U") unicode = true;
      }
      return [{ kind: unicode ? "unicode-escaped" : "literal", value: cooked }];
    }
    case "DblQuoted":
      return node.Dollar ? [{ kind: "unknown", reason: "Unsupported localized-string expansion" }]
        : children(node, "Parts").flatMap((part) => lowerWordPart(part, source, "double", false));
    case "ParamExp": {
      const plain = !["Excl", "Length", "Width", "Slice", "Repl", "Names", "Exp"].some((key) => node[key]);
      const name = value(child(node, "Param"), "Value");
      let index: number | "@" | undefined;
      if (node.Index) {
        if (source.dialect !== "bash") return [{ kind: "unknown", reason: "Unsupported non-POSIX array expansion" }];
        const syntaxIndex = child(node, "Index");
        const raw = syntaxIndex.Type === "Word" ? staticShellWord(lowerWord(syntaxIndex, source, "assignment")) : undefined;
        if (raw === "@"){ index = "@"; }
        else if (raw !== undefined && /^(?:0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw))) index = Number(raw);
        else return [{ kind: "unknown", reason: "Unsupported array index expansion" }];
      }
      if (node.Exp && !["Excl", "Length", "Width", "Slice", "Repl", "Names", "Index"].some((key) => node[key])) {
        const expansion = child(node, "Exp");
        const operator = value(expansion, "Op");
        if (operator === "-" || operator === ":-" || operator === "+" || operator === ":+") {
          return [{ kind: "parameter-choice", name, operator, quoted: context !== "unquoted",
            operand: expansion.Word ? lowerWord(child(expansion, "Word"), source, context) : literalWord("", span(node, source)) }];
        }
      }
      return plain ? [{ kind: "parameter", name, quoted: context !== "unquoted", ...(index !== undefined ? { index } : {}) }]
        : [{ kind: "unknown", reason: "Unsupported parameter expansion" }];
    }
    case "ArithmExp": {
      const variables = pureArithmeticVariables(child(node, "X"));
      return variables === undefined ? [{ kind: "unknown", reason: "Unsupported arithmetic effects" }]
        : [{ kind: "arithmetic-data", variables }];
    }
    case "CmdSubst": case "ProcSubst":
      if (node.Type === "ProcSubst" && source.dialect !== "bash") return [{ kind: "unknown", reason: "Unsupported non-POSIX process substitution" }];
      return [{ kind: "substitution", body: sequence(children(node, "Stmts"), source, span(node, source)), process: node.Type === "ProcSubst", backquotes: node.Backquotes === true }];
    default: return [{ kind: "unknown", reason: `Unsupported shell word: ${node.Type}` }];
  }
}

// Only the typed arithmetic tree establishes whether evaluation can write or
// invoke nested code. The numeric result remains unknown to path authority.
function pureArithmeticVariables(node: ShellSyntaxNode): string[] | undefined {
  switch (node.Type) {
    case "Word": {
      const parts = children(node, "Parts");
      if (parts.some((part) => part.Type !== "Lit")) return undefined;
      const text = parts.map((part) => value(part, "Value")).join("");
      if (/^[0-9]+$/.test(text)) return [];
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? [text] : undefined;
    }
    case "UnaryArithm":
      if (node.Post || !["+", "-", "!", "~"].includes(value(node, "Op"))) return undefined;
      return pureArithmeticVariables(child(node, "X"));
    case "BinaryArithm": {
      if (!["+", "-", "*", "/", "%", "**", "<<", ">>", "<", ">", "<=", ">=", "==", "!=", "&", "^", "|", "&&", "||", "?", ":", ","].includes(value(node, "Op"))) return undefined;
      const left = pureArithmeticVariables(child(node, "X")), right = pureArithmeticVariables(child(node, "Y"));
      return left && right ? [...left, ...right] : undefined;
    }
    case "ParenArithm": return pureArithmeticVariables(child(node, "X"));
    default: return undefined;
  }
}
