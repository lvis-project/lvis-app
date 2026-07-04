import { t } from "../i18n/index.js";
import { tokenizeShell } from "./shell-tokenizer.js";





export type ValidationDecision = "allow" | "warn" | "deny";

export interface ValidationResult {
  decision: ValidationDecision;
  reason?: string;
  patternId?: string;
}

export interface BashAstValidatorOptions {

  mode?: "warn" | "deny";
}

export class BashAstValidator {
  constructor(private readonly opts: BashAstValidatorOptions = {}) {}




  validate(toolName: string, input: Record<string, unknown>): ValidationResult {
    if (!this._isBashTool(toolName)) return { decision: "allow" };

    const command = this._extractCommand(input);
    if (!command) return { decision: "allow" };

    // Pattern ordering matters — first match wins. The bypass patterns
    // (variable-expansion, ifs-injection, brace-expansion, subshell-exec,
    // rm-rf-compound, backtick-substitution) are intentionally evaluated
    // BEFORE the simpler rm-rf-root pattern so that commands hidden inside
    // compound/backtick/expansion shells are attributed to the correct
    // bypass id rather than rm-rf-root.
    const dangerousRmTarget = String.raw`(?:(?:['"]?/{1,}['"]?)|(?:['"]?~/?['"]?)|(?:['"]?\$HOME/?['"]?)|(?:['"]?\*['"]?))`;
    const commandBoundary = String.raw`(?=$|[\s;&|])`;
    const patterns: Array<{ id: string; regex: RegExp; reason: string }> = [
      {
        id: "ifs-command-injection",

        regex: /\$\{?IFS\}?/i,
        reason: t("be_bashAstValidator.ifsInjection"),
      },
      {
        id: "brace-expansion-exec",

        regex: /\b\w\{[^}]*\}\s+-[rfRF]/,
        reason: t("be_bashAstValidator.braceExpansion"),
      },
      {
        id: "subshell-command-exec",

        regex: new RegExp(String.raw`\$\([^)]+\)\s+-[rfRF]+\s+${dangerousRmTarget}${commandBoundary}`, "i"),
        reason: t("be_bashAstValidator.subshellExec"),
      },
      {
        id: "variable-expansion-exec",
        // e.g. `X=rm; $X -rf /`, `${CMD} -rf ~`, `$FOO -Rf $HOME`
        // 중괄호 형태 `${VAR}`와 단순 `$VAR` 모두 캡처
        regex: new RegExp(String.raw`\$\{?\w+\}?\s+-[rfRF]+\s+${dangerousRmTarget}${commandBoundary}`, "i"),
        reason: t("be_bashAstValidator.variableExpansion"),
      },
      {
        id: "backtick-command-substitution",
        // `...` command substitution that contains a dangerous inner command
        regex: /`[^`]*\b(rm\s+-[rfRF]|curl[^`]*\|\s*sh|sudo|eval)/i,
        reason: t("be_bashAstValidator.backtickSubstitution"),
      },
      {
        id: "rm-rf-compound",

        // Does NOT use ^ so that a bare "rm -rf /" falls through to rm-rf-root.
        regex: new RegExp(String.raw`[;&|\n]\s*rm\s+(?:-[rfRF]+\s+)+${dangerousRmTarget}${commandBoundary}`, "i"),
        reason: t("be_bashAstValidator.rmRfCompound"),
      },
      {
        id: "rm-rf-root",
        regex: new RegExp(String.raw`\brm\s+(?:-[rfRF]+\s+)+${dangerousRmTarget}${commandBoundary}`, "i"),
        reason: t("be_bashAstValidator.rmRfRoot"),
      },
      {
        id: "curl-pipe-sh",
        regex: /\b(curl|wget|fetch)\b[^|]*\|\s*(sh|bash|zsh|fish)/i,
        reason: t("be_bashAstValidator.curlPipeSh"),
      },
      {
        id: "sudo-escalation",
        regex: /\b(sudo|su|doas)\b/i,
        reason: t("be_bashAstValidator.sudoEscalation"),
      },
      {
        id: "fork-bomb",
        regex: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/i,
        reason: "fork bomb",
      },
      {
        id: "eval-untrusted",
        regex: /\beval\s+\$?\{?[^}]*\}?/i,
        reason: t("be_bashAstValidator.evalUntrusted"),
      },
      {
        id: "tty-injection",
        regex: /echo\s+-[ne]+\s+["'].*\\033/i,
        reason: "TTY escape injection",
      },
      {
        id: "subst-pipe-shell",
        regex: /\$\([^)]+\)\s*\|\s*(sh|bash)/i,
        reason: "command substitution → shell pipe",
      },
    ];

    for (const p of patterns) {
      if (p.regex.test(command)) {
        return {
          decision: this.opts.mode === "warn" ? "warn" : "deny",
          reason: p.reason,
          patternId: p.id,
        };
      }
    }

    // Additional leaf-aware guard using the shared tokenizer. Runs AFTER the
    // regex patterns so their patternId attribution is unchanged; it only adds
    // denies the raw-regex boundary could miss (e.g. a quoted separator hiding
    // an `rm -rf /` leaf). Never relaxes an existing deny.
    const leafGuard = this._detectDangerousRmLeaf(command);
    if (leafGuard) {
      return {
        decision: this.opts.mode === "warn" ? "warn" : "deny",
        reason: leafGuard.reason,
        patternId: leafGuard.patternId,
      };
    }

    return { decision: "allow" };
  }

  /**
   * Tokenizer-based detection of an `rm -rf <dangerous-path>` leaf anywhere in a
   * compound command. Uses the shared {@link tokenizeShell} leaf definition so a
   * quote-aware split identifies the leaf the raw regex might miss. Returns null
   * when no such leaf is found (or on a parse error — the regex patterns and the
   * host risk inspector already fail closed on unparseable input, so this
   * additive layer stays silent rather than double-attributing).
   */
  private _detectDangerousRmLeaf(
    command: string,
  ): { reason: string; patternId: string } | null {
    const { leaves, parseError } = tokenizeShell(command);
    if (parseError) return null;
    for (const leaf of leaves) {
      const argv = leaf.argv;
      if (argv.length === 0) continue;
      const verb = this._basename(argv[0]!);
      if (verb !== "rm") continue;
      const flags = argv.slice(1);
      const recursiveForce = flags.some((f) => /^-[a-zA-Z]*r[a-zA-Z]*$/i.test(f))
        && flags.some((f) => /^-[a-zA-Z]*f[a-zA-Z]*$/i.test(f));
      if (!recursiveForce) continue;
      const target = flags.find((f) => !f.startsWith("-"));
      if (target !== undefined && this._isDangerousRmTarget(target)) {
        return { reason: t("be_bashAstValidator.rmRfCompound"), patternId: "rm-rf-compound" };
      }
    }
    return null;
  }

  /** Reduce `/bin/rm` → `rm`; leave bare verbs unchanged. */
  private _basename(token: string): string {
    const slash = token.lastIndexOf("/");
    return slash >= 0 ? token.slice(slash + 1) : token;
  }

  /** True for the dangerous `rm` targets the regex patterns also treat as
   * catastrophic: `/`, `~`/`~/`, `$HOME`, `*`. */
  private _isDangerousRmTarget(target: string): boolean {
    return /^\/+$/.test(target)
      || /^~\/?$/.test(target)
      || /^\$HOME\/?$/.test(target)
      || target === "*";
  }

  private _isBashTool(toolName: string): boolean {
    return /^(bash|shell|exec|run_command|terminal)/i.test(toolName);
  }

  private _extractCommand(input: Record<string, unknown>): string | null {
    if (typeof input.command === "string") return input.command;
    if (typeof input.script === "string") return input.script;
    if (typeof input.cmd === "string") return input.cmd;
    return null;
  }
}
