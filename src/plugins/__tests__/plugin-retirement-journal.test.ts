import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRetirementJournal } from "../plugin-retirement-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginRetirementJournal", () => {
  it("persists exact generation attempts and removes completed work", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-retirement-journal-"));
    roots.push(root);
    const path = join(root, "journal.json");
    const generationId = "a".repeat(64);
    const journal = new PluginRetirementJournal(path);
    journal.record("ep-api", generationId, new Error("disconnect failed"));

    const reloaded = new PluginRetirementJournal(path);
    expect(reloaded.list()).toEqual([
      expect.objectContaining({
        pluginId: "ep-api",
        generationId,
        attempts: 1,
        lastError: "disconnect failed",
      }),
    ]);

    reloaded.complete("ep-api", generationId);
    expect(JSON.parse(await readFile(path, "utf8")).retirements).toEqual([]);
  });
});
