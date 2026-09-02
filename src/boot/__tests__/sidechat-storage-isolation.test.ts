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
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lvis-sidechat-store-"));
  prevHome = process.env.LVIS_HOME;
  process.env.LVIS_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = prevHome;
  await cleanupTmpDir(home);
});

describe("side-chat storage isolation", () => {
  it("openFeatureNamespace('side-chat') resolves under ~/.lvis/side-chat", () => {
    expect(openFeatureNamespace("side-chat").dir).toBe(join(home, "side-chat"));
  });

  it("side-chat sessions land in side-chat/sessions/, isolated from main sessions/", async () => {
    const mainMm = new MemoryManager({ lvisDir: home });
    const sideMm = new MemoryManager({ lvisDir: openFeatureNamespace("side-chat").dir });

    await mainMm.saveSession("2d2b9e84-a250-4c44-8890-4d620405ff50", [
      { role: "user", content: "main hi" },
      { role: "assistant", content: "main reply" },
    ]);
    await sideMm.saveSession("b4d2673e-eaa1-42fe-874f-fca6c175855d", [
      { role: "user", content: "side hi" },
      { role: "assistant", content: "side reply" },
    ]);

    // The two stores are separate directories.
    expect(existsSync(join(home, "sessions", "2d2b9e84-a250-4c44-8890-4d620405ff50.jsonl"))).toBe(true);
    expect(existsSync(join(home, "side-chat", "sessions", "b4d2673e-eaa1-42fe-874f-fca6c175855d.jsonl"))).toBe(true);

    // Cross-contamination check: main listSessions never sees the side session
    // and vice versa.
    const mainIds = mainMm.listSessions().map((s) => s.id);
    const sideIds = sideMm.listSessions().map((s) => s.id);
    expect(mainIds).toContain("2d2b9e84-a250-4c44-8890-4d620405ff50");
    expect(mainIds).not.toContain("b4d2673e-eaa1-42fe-874f-fca6c175855d");
    expect(sideIds).toContain("b4d2673e-eaa1-42fe-874f-fca6c175855d");
    expect(sideIds).not.toContain("2d2b9e84-a250-4c44-8890-4d620405ff50");
  });

  it("clearing the side-chat namespace leaves the main sessions intact", async () => {
    const mainMm = new MemoryManager({ lvisDir: home });
    const sideMm = new MemoryManager({ lvisDir: openFeatureNamespace("side-chat").dir });
    await mainMm.saveSession("c1a66b9d-085b-4360-8135-241826537b5d", [{ role: "user", content: "x" }]);
    await sideMm.saveSession("612eb9ad-ca7e-4f2a-881d-96ed4b390792", [{ role: "user", content: "y" }]);

    // Domain-unit clear: rm -rf ~/.lvis/side-chat/
    rmSync(join(home, "side-chat"), { recursive: true, force: true });

    expect(existsSync(join(home, "sessions", "c1a66b9d-085b-4360-8135-241826537b5d.jsonl"))).toBe(true);
    expect(existsSync(join(home, "side-chat"))).toBe(false);
  });
});
