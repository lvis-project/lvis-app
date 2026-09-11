import { resolve as resolvePath } from "node:path";
import { t } from "../i18n/index.js";
import { staticShellWord, type ShellWord } from "../shared/shell-analysis.js";
import { extractShellCommands } from "../shared/shell-command-fields.js";
import { effectiveShellCommand, stripCommandPath } from "../shared/shell-effective-command.js";
import { inspectShellExecution, ShellExecutionError, type ShellExecutionFacts } from "../shared/shell-execution.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { inspectEmbeddedShellPrograms } from "../tools/shell-path-policy.js";

export type ValidationDecision = "allow" | "warn" | "deny";
export interface BashAstValidationResult {
  decision: ValidationDecision;
  reason?: string;
  patternId?: string;
  operand?: string;
}
export interface BashAstValidatorOptions { mode?: "warn" | "deny" }
class StructuralShellError extends Error {
  constructor(readonly patternId: string, message: string, readonly operand?: string) { super(message); }
}

/** Structural rules consume the same executed-command and word facts as paths. */
export class BashAstValidator {
  constructor(private readonly opts: BashAstValidatorOptions = {}) {}

  validate(toolName: string, input: Record<string, unknown>, context?: { cwd: string; facts: ShellExecutionFacts }): BashAstValidationResult {
    // Broad name coverage remains distinct from canonical builtin identity.
    if (!/^(bash|shell|exec|run_command|terminal)/i.test(toolName)) return { decision: "allow" };
    const cwd = resolvePath(context?.cwd ?? process.cwd(), typeof input.cwd === "string" ? input.cwd : ".");
    const facts = context?.facts ?? { dialect: "bash", environment: buildSafeChildEnv() };
    const refuse = (patternId: string, message: string, word?: ShellWord): never => {
      throw new StructuralShellError(patternId, message, word?.source.raw);
    };
    try {
      for (const command of extractShellCommands(input)) {
        inspectShellExecution(command, cwd, facts, {
          path() {}, // This stage owns structure; the independent path gate owns authority.
          word(word) {
            if (word.parts.some((part) => part.kind === "parameter" && part.name === "IFS")) {
              refuse("ifs-command-injection", t("be_bashAstValidator.ifsInjection"), word);
            }
            if (word.parts.some((part) => part.kind === "unknown" && part.reason === "Unsupported brace expansion")) {
              refuse("brace-expansion-exec", t("be_bashAstValidator.braceExpansion"), word);
            }
          },
          command(event) {
            const { argv, effective } = event;
            const verb = stripCommandPath(argv[0]!);
            const first = effective.words[0];
            if (event.recursiveFunction) refuse("fork-bomb", "Recursive shell function execution is unsupported", first);
            if (event.functionCall) return;
            if (["sudo", "su", "doas"].includes(verb)) refuse("sudo-escalation", t("be_bashAstValidator.sudoEscalation"), first);
            if (verb === "eval") refuse("eval-untrusted", t("be_bashAstValidator.evalUntrusted"), first);
            if (verb === "rm") {
              const flags: string[] = [];
              const targets: number[] = [];
              let ended = false;
              argv.slice(1).forEach((argument, index) => {
                if (!ended && argument === "--") { ended = true; return; }
                if (!ended && argument?.startsWith("-")) flags.push(argument);
                else targets.push(index + 1);
              });
              const recursive = flags.some((flag) => flag === "--recursive" || /^-[A-Za-z]*[rR]/.test(flag));
              const force = flags.some((flag) => flag === "--force" || /^-[A-Za-z]*f/.test(flag));
              const dangerous = targets.find((index) => {
                const target = argv[index];
                const word = effective.words[index]!;
                return target !== undefined && /^\/+$/u.test(target)
                  || target !== undefined && event.environment.HOME !== undefined && resolvePath(event.cwd ?? cwd, target) === resolvePath(event.environment.HOME)
                  || word.parts.some((part) => part.kind === "pattern" && part.value === "*");
              });
              if (recursive && force && (dangerous !== undefined || event.backquote)) {
                const origin = event.original.words.find((word) => word.source.start === first?.source.start);
                const indirect = origin?.parts.some((part) => part.kind === "parameter");
                const id = event.backquote ? "backtick-command-substitution" : indirect ? "variable-expansion-exec"
                  : event.original.source.start === 0 ? "rm-rf-root" : "rm-rf-compound";
                refuse(id, t("be_bashAstValidator.rmRfRoot"), dangerous === undefined ? first : effective.words[dangerous]);
              }
            }
            if (verb === "echo" && argv.slice(1).some((argument) => argument !== undefined && /^-[ne]+$/.test(argument))
              && argv.slice(1).some((argument) => argument?.includes("\\033") || argument?.includes("\u001b"))) {
              refuse("tty-injection", "TTY escape injection", first);
            }
            if (event.fromPipe && ["sh", "bash", "dash", "zsh", "ksh", "fish"].includes(verb)
              && !argv.some((argument) => argument === "-c" || /^-[A-Za-z]*c/.test(argument ?? ""))) {
              const download = event.pipeline?.some((statement) => {
                if (statement.kind !== "command") return false;
                const firstWord = effectiveShellCommand(statement).words[0];
                return firstWord !== undefined && ["curl", "wget", "fetch"].includes(stripCommandPath(staticShellWord(firstWord) ?? ""));
              });
              refuse(download ? "curl-pipe-sh" : "subst-pipe-shell", t("be_bashAstValidator.curlPipeSh"), first);
            }
            inspectEmbeddedShellPrograms(event);
          },
        });
      }
      return { decision: "allow" };
    } catch (error) {
      if (!(error instanceof StructuralShellError) && !(error instanceof ShellExecutionError)) throw error;
      return { decision: this.opts.mode === "warn" ? "warn" : "deny", reason: error.message,
        patternId: error instanceof StructuralShellError ? error.patternId : "shell-analysis", ...(error.operand ? { operand: error.operand } : {}) };
    }
  }
}
