// AUTO-GENERATED — i18n migration. Source: src/main/bash-ast-validator.ts. Do not edit by hand.
export const en = {
  "be_bashAstValidator.ifsInjection": "Command separation bypass via IFS manipulation",
  "be_bashAstValidator.braceExpansion": "Dangerous command bypass via brace expansion",
  "be_bashAstValidator.subshellExec": "Dangerous command execution via subshell result",
  "be_bashAstValidator.variableExpansion": "Dangerous command execution via variable expansion",
  "be_bashAstValidator.backtickSubstitution": "Dangerous command inside backtick command substitution",
  "be_bashAstValidator.rmRfCompound": "rm -rf dangerous path inside compound command",
  "be_bashAstValidator.rmRfRoot": "rm -rf dangerous path",
  "be_bashAstValidator.curlPipeSh": "curl|sh pattern",
  "be_bashAstValidator.sudoEscalation": "Privilege escalation attempt",
  "be_bashAstValidator.evalUntrusted": "Dangerous use of eval",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_bashAstValidator.ifsInjection": "IFS 조작을 통한 명령 분리 우회",
  "be_bashAstValidator.braceExpansion": "brace expansion으로 위험 명령 우회",
  "be_bashAstValidator.subshellExec": "subshell 결과로 위험 명령 실행",
  "be_bashAstValidator.variableExpansion": "변수 확장으로 위험 명령 실행",
  "be_bashAstValidator.backtickSubstitution": "백틱 command substitution 내 위험 명령",
  "be_bashAstValidator.rmRfCompound": "복합 명령 내 rm -rf 위험 경로",
  "be_bashAstValidator.rmRfRoot": "rm -rf 위험 경로",
  "be_bashAstValidator.curlPipeSh": "curl|sh 패턴",
  "be_bashAstValidator.sudoEscalation": "권한 상승 시도",
  "be_bashAstValidator.evalUntrusted": "eval 위험 사용",
};
