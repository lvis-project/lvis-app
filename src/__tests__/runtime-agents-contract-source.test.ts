import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeContract = readFileSync(
  resolve(repoRoot, "resources/AGENTS.md"),
  "utf8",
);

describe("packaged runtime AGENTS.md contract", () => {
  it("stays within the lean prompt budget", () => {
    expect(Buffer.byteLength(runtimeContract, "utf8")).toBeLessThanOrEqual(8_000);
  });

  it("keeps durable runtime sources of truth without stale implementation notes", () => {
    expect(runtimeContract).toContain("# LVIS Runtime Assistant Contract");
    expect(runtimeContract).toContain("~/.lvis/plugins/<pluginId>/data/");
    expect(runtimeContract).toContain("~/.lvis/audit/*.jsonl");
    expect(runtimeContract).toContain("^[a-zA-Z_][a-zA-Z0-9_]*$");
    expect(runtimeContract).toContain("TOOL_TIMEOUT_POLICY");

    expect(runtimeContract).not.toContain("addTask");
    expect(runtimeContract).not.toMatch(/^##\s+(?:\d+\.\s+)?Quick Reference/m);
    expect(runtimeContract).not.toMatch(/^##\s+(?:\d+\.\s+)?Further Reading/m);
    expect(runtimeContract).not.toMatch(/manifest tool category/i);
    expect(runtimeContract).not.toMatch(/\b120_000\b|\b600_000\b/);
    expect(runtimeContract).not.toMatch(/architecture v\d|§\d/i);
  });
});
