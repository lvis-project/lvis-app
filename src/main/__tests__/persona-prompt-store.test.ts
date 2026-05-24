import { afterEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonaPromptStore,
  parsePersonaPromptFrontmatter,
  renderPersonaPromptFile,
} from "../persona-prompt-store.js";

const tempDirs: string[] = [];

function makeStore() {
  const rootDir = mkdtempSync(join(tmpdir(), "persona-prompts-"));
  const userDir = join(rootDir, "prompts");
  mkdirSync(userDir, { recursive: true });
  tempDirs.push(rootDir);
  return { rootDir, userDir, store: new PersonaPromptStore({ userDir }) };
}

describe("PersonaPromptStore", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves, lists, and deletes prompt markdown files", async () => {
    const { store } = makeStore();

    await store.save({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Review carefully.",
    });

    await expect(store.list()).resolves.toMatchObject([
      {
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Review carefully.",
      },
    ]);
    await expect(store.get("reviewer")).resolves.toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Review carefully.",
    });
    await expect(store.delete("reviewer")).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("uses the prompts feature namespace for the default user directory", async () => {
    const prevLvisHome = process.env.LVIS_HOME;
    const rootDir = mkdtempSync(join(tmpdir(), "persona-prompts-home-"));
    tempDirs.push(rootDir);
    process.env.LVIS_HOME = rootDir;
    try {
      const store = new PersonaPromptStore();
      await store.save({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Review carefully.",
      });

      expect(readFileSync(join(rootDir, "prompts", "reviewer.md"), "utf-8")).toContain(
        "Review carefully.",
      );
    } finally {
      if (prevLvisHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = prevLvisHome;
      }
    }
  });

  it("rejects reserved or unsafe ids", async () => {
    const { store } = makeStore();

    await expect(store.save({
      id: "default",
      name: "Default",
      systemPromptAdd: "Override.",
    })).rejects.toThrow("invalid persona prompt id");
    await expect(store.save({
      id: "../escape",
      name: "Escape",
      systemPromptAdd: "Escape.",
    })).rejects.toThrow("invalid persona prompt id");
  });

  it("replaces existing linked prompt path without overwriting the linked target", async () => {
    const { rootDir, userDir, store } = makeStore();
    const externalPath = join(rootDir, "outside.md");
    const promptPath = join(userDir, "reviewer.md");
    writeFileSync(externalPath, "outside original", "utf-8");
    linkSync(externalPath, promptPath);

    await store.save({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Saved prompt body.",
    });

    expect(readFileSync(externalPath, "utf-8")).toBe("outside original");
    expect(readFileSync(promptPath, "utf-8")).toContain("Saved prompt body.");
  });

  it("replaces an existing symlink prompt path without overwriting the symlink target", async () => {
    if (process.platform === "win32") return;
    const { rootDir, userDir, store } = makeStore();
    const externalPath = join(rootDir, "outside.md");
    const promptPath = join(userDir, "reviewer.md");
    writeFileSync(externalPath, "outside original", "utf-8");
    symlinkSync(externalPath, promptPath);

    await store.save({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Saved prompt body.",
    });

    expect(readFileSync(externalPath, "utf-8")).toBe("outside original");
    expect(readFileSync(promptPath, "utf-8")).toContain("Saved prompt body.");
  });

  it("parses and renders frontmatter used by seeded prompts", () => {
    const raw = renderPersonaPromptFile({
      id: "summarizer",
      name: "요약가",
      description: "Summarize",
      systemPromptAdd: "Summarize professionally.",
    });

    expect(parsePersonaPromptFrontmatter(raw)).toEqual({
      fm: { id: "summarizer", name: "요약가", description: "Summarize" },
      body: "Summarize professionally.\n",
    });
  });

  it("ignores invalid markdown prompt entries during list", async () => {
    const { userDir, store } = makeStore();
    writeFileSync(join(userDir, "bad.md"), "---\nid: default\nname: Bad\n---\nBody", "utf-8");

    await expect(store.list()).resolves.toEqual([]);
  });
});
