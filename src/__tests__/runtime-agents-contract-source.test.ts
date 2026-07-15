import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeContract = readFileSync(
  resolve(process.cwd(), "resources/AGENTS.md"),
  "utf8",
);

describe("packaged runtime AGENTS.md contract", () => {
  it("stays within the lean prompt budget", () => {
    expect(Buffer.byteLength(runtimeContract, "utf8")).toBeLessThanOrEqual(8_000);
  });

  it("keeps durable runtime sources of truth without stale implementation notes", () => {
    expect(runtimeContract).toContain("# LVIS Runtime Assistant Contract");
    expect(runtimeContract).toContain("~/.lvis/AGENTS.md.new");
    expect(runtimeContract).toContain("TOOL_TIMEOUT_POLICY");

    expect(runtimeContract).not.toContain("addTask");
    expect(runtimeContract).not.toContain("## Quick Reference");
    expect(runtimeContract).not.toContain("## Further Reading");
    expect(runtimeContract).not.toMatch(/architecture v\d|§\d/i);
  });
});
