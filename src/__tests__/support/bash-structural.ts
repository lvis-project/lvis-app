import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { cleanupTmpDir } from "./tmp-dir-teardown.js";

/** Isolated directories and matching interpreter facts for structural/native pairs. */
export function useBashStructuralFixture() {
  const validator = new BashAstValidator();
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "shell-structural-"));
    for (const name of ["work", "work directory", "eval location"]) mkdirSync(join(cwd, name));
  });
  afterEach(async () => { await cleanupTmpDir(cwd); });
  return {
    validator,
    get cwd() { return cwd; },
    validate(command: string) {
      return validator.validate("bash", { command }, {
        cwd, facts: { dialect: "bash", environment: { HOME: cwd, PWD: cwd, PATH: "/usr/bin:/bin" } },
      });
    },
  };
}
