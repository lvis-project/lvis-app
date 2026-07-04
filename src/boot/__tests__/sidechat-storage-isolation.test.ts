/**
 * Side-chat storage isolation — sessions persist to `~/.lvis/side-chat/`, a
 * DISTINCT domain namespace from the main chat's `~/.lvis/sessions/`, so a
 * side-chat session never appears in the main chat's session list and the
 * domain can be cleared as a unit (project CLAUDE.md storage-namespace rule).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../memory/memory-manager.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lvis-sidechat-store-"));
  prevHome = process.env.LVIS_HOME;
  process.env.LVIS_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("side-chat storage isolation", () => {
  it("openFeatureNamespace('side-chat') resolves under ~/.lvis/side-chat", () => {
    expect(openFeatureNamespace("side-chat").dir).toBe(join(home, "side-chat"));
  });

  it("side-chat sessions land in side-chat/sessions/, isolated from main sessions/", async () => {
    const mainMm = new MemoryManager({ lvisDir: home });
    const sideMm = new MemoryManager({ lvisDir: openFeatureNamespace("side-chat").dir });

    await mainMm.saveSession("main-session", [
      { role: "user", content: "main hi" },
      { role: "assistant", content: "main reply" },
    ]);
    await sideMm.saveSession("side-session", [
      { role: "user", content: "side hi" },
      { role: "assistant", content: "side reply" },
    ]);

    // The two stores are separate directories.
    expect(existsSync(join(home, "sessions", "main-session.jsonl"))).toBe(true);
    expect(existsSync(join(home, "side-chat", "sessions", "side-session.jsonl"))).toBe(true);

    // Cross-contamination check: main listSessions never sees the side session
    // and vice versa.
    const mainIds = mainMm.listSessions().map((s) => s.id);
    const sideIds = sideMm.listSessions().map((s) => s.id);
    expect(mainIds).toContain("main-session");
    expect(mainIds).not.toContain("side-session");
    expect(sideIds).toContain("side-session");
    expect(sideIds).not.toContain("main-session");
  });

  it("clearing the side-chat namespace leaves the main sessions intact", async () => {
    const mainMm = new MemoryManager({ lvisDir: home });
    const sideMm = new MemoryManager({ lvisDir: openFeatureNamespace("side-chat").dir });
    await mainMm.saveSession("keep-me", [{ role: "user", content: "x" }]);
    await sideMm.saveSession("drop-me", [{ role: "user", content: "y" }]);

    // Domain-unit clear: rm -rf ~/.lvis/side-chat/
    rmSync(join(home, "side-chat"), { recursive: true, force: true });

    expect(existsSync(join(home, "sessions", "keep-me.jsonl"))).toBe(true);
    expect(existsSync(join(home, "side-chat"))).toBe(false);
  });
});
