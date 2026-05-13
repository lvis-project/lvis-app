import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateShellCommandPathPolicy,
  validateShellWorkingDirectory,
} from "../shell-path-policy.js";

describe("shell-path-policy", () => {
  function withRoot<T>(fn: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), "lvis-shell-policy-"));
    try {
      return fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("allows command operands inside the sandbox after canonicalization", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat ./notes.txt", root, root, [])).toBeNull();
    });
  });

  it("rejects path operands outside the sandbox", () => {
    withRoot((root) => {
      const outside = realpathSync(tmpdir());
      const result = validateShellCommandPathPolicy(`cat ${outside}/lvis-outside.txt`, root, root, []);
      expect(result).toContain("Sandbox:");
    });
  });

  it("rejects sensitive path operands", () => {
    withRoot((root) => {
      const result = validateShellCommandPathPolicy("cat ~/.ssh/id_rsa", root, root, [tmpdir()]);
      expect(result).toContain("Sensitive path:");
    });
  });

  it("rejects unsupported home expansion before shell execution", () => {
    withRoot((root) => {
      const result = validateShellCommandPathPolicy("cat ~someone/.ssh/id_rsa", root, root, []);
      expect(result).toContain("unsupported user-home expansion");
    });
  });

  it("validates shell working directory through the same sandbox path gate", () => {
    withRoot((root) => {
      expect(validateShellWorkingDirectory(root, root, [])).toBeNull();
      expect(validateShellWorkingDirectory(tmpdir(), root, [])).toContain("Sandbox:");
    });
  });

  it("rejects recursive traversal commands even without explicit path operands", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("find . -type f", root, root, [])).toContain("recursive");
    });
  });

  it("rejects recursive grep flags", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("grep -r needle ./src", root, root, [])).toContain("recursive");
    });
  });

  it("rejects combined recursive ls flags", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("ls -laR ./src", root, root, [])).toContain("recursive");
    });
  });

  it("`find` block message points at glob_files / list_files and tells the caller to keep the original target path", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("find /tmp/foo -type f", root, root, ["/tmp/foo"]);
      expect(msg).toContain("find");
      expect(msg).toContain("glob_files");
      expect(msg).toContain("list_files");
      // The "preserve original target path" instruction is the load-bearing fix
      // — stops the LLM from narrowing into a guessed sub-path on retry.
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("`rg` block message points at grep_files and preserves the path", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("rg pattern /tmp/foo", root, root, ["/tmp/foo"]);
      expect(msg).toContain("grep_files");
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("flag-based `grep -r` block message includes the LVIS alternative + preserve-path hint", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("grep -r needle ./src", root, root, []);
      expect(msg).toContain("grep_files");
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("recursive commands without a mapped LVIS alternative still get the preserve-path fallback hint", () => {
    withRoot((root) => {
      const msg = validateShellCommandPathPolicy("ls -R ./src", root, root, []);
      // `ls` has no mapped LVIS alternative (only the explicit flag-set is blocked),
      // so the fallback guidance must still nudge the caller to keep the target path.
      expect(msg).toContain("원래 target path 를 그대로 유지");
    });
  });

  it("rejects PowerShell Join-Path dynamic path composition", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("Join-Path $HOME .ssh", root, root, [])).toContain("dynamic path");
    });
  });

  it("rejects .NET path combine expressions", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("[IO.Path]::Combine($HOME, '.ssh')", root, root, [])).toContain("dynamic path");
    });
  });

  it("rejects unresolved shell variables in path operands", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat $PROJECT_SECRET/file.txt", root, root, [])).toContain("unresolved shell variable");
    });
  });

  it("expands $PWD and accepts operands that stay inside the sandbox", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat $PWD/notes.txt", root, root, [])).toBeNull();
    });
  });

  it("expands %CD% and accepts operands that stay inside the sandbox", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("type %CD%/notes.txt", root, root, [])).toBeNull();
    });
  });

  it("rejects bare sensitive filenames even without a path separator", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("cat .env", root, root, [])).toContain("Sensitive path:");
    });
  });

  it("ignores URL operands instead of treating them as filesystem paths", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("curl https://example.com/a/b", root, root, [])).toBeNull();
    });
  });

  it("ignores /dev/null as a shell null device rather than an approvable path", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("test -e ./missing >/dev/null || echo missing", root, root, [])).toBeNull();
    });
  });

  it("does not treat the shell OR operator as a filesystem root operand", () => {
    withRoot((root) => {
      expect(validateShellCommandPathPolicy("false || echo ok", root, root, [])).toBeNull();
    });
  });

  it("allows explicit extra directories but still applies sensitive-path policy", () => {
    withRoot((root) => {
      const outside = realpathSync(tmpdir());
      expect(validateShellCommandPathPolicy(`cat ${outside}/allowed.txt`, root, root, [outside])).toBeNull();
      expect(validateShellCommandPathPolicy(`cat ${outside}/.env`, root, root, [outside])).toContain("Sensitive path:");
    });
  });
});
