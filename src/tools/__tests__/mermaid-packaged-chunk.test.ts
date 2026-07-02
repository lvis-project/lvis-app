import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #1446 — the packaged-footprint gate must assert the mermaid lazy chunk is a
 * member of app.asar. mermaid's dynamic-import load failure is SILENT
 * (preview-renderers.tsx catch → raw-source fallback), so a launch smoke can
 * never catch a pruned chunk; the build-time asar-membership assertion is the
 * real guard. This test locks that the guard exists and its contenthash regex
 * accepts the emitted chunk name while rejecting the license sidecar / near-miss.
 */
// Anchored to the repo root (vitest cwd) — deterministic regardless of how the
// bundler rewrites import.meta.url.
const scriptPath = resolve(process.cwd(), "scripts/check-package-footprint.mjs");
const scriptSrc = readFileSync(scriptPath, "utf8");

// Keep in lockstep with check-package-footprint.mjs LAZY_RENDERER_CHUNKS.
const MERMAID_CHUNK_RE = /^\/dist\/src\/renderer\/chunks\/mermaid\.[0-9a-f]{8}\.js$/;

describe("packaged footprint mermaid chunk guard", () => {
  it("the footprint script still asserts the lazy mermaid chunk", () => {
    expect(scriptSrc).toContain("LAZY_RENDERER_CHUNKS");
    // The regex escapes its slashes (`renderer\/chunks\/mermaid\.`); assert the
    // chunk name fragment rather than a bare path.
    expect(scriptSrc).toContain("mermaid\\.[0-9a-f]{8}\\.js");
    expect(scriptSrc).toContain("required lazy renderer chunks missing from app.asar");
  });

  it("accepts the emitted contenthash chunk name", () => {
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/mermaid.7fd4e5a9.js")).toBe(true);
  });

  it("rejects the license sidecar and near-misses", () => {
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/mermaid.7fd4e5a9.js.LICENSE.txt")).toBe(false);
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/mermaid.js")).toBe(false);
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/mermaid.7fd4e5a9.js")).toBe(false);
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/other.7fd4e5a9.js")).toBe(false);
  });
});
