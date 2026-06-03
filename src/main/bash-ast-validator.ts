import { t } from "../i18n/index.js";

/**
 * Bash AST Pre-Validator — LVIS local shell safety policy
 *
 * tool-executor.ts Step 2.5에서 호출되며, Bash 계열 도구 호출 시 인자를
 * 간이 패턴 분석하여 위험 패턴을 탐지. 13개 패턴을 차단:
 *   1. rm -rf / (또는 ~/, $HOME, *)
 *   2. curl/wget | sh (or bash)
 *   3. sudo / su / doas 권한 상승
 *   4. fork bomb (:(){:|:&};:)
 *   5. eval $... untrusted
 *   6. TTY injection (echo -ne ...\\033)
 *   7. command substitution piped to shell ($(...) | bash)
 *   8. variable-expansion-exec — `X=rm; $X -rf /` / `${CMD} -rf /` 우회
 *   9. rm-rf-compound — `echo hi && rm -rf /` 복합 명령 우회
 *  10. backtick-command-substitution — `` `rm -rf /home` `` 우회
 *  11. ifs-command-injection — `r${IFS}m -rf /` IFS 조작 우회
 *  12. brace-expansion-exec — `r{m} -rf /` brace expansion 우회
 *  13. subshell-command-exec — `$(echo rm) -rf /` subshell 우회
 */

export type ValidationDecision = "allow" | "warn" | "deny";

export interface ValidationResult {
  decision: ValidationDecision;
  reason?: string;
  patternId?: string;
}

export interface BashAstValidatorOptions {
  /** "warn"이면 경고만, "deny"면 실행 차단. 기본 "deny" */
  mode?: "warn" | "deny";
}

export class BashAstValidator {
  constructor(private readonly opts: BashAstValidatorOptions = {}) {}

  /**
   * Bash 계열 도구 호출 시 인자 검증.
   * Bash 도구가 아닌 경우 즉시 allow.
   */
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
        // e.g. `r${IFS}m -rf /`, `$IFS`, `${IFS}` — IFS 조작을 통한 명령 분리
        regex: /\$\{?IFS\}?/i,
        reason: t("be_bashAstValidator.ifsInjection"),
      },
      {
        id: "brace-expansion-exec",
        // e.g. `r{m} -rf /`, `rm{,} -rf /` — brace expansion으로 rm 토큰 우회
        regex: /\b\w\{[^}]*\}\s+-[rfRF]/,
        reason: t("be_bashAstValidator.braceExpansion"),
      },
      {
        id: "subshell-command-exec",
        // e.g. `$(echo rm) -rf /` — subshell 결과로 위험 명령 실행
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
        // rm -rf preceded by ; && || | or newline (복합 명령 내 실행)
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

    return { decision: "allow" };
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
