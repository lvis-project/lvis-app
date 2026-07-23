import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readCompressedArtifactFile } from "../marketplace-artifact-limits.js";

describe("readCompressedArtifactFile", () => {
  it.runIf(process.platform !== "win32")(
    "rejects a FIFO without blocking while opening an attacker-replaced cache path",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "marketplace-artifact-fifo-"));
      const fifoPath = join(tmp, "artifact.zip");
      try {
        const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf-8" });
        expect(created.status, created.stderr).toBe(0);
        await expect(
          readCompressedArtifactFile(fifoPath, 1024, "cached marketplace artifact"),
        ).rejects.toThrow(/not a regular file/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    2_000,
  );
});
