import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { isReadOnlyCommand } from "../../permissions/reviewer/host-risk-inspector.js";
import { BashAstValidator } from "../bash-ast-validator.js";

const validator = new BashAstValidator();
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "shell-structural-"));
  for (const name of ["work", "work directory", "eval location"]) mkdirSync(join(cwd, name));
});
afterEach(async () => { await cleanupTmpDir(cwd); });
const validate = (command: string) => validator.validate("bash", { command }, {
  cwd, facts: { dialect: "bash", environment: { HOME: cwd, PWD: cwd, PATH: "/usr/bin:/bin" } },
});

describe("structural execution and data roles", () => {
  it.each([
    "# eval $x\nprintf done",
    "printf done # eval helper",
    "printf '%s\\n' 'eval $x\\n'",
    "command printf '%s' \"eval helper\"",
    "python3 - <<'PY'\n# eval helper\nprint('done')\nPY"
  ])("preserves literal data without assigning shell execution: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("allow");
  });

  it.each([
    "eval payload",
    "# eval explanation\nbash -c 'e\"\"val \"$x\"'",
    "# eval explanation\nprintf '%s' \"$(e'val' payload)\"",
    "python3 - <<'PY'\n# eval explanation\nprint('done')\nPY\neval payload",
    "command eval payload",
    "env X=1 bash -c 'eval payload'",
    "bash -c 'eval payload'",
    "sh <<'SH'\neval payload\nSH",
    "bash <<'SH'\n# introductory comment\neval payload\nSH",
    "printf '%s' \"$(eval payload)\"",
    "printf '%s' \"$(printf '%s' \"$(eval payload)\")\"",
    "cat <(eval payload)",
    "X=$(eval payload)",
    "cat <<'A' <<B\ndata\nA\n# $(eval payload)\nB",
    "bash <<< 'eval payload'",
    "printf x\\ # literal; eval payload"
  ])("refuses actual eval execution: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("eval-untrusted");
  });

  it.each([
    "printf '%s' 'eval payload' | bash -s",
    "printf '%s' 'eval payload' | sh",
    "cat <<'SH' | command sh\neval payload\nSH"
  ])("refuses an opaque shell program from a stream: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("subst-pipe-shell");
  });

  it.each([
    "printf -v 'a[$(eval \"printf proof\")]' '%s' x",
    "printf '%s' 'eval payload",
    "cat <<'SH'\n# eval helper",
    "( # eval helper\nprintf done",
    "{ # eval helper\nprintf done"
  ])("refuses unresolved state or incomplete syntax: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe("shell-analysis");
  });

  it.each([
    "printf '%s' 'eval payload' | unknown_consumer",
    "unknown_consumer 'eval payload'",
    "cat <<SH\n# eval helper\nSH"
  ])("keeps argument and heredoc data distinct from commands: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("allow");
  });

  it.each([
    "printf '%s' 'eval payload' > script; bash script"
  ])("leaves child script content to its separate execution boundary: %s", (command) => {
    const result = validate(command);
    expect(result.decision).toBe("allow");
  });

  it.skipIf(process.platform === "win32").each([
    ["printf '%s' 'eval payload'", "eval payload"],
    ["printf '%s' 'rm -rf /'", "rm -rf /"],
    ["cat <<END\n# eval helper\nEND", "# eval helper\n"],
  ])("matches native data bytes without executing their text: %s", (command, expected) => {
    expect(validate(command).decision).toBe("allow");
    expect(execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd, encoding: "utf8", timeout: 3000 })).toBe(expected);
  });

  it.skipIf(process.platform === "win32")("keeps literal script writes separate from child script execution", () => {
    const command = "printf '%s' \"eval 'printf owned'\" > script; bash script";
    expect(validate(command).decision).toBe("allow");
    expect(isReadOnlyCommand(command)).toBe(false);
    expect(execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd, encoding: "utf8", timeout: 3000 })).toBe("owned");
  });

  it.each(["source ./script", ". ./script"])("refuses opaque loading into the current shell state: %s", command => {
    expect(validate(command).patternId).toBe("shell-analysis");
    expect(validate(command).reason).toContain("unsupported execution-state operation");
  });

  it("preserves warning mode and actual destructive command checks", () => {
    expect(new BashAstValidator({ mode: "warn" }).validate("bash", { command: "eval payload" }).decision).toBe("warn");
    expect(validate("rm -rf /").patternId).toBe("rm-rf-root");
  });
});
