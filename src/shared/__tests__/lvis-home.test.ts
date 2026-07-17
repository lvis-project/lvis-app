import { afterEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { lvisHome } from "../lvis-home.js";

const originalLvisHome = process.env.LVIS_HOME;

afterEach(() => {
  if (originalLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = originalLvisHome;
});

describe("lvisHome", () => {
  it("resolves a relative LVIS_HOME against the process working directory", () => {
    process.env.LVIS_HOME = join("relative-state", "..", "lvis-state");
    expect(lvisHome()).toBe(resolve("lvis-state"));
  });

  it("normalizes an absolute LVIS_HOME override", () => {
    process.env.LVIS_HOME = join(tmpdir(), "lvis-parent", "..", "lvis-state");
    expect(lvisHome()).toBe(resolve(tmpdir(), "lvis-state"));
  });
});
