/**
 * `getDottedFieldValue` — the selection step both path-argument consumers use.
 *
 * Asserted here directly AND through both real consumers, because the contract
 * that matters is "the reviewer and the pipeline select the same values from
 * the same call". Testing only the helper would pass even if a consumer stopped
 * calling it.
 */
import { describe, expect, it } from "vitest";
import { getDottedFieldValue } from "../dotted-field-value.js";
import { extractTargetFilePaths } from "../../tools/pipeline/path-extraction.js";
import type { Tool } from "../../tools/base.js";

function toolWith(pathFields: readonly string[]): Tool {
  return { pathFields } as unknown as Tool;
}

describe("getDottedFieldValue", () => {
  it("walks a dotted path into nested objects", () => {
    expect(getDottedFieldValue({ a: { b: { c: "hit" } } }, "a.b.c")).toBe("hit");
  });

  it("returns the array itself when the field holds one", () => {
    expect(getDottedFieldValue({ files: ["x", "y"] }, "files")).toEqual(["x", "y"]);
  });

  it("refuses to index INTO an array", () => {
    // `files.0` must not resolve, or a tool declaring it would report one path
    // where `files` reports two.
    expect(getDottedFieldValue({ files: ["x", "y"] }, "files.0")).toBeUndefined();
  });

  it("returns undefined for an empty segment rather than the container", () => {
    expect(getDottedFieldValue({ a: { b: "v" } }, "a..b")).toBeUndefined();
    expect(getDottedFieldValue({ a: { b: "v" } }, ".a")).toBeUndefined();
    // The whole-input case: an empty declaration must not select the input.
    expect(getDottedFieldValue({ a: "v" }, "")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is a non-object", () => {
    expect(getDottedFieldValue({ a: "string" }, "a.b")).toBeUndefined();
    expect(getDottedFieldValue({ a: null }, "a.b")).toBeUndefined();
  });

  it("does not reach a prototype-only key through a declared field", () => {
    // A plugin declares `pathFields` in its manifest, so the field NAME is
    // attacker-influenced. A prototype key must not yield a usable string.
    expect(getDottedFieldValue({}, "toString")).toBe(Object.prototype.toString);
    expect(typeof getDottedFieldValue({}, "toString")).not.toBe("string");
  });
});

describe("the pipeline extractor selects through the shared helper", () => {
  const cwd = "/work/project";

  it("enumerates every element of an array-valued path field", () => {
    const paths = extractTargetFilePaths(
      toolWith(["files"]),
      { files: ["/a/one.txt", "/a/two.txt"] },
      cwd,
    );
    expect(paths).toHaveLength(2);
  });

  it("selects a nested path field and drops one that is not reachable", () => {
    const reachable = extractTargetFilePaths(
      toolWith(["target.path"]),
      { target: { path: "/a/one.txt" } },
      cwd,
    );
    expect(reachable).toHaveLength(1);

    const unreachable = extractTargetFilePaths(
      toolWith(["files.0"]),
      { files: ["/a/one.txt"] },
      cwd,
    );
    expect(unreachable).toEqual([]);
  });

  it("selects nothing for an empty-segment declaration", () => {
    expect(
      extractTargetFilePaths(toolWith(["a..b"]), { a: { b: "/a/one.txt" } }, cwd),
    ).toEqual([]);
  });
});
