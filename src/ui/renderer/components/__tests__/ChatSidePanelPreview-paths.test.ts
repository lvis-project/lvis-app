/**
 * Renderer-side path containment for the side-panel file list.
 *
 * The renderer cannot import the host's `isPathWithin` — that module reaches
 * for `node:path` — so this predicate is a deliberate restatement rather than a
 * copy that drifted. These tests pin the two things the restatement has to get
 * right, both of which the host copy already carries a guard for.
 */
import { describe, it, expect } from "vitest";
import { isPathWithinRoot, toRelativePath } from "../ChatSidePanelPreview.js";

describe("isPathWithinRoot", () => {
  it("accepts a descendant of a root that already ends in a separator", () => {
    // With no guard the segment test lands on the first character of the child
    // name instead of a separator, so `/a/` reported `/a/b` as outside itself.
    // A Windows drive root is exactly this shape, which is where a workspace
    // rooted at `C:\\` would have hit it.
    expect(isPathWithinRoot("/a/", "/a/b")).toBe(true);
    expect(isPathWithinRoot("C:\\", "C:\\work\\file.ts")).toBe(true);
    expect(isPathWithinRoot("/a/", "/a/")).toBe(true);
  });

  it("still refuses a sibling whose name merely extends the root", () => {
    expect(isPathWithinRoot("/a", "/ab")).toBe(false);
    expect(isPathWithinRoot("/a/", "/ab/c")).toBe(false);
    expect(isPathWithinRoot("/srv/data", "/srv/data-evil")).toBe(false);
  });

  it("accepts the root itself and a normal descendant", () => {
    expect(isPathWithinRoot("/a", "/a")).toBe(true);
    expect(isPathWithinRoot("/a", "/a/b/c")).toBe(true);
    expect(isPathWithinRoot("/a", "/a\\b")).toBe(true);
  });
});

describe("toRelativePath", () => {
  it("strips a trailing-separator root without leaving a leading separator", () => {
    expect(toRelativePath("/a/", "/a/b/c.ts")).toBe("b/c.ts");
  });

  it("returns the absolute path when the candidate is not a descendant", () => {
    expect(toRelativePath("/srv/data", "/srv/data-evil/x")).toBe("/srv/data-evil/x");
  });
});
