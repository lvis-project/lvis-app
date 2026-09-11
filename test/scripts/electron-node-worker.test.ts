import { expect, it } from "vitest";

// Do not import the normalizer here: the worker must initialize itself before
// loading test code, including modules that choose behavior from these markers.
it("loads the test worker with normalized runtime markers and the packaged ABI", () => {
  expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(process.versions.modules).toMatch(/^\d+$/);
  expect(process.versions.electron).toBeUndefined();
  expect(process.versions.chrome).toBeUndefined();
  const runtime = process as NodeJS.Process & {
    helperExecPath?: string;
    resourcesPath?: string;
  };
  expect(runtime.resourcesPath).toBeUndefined();
  expect(runtime.helperExecPath).toBeUndefined();
});
