/** Documented option arity separates data, path and program values. */
type ArgumentRole = "data" | "path" | "program";

const OPTION_OPERANDS: ReadonlyMap<string, readonly ArgumentRole[]> = new Map([
  ["cmd", ["program"]],
  ["init", ["path"]],
  ...["separator", "newline", "nullvalue", "escape", "heap", "mmap", "maxsize", "nonce", "vfs"]
    .map((name): [string, readonly ArgumentRole[]] => [name, ["data"]]),
  ["lookaside", ["data", "data"]],
  ["pagecache", ["data", "data"]],
  ...[
    "append", "ascii", "bail", "batch", "box", "column", "csv", "deserialize",
    "echo", "header", "noheader", "help", "html", "ifexists", "interactive", "json",
    "line", "list", "markdown", "memtrace", "nofollow", "no-rowid-in-view",
    "pcachetrace", "quote", "readonly", "safe", "stats", "table", "tabs",
    "unsafe-testing", "version", "vfstrace", "zip", "utf8", "no-utf8",
  ].map((name): [string, readonly ArgumentRole[]] => [name, []]),
]);

const DATA_DOT_COMMANDS = new Set([
  "auth", "bail", "changes", "connection", "crlf", "databases", "dbconfig", "dbinfo",
  "dbtotxt", "dump", "echo", "eqp", "exit", "expert", "explain", "fullschema", "headers",
  "help", "indexes", "limit", "mode", "nullvalue", "print", "progress", "prompt", "quit",
  "scanstats", "schema", "separator", "show", "stats", "tables", "timeout", "timer", "version",
]);
const SQL_STARTERS = new Set([
  "alter", "analyze", "attach", "begin", "commit", "create", "delete", "detach", "drop",
  "end", "explain", "insert", "pragma", "reindex", "release", "replace", "rollback",
  "savepoint", "select", "update", "vacuum", "values", "with",
]);
const FILE_FUNCTIONS = new Set(["readfile", "writefile", "realpath"]);
const DYNAMIC_FUNCTIONS = new Set(["edit", "eval", "load_extension", "fts3_tokenizer", "zipfile", "zipfile_cds"]);
const FILE_TABLES = new Set(["fsdir", "zipfile", "csv"]);
const ALTERNATE_OPEN_MODES = new Set(["deserialize", "append", "zip"]);

interface SqlToken {
  kind: "word" | "string" | "identifier" | "symbol";
  value: string;
}

/** Scan lexical tokens, including quoted names, without interpreting SQL data as code. */
function sqlTokens(program: string): SqlToken[] | null {
  const tokens: SqlToken[] = [];
  for (let i = 0; i < program.length;) {
    const char = program[i]!;
    if (/\s/.test(char)) { i += 1; continue; }
    if (program.startsWith("--", i)) {
      const end = program.indexOf("\n", i + 2);
      i = end < 0 ? program.length : end + 1;
      continue;
    }
    if (program.startsWith("/*", i)) {
      const end = program.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (["'", '"', "`", "["].includes(char)) {
      const close = char === "[" ? "]" : char;
      let value = "", closed = false;
      for (i += 1; i < program.length; i += 1) {
        if (program[i] !== close) { value += program[i]; continue; }
        if (close !== "]" && program[i + 1] === close) { value += close; i += 1; continue; }
        i += 1; closed = true; break;
      }
      if (!closed) return null;
      tokens.push({ kind: char === "'" ? "string" : "identifier", value });
      continue;
    }
    const word = /^[A-Za-z_\u0080-\uffff][A-Za-z_0-9$\u0080-\uffff]*/.exec(program.slice(i));
    if (word) { tokens.push({ kind: "word", value: word[0] }); i += word[0].length; continue; }
    tokens.push({ kind: "symbol", value: char }); i += 1;
  }
  return tokens;
}

/** Relation names accept strings as identifiers. Resolve that role from SQL
 * structure before applying a lexical string-data exemption. Parentheses in
 * expressions and subqueries do not give their literals a relation-name role.
 */
function sqlRelationNames(tokens: readonly SqlToken[]): ReadonlySet<number> | null {
  const names = new Set<number>();
  const closes = new Map<number, number>();
  const stack: number[] = [];
  const symbol = (index: number, value: string) => tokens[index]?.kind === "symbol" && tokens[index]?.value === value;
  const keyword = (index: number, ...values: string[]) => tokens[index]?.kind === "word" && values.includes(tokens[index]!.value.toLowerCase());
  const name = (index: number) => tokens[index] !== undefined && tokens[index]!.kind !== "symbol";
  for (let i = 0; i < tokens.length; i += 1) {
    if (symbol(i, "(")) stack.push(i);
    if (symbol(i, ")")) {
      const open = stack.pop();
      if (open === undefined) return null;
      closes.set(open, i);
    }
  }
  if (stack.length) return null;

  const sources: { start: number; end: number }[] = [];
  const relation = (start: number, end: number): number => {
    if (symbol(start, "(")) {
      const close = closes.get(start)!;
      if (!keyword(start + 1, "select", "with", "values")) sources.push({ start: start + 1, end: close });
      return close + 1;
    }
    if (!name(start) || start >= end) return start + 1;
    let target = start;
    while (target + 2 < end && symbol(target + 1, ".") && name(target + 2)) target += 2;
    names.add(target);
    // Table-valued arguments contain expressions, not another source list.
    return symbol(target + 1, "(") ? closes.get(target + 1)! + 1 : target + 1;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    if (keyword(i, "from") && !(keyword(i - 1, "distinct")
      && (keyword(i - 2, "is") || (keyword(i - 2, "not") && keyword(i - 3, "is"))))) {
      sources.push({ start: i + 1, end: tokens.length });
    }
    // An unparenthesized right side of IN is a table name, optionally followed
    // by table-valued arguments. IN (...) instead contains expressions/query.
    if (keyword(i, "in") && !symbol(i + 1, "(")) relation(i + 1, tokens.length);
    if (keyword(i, "update")) relation(keyword(i + 1, "or") ? i + 3 : i + 1, tokens.length);
    if (keyword(i, "into") && (keyword(i - 1, "insert", "replace")
      || (keyword(i - 2, "or") && keyword(i - 3, "insert")))) relation(i + 1, tokens.length);
  }
  // A worklist avoids recursive stack growth for nested source groups.
  const visited = new Set<number>();
  for (let source = 0; source < sources.length; source += 1) {
    const { start, end } = sources[source]!;
    if (visited.has(start)) continue;
    visited.add(start);
    for (let i = relation(start, end); i < end;) {
      if (symbol(i, ")") || symbol(i, ";")
        || keyword(i, "where", "group", "having", "order", "limit", "union", "except", "intersect", "returning", "set")
        || (keyword(i, "window") && keyword(i + 2, "as") && symbol(i + 3, "("))) break;
      if (symbol(i, ",") || keyword(i, "join")) i = relation(i + 1, end);
      else if (symbol(i, "(")) i = closes.get(i)! + 1;
      else i += 1;
    }
  }
  return names;
}

/** Dot-command quoting is separate from SQL and from the invoking shell. */
function dotArguments(program: string): string[] | null {
  // Escaped double-quoted strings require a byte-oriented C escape contract.
  // Refuse that form instead of checking an incorrectly decoded filename.
  if (/[\r\n]/.test(program)) return null;
  const args: string[] = [];
  for (let i = 1; i < program.length;) {
    if (/\s/.test(program[i]!)) { i += 1; continue; }
    const quote = ["'", '"'].includes(program[i]!) ? program[i++] : undefined;
    let value = "";
    while (i < program.length && (quote ? program[i] !== quote : !/\s/.test(program[i]!))) {
      if (quote === '"' && program[i] === "\\") return null;
      value += program[i++];
    }
    if (quote && program[i++] !== quote) return null;
    if (i < program.length && !/\s/.test(program[i]!)) return null;
    args.push(value);
  }
  return args;
}

export function classifySqliteArgumentSlots(argv: readonly string[]) {
  const nonPathIndices = new Set<number>();
  const programIndices = new Set<number>();
  const extraCandidates: { value: string; index: number }[] = [];
  const nestedCommands: { value: string; index: number }[] = [];
  let dynamicExecution: string | null = null;
  const unresolved = (detail: string) => { dynamicExecution ??= `unresolved sqlite3 ${detail}`; };

  const path = (value: string, index: number, database = false) => {
    if (database) {
      if (/^~[\\/]/.test(value)) { unresolved("conditional home-directory filename"); return; }
      if (value === "" || value === ":memory:") return;
      if (value.startsWith("file:")) {
        let filename = value.slice(5).split(/[?#]/, 1)[0]!;
        if (filename.startsWith("//")) {
          const authority = /^\/\/([^/]*)(\/.*)?$/.exec(filename)!;
          if (authority[1] !== "" && authority[1] !== "localhost") { unresolved("database URI authority"); return; }
          filename = authority[2] ?? "";
        }
        try { value = decodeURIComponent(filename); }
        catch { unresolved("database URI encoding"); return; }
        if (value === "" || value === ":memory:") return;
      }
    }
    if (value.includes("\0")) { unresolved("filename bytes"); return; }
    extraCandidates.push({ value, index });
  };

  const sql = (program: string, index: number) => {
    const tokens = sqlTokens(program);
    if (!tokens) { unresolved("program syntax"); return; }
    const first = tokens.find((token) => !(token.kind === "symbol" && token.value === ";"));
    if (!first) return;
    // Some interfaces also accept script filenames. Do not exempt an opaque
    // filename or guess whether the filesystem makes a script positional.
    if (first.kind !== "word" || !SQL_STARTERS.has(first.value.toLowerCase())
      || /\.(?:sql|txt)$/i.test(program)) { unresolved("program or script-file operand"); return; }
    const relationNames = sqlRelationNames(tokens);
    if (!relationNames) { unresolved("program syntax"); return; }
    const literalPath = (at: number, end: readonly string[], database: boolean) => {
      const token = tokens[at], next = tokens[at + 1];
      // Quoted identifiers can resolve to column values; only single-quoted
      // literals followed by the expression boundary establish a filename.
      if (token?.kind !== "string" || (next && !end.includes(next.value.toLowerCase()))) {
        unresolved("computed file operand"); return;
      }
      path(token.value, index, database);
    };
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!, name = token.value.toLowerCase();
      const call = tokens[i + 1]?.kind === "symbol" && tokens[i + 1]?.value === "(";
      if (call && FILE_FUNCTIONS.has(name)) literalPath(i + 2, [",", ")"], false);
      if (call && DYNAMIC_FUNCTIONS.has(name)) unresolved("dynamic program or archive function");
      if (FILE_TABLES.has(name) && (call || relationNames.has(i))) unresolved("filesystem table effects");
      if (token.kind !== "word") continue;
      if (name === "virtual" && tokens[i + 1]?.value.toLowerCase() === "table") unresolved("virtual-table module effects");
      let start = i - 1;
      if (tokens[start]?.value.toLowerCase() === "explain") start -= 1;
      else if (tokens[start]?.value.toLowerCase() === "plan" && tokens[start - 1]?.value.toLowerCase() === "query"
        && tokens[start - 2]?.value.toLowerCase() === "explain") start -= 3;
      if (start >= 0 && !(tokens[start]?.kind === "symbol" && tokens[start]?.value === ";")) continue;
      if (name === "attach") literalPath(i + (tokens[i + 1]?.kind === "word" && tokens[i + 1]?.value.toLowerCase() === "database" ? 2 : 1), ["as"], true);
      if (name === "vacuum") {
        let at = i + 1;
        if (tokens[at]?.value.toLowerCase() !== "into") at += 1;
        if (tokens[at]?.value.toLowerCase() === "into") literalPath(at + 1, [";"], true);
      }
      if (name === "pragma") {
        let at = i + 1;
        if (tokens[at + 1]?.value === ".") at += 2;
        if (["temp_store_directory", "data_store_directory"].includes(tokens[at]?.value.toLowerCase() ?? "")
          && ["=", "("].includes(tokens[at + 1]?.value ?? "")) literalPath(at + 2, [";", ")"], false);
      }
    }
  };

  const program = (value: string, index: number) => {
    programIndices.add(index);
    if (!value.startsWith(".")) { sql(value, index); return; }
    const args = dotArguments(value);
    if (!args?.length) { unresolved("dot-command syntax"); return; }
    const [name, ...operands] = args;
    if (DATA_DOT_COMMANDS.has(name!)) return;
    if (["shell", "system"].includes(name!)) {
      if (!operands.length) { unresolved("empty embedded command"); return; }
      // The CLI wraps arguments containing a space in double quotes, without
      // further escaping, and joins them before passing the line to system().
      if (process.platform === "win32") unresolved("embedded command dialect");
      nestedCommands.push({ value: operands.map((operand) => operand.includes(" ") ? `"${operand}"` : operand).join(" "), index });
      return;
    }
    if (["read", "output", "once", "log"].includes(name!)) {
      if (operands.length > 1 || (name === "read" && operands.length !== 1)) { unresolved("dot-command arity"); return; }
      const file = operands[0];
      if (file === undefined) return;
      if (file.startsWith("|")) {
        // Pipe input/output can become another program. The argv role contract
        // cannot establish the stream consumed by that child command.
        unresolved("command pipe effects");
      } else if (file.startsWith("-")) unresolved("output helper option");
      else if (!["stdout", "stderr", "off"].includes(file) || name === "read") path(file, index);
      return;
    }
    if (["backup", "restore", "save", "clone"].includes(name!)) {
      const first = name === "clone";
      if (!operands.length || operands.length > (name === "clone" ? 1 : 2)
        || operands.some((operand) => operand.startsWith("-"))) { unresolved("dot-command file options"); return; }
      path(first ? operands[0]! : operands.at(-1)!, index, true);
      return;
    }
    if (name === "open") {
      const files: string[] = [];
      let alternateMode = false;
      for (const operand of operands) {
        if (ALTERNATE_OPEN_MODES.has(operand.replace(/^--?/, ""))) alternateMode = true;
        if (["new", "readonly", "ifexists", "nofollow", "deserialize", "append", "zip"].some((option) => operand === `-${option}` || operand === `--${option}`)) continue;
        if (operand.startsWith("-")) { unresolved("open option"); return; }
        files.push(operand);
      }
      if (files.length > 1) unresolved("open arity");
      else if (alternateMode && files[0]?.startsWith("file:")) unresolved("database URI in alternate open mode");
      else if (files[0] !== undefined) {
        if (/^~[\\/]/.test(files[0])) unresolved("conditional home-directory filename");
        else path(files[0], index, !alternateMode);
      }
      return;
    }
    // Abbreviations, cwd changes, archive operations, parameter expressions and
    // other unmodelled dot-commands cannot inherit data-only roles.
    unresolved("dot-command effects");
  };

  let databaseIndex: number | undefined, optionsEnded = false, alternateMode = false;
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i]!;
    nonPathIndices.add(i);
    if (!optionsEnded && value === "--") { optionsEnded = true; continue; }
    if (!optionsEnded && value.startsWith("-")) {
      // Single and double leading hyphens are documented. Equals, glued values,
      // clusters, abbreviations and forwarding forms have no inferred arity.
      const name = value.replace(/^--?/, "");
      const roles = OPTION_OPERANDS.get(name);
      if (!roles || i + roles.length >= argv.length) { unresolved("option or option arity"); break; }
      if (ALTERNATE_OPEN_MODES.has(name)) alternateMode = true;
      for (const role of roles) {
        const operand = argv[++i]!;
        nonPathIndices.add(i);
        if (role === "path") path(operand, i);
        if (role === "program") program(operand, i);
      }
    } else if (databaseIndex === undefined) {
      databaseIndex = i;
    } else program(value, i);
  }
  if (databaseIndex !== undefined) {
    const database = argv[databaseIndex]!;
    // Positional script-file detection can depend on contents and availability,
    // leaving later positionals in an unknown database/program role. Explicit
    // -init and .read retain their unambiguous program-file contract.
    if (/\.(?:sql|txt)$/i.test(database)) unresolved("positional script-file role");
    // Alternate open modes may read raw filename bytes before URI parsing.
    // Their file: interpretation is not the ordinary database-open contract.
    if (alternateMode && database.startsWith("file:")) unresolved("database URI in alternate open mode");
    else if (/^~[\\/]/.test(database)) unresolved("conditional home-directory filename");
    else path(database, databaseIndex, !alternateMode);
  }
  return { nonPathIndices, programIndices, extraCandidates, nestedCommands, dynamicExecution };
}
