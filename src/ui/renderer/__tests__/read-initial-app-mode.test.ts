import { describe, it, expect, afterEach } from "vitest";
import { readInitialAppMode } from "../utils/read-initial-app-mode.js";
import { DEFAULT_APP_MODE } from "../../../shared/initial-app-mode.js";

type WindowWithSeed = { __lvisInitialAppMode?: unknown };

afterEach(() => {
  delete (window as WindowWithSeed).__lvisInitialAppMode;
});

describe("readInitialAppMode", () => {
  it("returns the injected 'chat' mode", () => {
    (window as WindowWithSeed).__lvisInitialAppMode = "chat";
    expect(readInitialAppMode()).toBe("chat");
  });

  it("returns the injected 'work' mode", () => {
    (window as WindowWithSeed).__lvisInitialAppMode = "work";
    expect(readInitialAppMode()).toBe("work");
  });

  it("falls back to DEFAULT_APP_MODE when the seed is absent", () => {
    expect(readInitialAppMode()).toBe(DEFAULT_APP_MODE);
  });

  it("falls back to DEFAULT_APP_MODE for an unrecognized seed value", () => {
    (window as WindowWithSeed).__lvisInitialAppMode = "garbage";
    expect(readInitialAppMode()).toBe(DEFAULT_APP_MODE);
  });
});
