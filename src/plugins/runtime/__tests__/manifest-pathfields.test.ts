/**
 * Q12 Phase 2.5 — `toolSchemas[*].pathFields` advisory hint tests.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 0
 * (pathFields[] declaration). Phase 2.5 is advisory — log.warn only;
 * Phase 4 will enforce.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginJson } from "../manifest-validation.js";

function writeManifest(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-pathfields-"));
  const path = join(dir, "plugin.json");
  writeFileSync(path, JSON.stringify(content), "utf-8");
  return path;
}

const baseManifest = {
  id: "com.lge.test-pathfields",
  name: "Test PathFields",
  version: "1.0.0",
  description: "test",
  publisher: "LGE",
  entry: "dist/index.js",
  tools: ["read_doc"],
};

describe("toolSchemas[*].pathFields advisory hint", () => {
  it("manifest with valid pathFields[] referring to declared inputSchema props parses cleanly", async () => {
    const path = writeManifest({
      ...baseManifest,
      toolSchemas: {
        read_doc: {
          description: "Read a document",
          category: "read",
          pathFields: ["docPath"],
          inputSchema: {
            type: "object",
            properties: { docPath: { type: "string" } },
          },
        },
      },
    });
    const parsed = await parsePluginJson(path, null);
    expect(parsed.toolSchemas?.read_doc.pathFields).toEqual(["docPath"]);
  });

  it("warns when pathFields entry references a non-declared property", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = writeManifest({
        ...baseManifest,
        toolSchemas: {
          read_doc: {
            description: "Read a document",
            category: "read",
            pathFields: ["bogusField"],
            inputSchema: {
              type: "object",
              properties: { docPath: { type: "string" } },
            },
          },
        },
      });
      const parsed = await parsePluginJson(path, null);
      // Soft-warn — parse succeeds.
      expect(parsed.toolSchemas?.read_doc.pathFields).toEqual(["bogusField"]);
      const msg = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(msg).toMatch(/pathFields\[0\]='bogusField'/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when pathFields is not an array", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = writeManifest({
        ...baseManifest,
        toolSchemas: {
          read_doc: {
            description: "Read a document",
            category: "read",
            pathFields: "not-an-array",
            inputSchema: {
              type: "object",
              properties: { docPath: { type: "string" } },
            },
          },
        },
      });
      // Parse still succeeds — soft warn.
      const parsed = await parsePluginJson(path, null);
      expect(parsed.id).toBe(baseManifest.id);
      const msg = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(msg).toMatch(/pathFields must be an array/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ignores empty pathFields array (no-op)", async () => {
    const path = writeManifest({
      ...baseManifest,
      toolSchemas: {
        read_doc: {
          description: "Read a document",
          category: "read",
          pathFields: [],
          inputSchema: { type: "object", properties: {} },
        },
      },
    });
    const parsed = await parsePluginJson(path, null);
    expect(parsed.toolSchemas?.read_doc.pathFields).toEqual([]);
  });
});
