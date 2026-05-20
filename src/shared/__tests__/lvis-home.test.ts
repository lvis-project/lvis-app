import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { lvisHome } from "../lvis-home.js";

const ORIGINAL_LVIS_HOME = process.env.LVIS_HOME;

function restoreLvisHome(): void {
  if (ORIGINAL_LVIS_HOME === undefined) {
    delete process.env.LVIS_HOME;
  } else {
    process.env.LVIS_HOME = ORIGINAL_LVIS_HOME;
  }
}

afterEach(() => {
  restoreLvisHome();
});

describe("lvisHome", () => {
  it("uses a caller-provided temporary LVIS_HOME path verbatim", () => {
    const tempHome = join(tmpdir(), "lvis-home-override-test");

    process.env.LVIS_HOME = tempHome;

    expect(lvisHome()).toBe(tempHome);
    expect(resolve(lvisHome(), "permissions")).toBe(resolve(tempHome, "permissions"));
  });

  it("supports Windows drive-root overrides such as D:\\LVIS at runtime on Windows", () => {
    // This locks the LVIS data-root contract only. It does not prove or close
    // issue #1039's separate "source checkout on D: + bun run dev" failure.
    const driveHome = "D:\\LVIS\\data";

    process.env.LVIS_HOME = driveHome;

    expect(lvisHome()).toBe(driveHome);
    expect(win32.isAbsolute(lvisHome())).toBe(true);
    expect(win32.resolve(lvisHome(), "permissions")).toBe("D:\\LVIS\\data\\permissions");
  });
});
