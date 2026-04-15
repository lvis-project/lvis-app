/**
 * Bash AST Pre-Validator — ccleaks utils/bash/ 패턴 차용
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
    const patterns: Array<{ id: string; regex: RegExp; reason: string }> = [
      {
        id: "ifs-command-injection",
        // e.g. `r${IFS}m -rf /`, `$IFS`, `${IFS}` — IFS 조작을 통한 명령 분리
        regex: /\$\{?IFS\}?/i,
        reason: "IFS 조작을 통한 명령 분리 우회",
      },
      {
        id: "brace-expansion-exec",
        // e.g. `r{m} -rf /`, `rm{,} -rf /` — brace expansion으로 rm 토큰 우회
        regex: /\b\w\{[^}]*\}\s+-[rfRF]/,
        reason: "brace expansion으로 위험 명령 우회",
      },
      {
        id: "subshell-command-exec",
        // e.g. `$(echo rm) -rf /` — subshell 결과로 위험 명령 실행
        regex: /\$\([^)]+\)\s+-[rfRF]+\s+(\/|~|\$HOME|\*)/,
        reason: "subshell 결과로 위험 명령 실행",
      },
      {
        id: "variable-expansion-exec",
        // e.g. `X=rm; $X -rf /`, `${CMD} -rf ~`, `$FOO -Rf $HOME`
        // 중괄호 형태 `${VAR}`와 단순 `$VAR` 모두 캡처
        regex: /\$\{?\w+\}?\s+-[rfRF]+\s+(\/|~|\$HOME|\*)/,
        reason: "변수 확장으로 위험 명령 실행",
      },
      {
        id: "backtick-command-substitution",
        // `...` command substitution that contains a dangerous inner command
        regex: /`[^`]*\b(rm\s+-[rfRF]|curl[^`]*\|\s*sh|sudo|eval)/i,
        reason: "백틱 command substitution 내 위험 명령",
      },
      {
        id: "rm-rf-compound",
        // rm -rf preceded by ; && || | or newline (복합 명령 내 실행)
        // Does NOT use ^ so that a bare "rm -rf /" falls through to rm-rf-root.
        regex: /[;&|\n]\s*rm\s+(-[rfRF]+\s+)+(\/|~|\$HOME|\*)/i,
        reason: "복합 명령 내 rm -rf 위험 경로",
      },
      {
        id: "rm-rf-root",
        regex: /\brm\s+(-[rfRF]+\s+)+(\/|~|\$HOME|\*)/i,
        reason: "rm -rf 위험 경로",
      },
      {
        id: "curl-pipe-sh",
        regex: /\b(curl|wget|fetch)\b[^|]*\|\s*(sh|bash|zsh|fish)/i,
        reason: "curl|sh 패턴",
      },
      {
        id: "sudo-escalation",
        regex: /\b(sudo|su|doas)\b/i,
        reason: "권한 상승 시도",
      },
      {
        id: "fork-bomb",
        regex: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/i,
        reason: "fork bomb",
      },
      {
        id: "eval-untrusted",
        regex: /\beval\s+\$?\{?[^}]*\}?/i,
        reason: "eval 위험 사용",
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
