/**
 * `renderApp` must unmount what it renders, even for a suite that imports
 * nothing but the harness.
 *
 * RTL's `afterEach(cleanup)` is registered in exactly one place — `./setup.js`.
 * A suite that renders the whole App without importing it therefore never
 * unmounts: the tree lives until vitest destroys the environment, and any real
 * timer still pending then fires into a window that no longer exists. That is
 * what produced a CI-only `ReferenceError: window is not defined` attributed to
 * whichever file happened to be running at the time.
 *
 * This file deliberately does NOT import `./setup.js`. Its whole point is to
 * stand in for a suite that forgot, so the guarantee has to come from the
 * harness. Deleting the `import "./setup.js"` line in `render-app.tsx` turns the
 * `afterAll` assertion below red.
 *
 * `afterAll` is the observation point on purpose. An `afterEach` here would run
 * BEFORE `cleanup()`, because vitest runs after-hooks in reverse registration
 * order and the harness's hook is registered first — measuring there reports "not
 * unmounted" whether or not the fix is present, which is a check that cannot
 * fail. `afterAll` runs once every `afterEach` has.
 */
import { afterAll, describe, expect, it } from "vitest";

import { renderApp } from "./render-app.js";

afterAll(() => {
  // Nothing rendered by this file may still be in the document.
  expect(document.body.textContent?.trim() ?? "").toBe("");
});

describe("renderApp cleanup contract", () => {
  it("mounts the app for a suite that imports only the harness", async () => {
    await renderApp({ hasApiKey: true });
    // Guards the guard: if the App stopped rendering anything, the `afterAll`
    // assertion would pass for the wrong reason.
    expect(document.body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});
