/**
 * Project AGENTS.md discovery leaf — unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverProjectAgentsMd,
  PROJECT_AGENTS_MD_MAX_TOTAL_BYTES,
} from "../project-agents-md.js";

describe("discoverProjectAgentsMd", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lvis-proj-agents-"));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("(a) returns the layer for <root>/AGENTS.md", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Project rules\nUse tabs.");
    const found = discoverProjectAgentsMd(root);
    expect(found.layers).toHaveLength(1);
    expect(found.layers[0].relativePath).toBe("AGENTS.md");
    expect(found.layers[0].content).toContain("Use tabs.");
    expect(found.layers[0].truncated).toBe(false);
    expect(found.totalBytes).toBeGreaterThan(0);
  });

  it("(b) returns empty layers when the file is absent", () => {
    const found = discoverProjectAgentsMd(root);
    expect(found.layers).toHaveLength(0);
    expect(found.totalBytes).toBe(0);
  });

  it("(c) drops a whitespace-only file", () => {
    writeFileSync(join(root, "AGENTS.md"), "   \n\t\n  ");
    expect(discoverProjectAgentsMd(root).layers).toHaveLength(0);
  });

  it("(d) truncates a file over the byte budget and stays within budget", () => {
    const big = "x".repeat(PROJECT_AGENTS_MD_MAX_TOTAL_BYTES + 5000);
    writeFileSync(join(root, "AGENTS.md"), big);
    const found = discoverProjectAgentsMd(root);
    expect(found.layers).toHaveLength(1);
    expect(found.layers[0].truncated).toBe(true);
    expect(found.totalBytes).toBeLessThanOrEqual(PROJECT_AGENTS_MD_MAX_TOTAL_BYTES);
  });

  it("(e) normalizes CRLF to LF in the returned content", () => {
    writeFileSync(join(root, "AGENTS.md"), "line1\r\nline2\r\n");
    const content = discoverProjectAgentsMd(root).layers[0].content;
    expect(content).not.toContain("\r\n");
    expect(content).toContain("line1\nline2");
  });

  it("(f) skips an AGENTS.md symlink whose realpath escapes the root", () => {
    // Write the real target OUTSIDE the project root.
    const outside = mkdtempSync(join(tmpdir(), "lvis-outside-"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "# secret host file that must not leak");
    let symlinked = false;
    try {
      symlinkSync(secret, join(root, "AGENTS.md"));
      symlinked = true;
    } catch {
      // Windows without privilege can't symlink — skip the assertion there.
    }
    try {
      if (symlinked) {
        const found = discoverProjectAgentsMd(root);
        expect(found.layers).toHaveLength(0); // escaping symlink not read
      }
    } finally {
      try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("(g) treats a directory named AGENTS.md as absent (EISDIR)", () => {
    mkdirSync(join(root, "AGENTS.md"));
    expect(discoverProjectAgentsMd(root).layers).toHaveLength(0);
  });
});
