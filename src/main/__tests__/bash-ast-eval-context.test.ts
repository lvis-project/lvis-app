import { describe, expect, it } from "vitest";
import { BashAstValidator } from "../bash-ast-validator.js";

const validator = new BashAstValidator();

describe("eval lexical context", () => {
  it.each([
    "# eval $x\nprintf done",
    "printf done # eval helper",
    `printf '%s\\n' 'eval $x\\n'`,
    `command printf '%s' "eval helper"`,
    "python3 - <<'PY'\n# eval helper\nprint('done')\nPY",
  ])("allows literal data or comments: %s", (command) => {
    expect(validator.validate("bash", { command }).decision).toBe("allow");
  });

  it.each([
    "eval payload",
    `# eval explanation\nbash -c 'e""val "$x"'`,
    `# eval explanation\nprintf '%s' "$(e'val' payload)"`,
    `printf -v 'a[$(eval "printf proof")]' '%s' x`,
    "python3 - <<'PY'\n# eval explanation\nprint('done')\nPY\neval payload",
    "printf '%s' 'eval payload' | bash -s",
    "command eval payload",
    "env X=1 bash -c 'eval payload'",
    "bash -c 'eval payload'",
    "sh <<'SH'\neval payload\nSH",
    "bash <<'SH'\n# introductory comment\neval payload\nSH",
    "printf '%s' 'eval payload' | sh",
    "cat <<'SH' | command sh\neval payload\nSH",
    "printf '%s' 'eval payload' > script; bash script",
    "printf '%s' 'eval payload' | unknown_consumer",
    "unknown_consumer 'eval payload'",
    `printf '%s' "$(eval payload)"`,
    `printf '%s' "$(printf '%s' "$(eval payload)")"`,
    "cat <(eval payload)",
    "X=$(eval payload)",
    "printf '%s' 'eval payload",
    "cat <<'SH'\n# eval helper",
    "cat <<SH\n# eval helper\nSH",
    "cat <<'A' <<B\ndata\nA\n# $(eval payload)\nB",
    "bash <<< 'eval payload'",
    "( # eval helper\nprintf done",
    "{ # eval helper\nprintf done",
    "printf x\\ # literal; eval payload",
  ])("retains eval denial when execution or syntax is unresolved: %s", (command) => {
    const result = validator.validate("bash", { command });
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("eval-untrusted");
  });

  it("keeps other structural patterns strict even in data", () => {
    expect(validator.validate("bash", { command: "printf '%s' 'rm -rf /'" }).patternId).toBe("rm-rf-root");
  });

  it("preserves warning mode", () => {
    expect(new BashAstValidator({ mode: "warn" }).validate("bash", { command: "eval payload" }).decision).toBe("warn");
  });
});
