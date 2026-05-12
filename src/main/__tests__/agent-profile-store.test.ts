import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProfileStore } from "../agent-profile-store.js";

describe("AgentProfileStore", () => {
  it("loads flat markdown agent profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-agents-"));
    try {
      writeFileSync(
        join(dir, "reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews changes\ntools: [web_search, skill_list]\ntriggers: [review]\nmodel: inherit\nmode: subagent\n---\nYou review code without editing.",
        "utf-8",
      );
      const store = new AgentProfileStore({ userDir: dir });
      const agent = await store.load("reviewer");
      expect(agent?.description).toBe("Reviews changes");
      expect(agent?.sourceTools).toEqual(["web_search", "skill_list"]);
      expect(agent?.triggers).toEqual(["review"]);
      expect(agent?.model).toBe("inherit");
      expect(agent?.mode).toBe("subagent");
      expect(agent?.body).toContain("without editing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads directory profiles from <name>/AGENTS.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-agents-"));
    try {
      mkdirSync(join(dir, "explorer"), { recursive: true });
      writeFileSync(
        join(dir, "explorer", "AGENTS.md"),
        "---\nname: explorer\ndescription: Read-only repo lookup\ntools: [agent_list]\n---\nMap files and report evidence.",
        "utf-8",
      );
      const store = new AgentProfileStore({ userDir: dir });
      const agent = await store.load("explorer");
      expect(agent?.description).toBe("Read-only repo lookup");
      expect(agent?.sourceTools).toEqual(["agent_list"]);
      expect(agent?.body).toContain("Map files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
