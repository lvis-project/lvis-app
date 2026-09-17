import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetForTest, getIsPackaged } from "../boot/dev-flags.js";
import { headlessPackagedMarkerPath } from "../../scripts/lib/headless-packaged-marker.mjs";

const savedEnv = { ...process.env };
let root: string | undefined;

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  _resetForTest();
  vi.resetModules();
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("headless direct entry", () => {
  it("normalizes hostile packaged env before the host module imports", async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-headless-entry-"));
    writeFileSync(headlessPackagedMarkerPath(root), new Uint8Array());
    process.env.NODE_ENV = "test";
    process.env.VITEST = "1";
    process.env.LVIS_DEV = "1";
    process.env.LVIS_WHITELIST_OFFLINE = "1";

    const observed: NodeJS.ProcessEnv[] = [];
    vi.doMock("../main/main-paths.js", () => ({ projectRoot: root }));
    vi.doMock("../headless-host.js", () => {
      observed.push({ ...process.env });
      return {};
    });

    await import("../headless.js");

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ NODE_ENV: "production" });
    expect(observed[0]?.VITEST).toBeUndefined();
    expect(observed[0]?.LVIS_DEV).toBeUndefined();
    expect(observed[0]?.LVIS_WHITELIST_OFFLINE).toBeUndefined();
    expect(getIsPackaged()).toBe(true);
  });
});
