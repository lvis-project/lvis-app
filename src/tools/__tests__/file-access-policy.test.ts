import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFileAccess, sensitiveFilePattern } from "../file-access-policy.js";
import type { ToolExecutionContext } from "../types.js";

let root: string;
let context: ToolExecutionContext;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "file-access-policy-")));
  await mkdir(join(root, "workspace"));
  context = { cwd: join(root, "workspace"), extraAllowedDirectories: [], metadata: {} };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("shared execute-time file gate", () => {
  it("preserves read asymmetry, write confinement, and admitted extra roots", async () => {
    const outside = join(root, "outside.bin");
    await writeFile(outside, "sample");
    expect(ensureFileAccess(outside, context, "read")).toBeNull();
    expect(ensureFileAccess(outside, context, "write")).toMatchObject({ isError: true });
    expect(ensureFileAccess(outside, { ...context, blockReadsOutsideWorkingDirectories: true }, "read")).toMatchObject({ isError: true });
    expect(ensureFileAccess(outside, { ...context, extraAllowedDirectories: [root] }, "write")).toBeNull();
    expect(ensureFileAccess(join(context.cwd, "new.bin"), context, "write")).toBeNull();
  });

  it("retains sensitive-first decisions and exact error text even outside the root", async () => {
    const path = join(root, ".env");
    await writeFile(path, "synthetic-only");
    const sensitive = sensitiveFilePattern(path);
    expect(sensitive).not.toBeNull();
    for (const effect of ["read", "write"] as const) {
      expect(ensureFileAccess(path, context, effect)).toEqual({ output: `Sensitive path: ${path} matches ${sensitive}`, isError: true });
    }
  });

  it("reuses canonical ancestor and sensitive-target policy", async () => {
    const alias = join(root, "alias");
    await symlink(context.cwd, alias);
    expect(ensureFileAccess(join(alias, "new.bin"), context, "write")).toBeNull();
    const sensitive = join(context.cwd, ".env");
    await writeFile(sensitive, "synthetic-only");
    await symlink(sensitive, join(context.cwd, "ordinary"));
    expect(ensureFileAccess(join(context.cwd, "ordinary"), context, "read")?.output).toContain("Sensitive path:");
  });
});
