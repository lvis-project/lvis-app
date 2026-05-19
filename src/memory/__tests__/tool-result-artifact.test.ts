import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryManager } from "../memory-manager.js";

const SESSION_ID = "artifact-session-0001";
const TRUNCATED = {
  originalLines: 240,
  originalTokens: 12_345,
  originalBytes: 54_321,
  trimmedAt: "2026-05-19T00:00:00.000Z",
};

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-tool-result-artifact-"));
  mm = new MemoryManager({ lvisDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function artifactMessage(content: string) {
  return {
    role: "tool_result" as const,
    toolUseId: "toolu_artifact_1",
    toolName: "lge_lgenie_query",
    content,
    meta: {
      truncated: TRUNCATED,
    },
  };
}

function artifactDir(): string {
  return join(dir, "sessions", SESSION_ID, "tool-results");
}

describe("MemoryManager file-backed tool_result artifacts", () => {
  it("saves oversized tool_result content as a JSONL stub plus artifact", async () => {
    const raw = Array.from({ length: 150 }, (_, i) => `row ${i}: ${"x".repeat(80)}`).join("\n");

    await mm.saveSession(SESSION_ID, [artifactMessage(raw)]);

    const jsonl = readFileSync(join(dir, "sessions", `${SESSION_ID}.jsonl`), "utf-8");
    expect(jsonl).toContain("[tool_result truncated by host");
    expect(jsonl).toContain("read_tool_result_chunk");
    expect(jsonl).not.toContain(raw.slice(0, 120));

    const entries = readdirSync(artifactDir()).sort();
    expect(entries.filter((entry) => entry.endsWith(".txt"))).toHaveLength(1);
    expect(entries.filter((entry) => entry.endsWith(".json"))).toHaveLength(1);

    const artifact = mm.loadToolResultArtifact(SESSION_ID, "toolu_artifact_1");
    expect(artifact).toMatchObject({
      toolUseId: "toolu_artifact_1",
      toolName: "lge_lgenie_query",
      content: raw,
      truncated: TRUNCATED,
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    });
  });

  it("keeps artifact content available across stub-only session rewrites", async () => {
    const raw = "large result\n".repeat(160);
    await mm.saveSession(SESSION_ID, [artifactMessage(raw)]);

    const loaded = mm.loadSession(SESSION_ID);
    expect(loaded).not.toBeNull();
    await mm.saveSession(SESSION_ID, loaded!);

    const artifact = mm.loadToolResultArtifact(SESSION_ID, "toolu_artifact_1");
    expect(artifact?.content).toBe(raw);
    expect(mm.loadSession(SESSION_ID)?.[0]).toMatchObject({
      role: "tool_result",
      toolUseId: "toolu_artifact_1",
      meta: {
        truncated: TRUNCATED,
        serializedStub: true,
      },
    });
  });

  it("preserves compacted stub precedence while retaining its artifact", async () => {
    const raw = "compacted artifact result\n".repeat(160);
    await mm.saveSession(SESSION_ID, [{
      ...artifactMessage(raw),
      meta: {
        compactedAt: "2026-05-19T00:00:00.000Z",
        truncated: TRUNCATED,
      },
    }]);

    expect(mm.loadSession(SESSION_ID)?.[0]).toMatchObject({
      role: "tool_result",
      content: expect.stringContaining("[tool_result stripped"),
    });

    const loaded = mm.loadSession(SESSION_ID);
    expect(loaded).not.toBeNull();
    await mm.saveSession(SESSION_ID, loaded!);

    const resaved = mm.loadSession(SESSION_ID)?.[0] as { content?: string } | undefined;
    expect(resaved?.content).toContain("[tool_result stripped");
    expect(resaved?.content).not.toContain("[tool_result truncated by host");
    expect(mm.loadToolResultArtifact(SESSION_ID, "toolu_artifact_1")?.content).toBe(raw);
  });

  it("keeps checkpoint artifact content after the main session is compacted away", async () => {
    const raw = "checkpoint result\n".repeat(180);
    await mm.saveCheckpointSnapshot(SESSION_ID, 1, [
      { role: "assistant", content: "calling", toolCalls: [{ id: "toolu_artifact_1", name: "lge_lgenie_query", input: {} }] },
      artifactMessage(raw),
    ]);
    await mm.saveSession(SESSION_ID, [{ role: "assistant", content: "compact summary only" }]);

    const artifact = mm.loadToolResultArtifact(SESSION_ID, "toolu_artifact_1");
    expect(artifact?.content).toBe(raw);
    expect(mm.loadCheckpointSnapshot(SESSION_ID, 1)?.[1]).toMatchObject({
      role: "tool_result",
      content: expect.stringContaining("[tool_result truncated by host"),
    });
  });

  it("removes artifact files once no session or checkpoint references them", async () => {
    await mm.saveSession(SESSION_ID, [artifactMessage("orphan soon\n".repeat(150))]);
    expect(existsSync(artifactDir())).toBe(true);

    await mm.saveSession(SESSION_ID, [{ role: "assistant", content: "no tool results" }]);

    expect(readdirSync(artifactDir())).toEqual([]);
  });
});
