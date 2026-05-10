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

  it("allows explicit extra directories but still applies sensitive-path policy", () => {
    withRoot((root) => {
      const outside = realpathSync(tmpdir());
      expect(validateShellCommandPathPolicy(`cat ${outside}/allowed.txt`, root, root, [outside])).toBeNull();
      expect(validateShellCommandPathPolicy(`cat ${outside}/.env`, root, root, [outside])).toContain("Sensitive path:");
    });
  });
});
