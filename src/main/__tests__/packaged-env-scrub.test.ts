import { describe, expect, it } from "vitest";
import {
  scrubPackagedProcessEnv,
  shouldScrubPackagedEnvKey,
} from "../packaged-env-scrub.js";

describe("packaged env scrub", () => {
  it("scrubs dev/test flags before packaged preload inheritance", () => {
    const env: NodeJS.ProcessEnv = {
      LVIS_DEV: "1",
      LVIS_DEV_CONSOLE: "1",
      LVIS_E2E: "1",
      LVIS_DEBUG_STREAM: "1",
      VITE_DEBUG_STREAM: "1",
      LVIS_WIN_NO_SANDBOX: "1",
      LVIS_PLUGINS_DIR: "/tmp/plugins",
      LVIS_WHITELIST_OFFLINE: "1",
      LVIS_HOME: "/tmp/lvis-home",
      NODE_ENV: "development",
    };

    const scrubbed = scrubPackagedProcessEnv(env).sort();

    expect(scrubbed).toEqual([
      "LVIS_DEBUG_STREAM",
      "LVIS_DEV",
      "LVIS_DEV_CONSOLE",
      "LVIS_E2E",
      "LVIS_PLUGINS_DIR",
      "LVIS_WHITELIST_OFFLINE",
      "LVIS_WIN_NO_SANDBOX",
      "VITE_DEBUG_STREAM",
    ]);
    expect(env).toEqual({
      LVIS_HOME: "/tmp/lvis-home",
      NODE_ENV: "development",
    });
  });

  it("keeps the packaged scrub predicate aligned with dev-flags SOT", () => {
    expect(shouldScrubPackagedEnvKey("LVIS_DEV_RELOAD")).toBe(true);
    expect(shouldScrubPackagedEnvKey("LVIS_E2E")).toBe(true);
    expect(shouldScrubPackagedEnvKey("LVIS_DEBUG_STREAM")).toBe(true);
    expect(shouldScrubPackagedEnvKey("VITE_DEBUG_STREAM")).toBe(true);
    expect(shouldScrubPackagedEnvKey("LVIS_WHITELIST_OFFLINE")).toBe(true);

    expect(shouldScrubPackagedEnvKey("LVIS_HOME")).toBe(false);
    expect(shouldScrubPackagedEnvKey("OPENAI_API_KEY")).toBe(false);
  });
});
