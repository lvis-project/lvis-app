import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readCompressedArtifactFile } from "../marketplace-artifact-limits.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

describe("readCompressedArtifactFile", () => {
  it.runIf(process.platform !== "win32")(
    "rejects a FIFO without blocking while opening an attacker-replaced cache path",
    async () => {
      const tmp = mkdtempSync(join(process.cwd(), ".marketplace-artifact-fifo-"));
      const fifoPath = join(tmp, "artifact.zip");
      try {
        const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf-8" });
        expect(created.status, created.stderr).toBe(0);
        await expect(
          readCompressedArtifactFile(fifoPath, 1024, "cached marketplace artifact"),
        ).rejects.toThrow(/not a regular file/);
      } finally {
        await cleanupTmpDir(tmp);
      }
    },
    2_000,
  );
});
