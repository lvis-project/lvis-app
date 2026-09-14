import { analyzeShell, type ShellRedirect, type ShellStatement, type ShellWord } from "./shell-analysis.js";
import { commandLeaf, effectiveShellCommand, type ShellLeaf } from "./shell-effective-command.js";
export { stripCommandPath, type ShellLeaf } from "./shell-effective-command.js";

export interface TokenizeResult { leaves: ShellLeaf[]; parseError: boolean }

/** Conservative risk projection of canonical syntax; authority uses the state walker. */
export function tokenizeShell(command: string): TokenizeResult {
  const analysis = analyzeShell(command);
  if (!analysis.ok) return { leaves: [], parseError: true };
  const leaves: ShellLeaf[] = [];
  let parseError = false;
  const word = (value: ShellWord): void => {
    for (const part of value.parts) {
      if (part.kind === "substitution") visit(part.body);
      if (part.kind === "parameter-choice") word(part.operand);
      if (part.kind === "unknown") parseError = true;
    }
  };
  const redirectWords = (redirects: readonly ShellRedirect[]): void => {
    for (const redirect of redirects) {
      if (redirect.target) word(redirect.target);
      if (redirect.data) word(redirect.data);
    }
  };
  const visit = (statement: ShellStatement): void => {
    switch (statement.kind) {
      case "command": {
        const effective = effectiveShellCommand(statement);
        if (effective.unsupported) parseError = true;
        const leaf = commandLeaf(statement, effective);
        leaves.push(leaf);
        statement.words.forEach(word);
        statement.assignments.forEach((assignment) => { word(assignment.value); assignment.elements?.forEach(word); });
        redirectWords(statement.redirects);
        return;
      }
      case "redirected":
        // Only the risk projection needs this redirection-only leaf. The
        // execution walker retains the compound owner and its opening scope.
        leaves.push(commandLeaf({ kind: "command", source: statement.source, words: [], assignments: [],
          assignmentScope: "current", redirects: statement.redirects }));
        redirectWords(statement.redirects);
        visit(statement.body); return;
      case "sequence": statement.statements.forEach(visit); return;
      case "and": case "or": visit(statement.left); visit(statement.right); return;
      case "if":
        visit(statement.condition); visit(statement.consequent); visit(statement.alternate); return;
      case "for":
        statement.values?.forEach(word); visit(statement.body); return;
      case "while":
        visit(statement.condition); visit(statement.body); return;
      case "subshell": case "background": case "negate":
        visit(statement.body); return;
      case "pipeline":
        statement.statements.forEach(visit); return;
      case "function": case "unsupported": parseError = true; return;
    }
  };
  visit(analysis.program);
  return { leaves: parseError ? [] : leaves, parseError };
}
